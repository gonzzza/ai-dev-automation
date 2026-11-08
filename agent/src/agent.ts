import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createChecksServer } from "./checks.js";
import type { Exec } from "./exec.js";
import { AGENT_TOOLS, CHECKS_TOOL, createToolPolicy } from "./policy.js";
import type { Spec } from "./spec.js";

export const AgentReportSchema = z.object({
  plan: z.array(z.string()).describe("The steps you planned, in order, one short sentence each."),
  summary: z.string().describe("What you built and the main design decisions, 2-5 sentences, for the PR description."),
  testing: z.string().describe("Which tests you added and what they cover."),
  checksPassed: z.boolean().describe("Whether the last run_checks call returned PASSED."),
  notes: z.string().describe("Anything the reviewer should know: assumptions, spec ambiguities, follow-ups. Empty if none."),
});
export type AgentReport = z.infer<typeof AgentReportSchema>;

export interface AgentConfig {
  repoRoot: string;
  writableDirs: string[];
  model: string;
  effort: NonNullable<Options["effort"]>;
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface AgentRun {
  report: AgentReport;
  costUsd: number;
  turns: number;
  durationMs: number;
}

export function buildPrompt(spec: Spec, writableDirs: string[]): string {
  return `Implement the feature spec below in this repository.

Work like this:
1. Read CLAUDE.md and the existing code in ${writableDirs.join(", ")} to learn the conventions.
2. Plan the change before editing.
3. Implement it with Vitest tests that cover every acceptance criterion. Keep the change focused on the spec.
4. Call the run_checks tool. If it fails, fix the problem and call it again, until it passes.

Rules:
- Only create or edit files under: ${writableDirs.join(", ")}. Writes elsewhere are denied.
- You have no shell. run_checks is the only way to lint, typecheck and run tests.
- Do not commit, branch or push. The harness handles git and opens the PR after you finish.
- If the spec is ambiguous, choose the simplest reasonable interpretation and record it in notes.

<spec path="${spec.path}">
${spec.body}
</spec>`;
}

/** One line per notable event, so a human watching the terminal can follow along. */
export function describeMessage(message: SDKMessage): string | undefined {
  if (message.type !== "assistant") return undefined;
  const lines: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      const target = input.file_path ?? input.pattern ?? input.path ?? "";
      lines.push(`  → ${block.name.replace("mcp__repo__", "")} ${String(target)}`.trimEnd());
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}

export async function runAgent(
  spec: Spec,
  config: AgentConfig,
  exec: Exec,
  log: (line: string) => void = console.log,
): Promise<AgentRun> {
  const options: Options = {
    cwd: config.repoRoot,
    model: config.model,
    effort: config.effort,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    // Load the repo's CLAUDE.md for conventions; skip user and local settings so runs are reproducible.
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: AGENT_TOOLS,
    mcpServers: { repo: createChecksServer(exec, config.repoRoot) },
    // Every call that isn't pre-approved goes through the policy; nothing is pre-approved.
    permissionMode: "default",
    canUseTool: createToolPolicy({ repoRoot: config.repoRoot, writableDirs: config.writableDirs }),
    outputFormat: { type: "json_schema", schema: z.toJSONSchema(AgentReportSchema) as Record<string, unknown> },
    persistSession: false,
  };

  for await (const message of query({ prompt: buildPrompt(spec, config.writableDirs), options })) {
    const line = describeMessage(message);
    if (line) log(line);

    if (message.type === "result") {
      if (message.subtype !== "success" || message.is_error) {
        const reason = message.subtype === "success" ? message.result : message.subtype;
        throw new Error(`Agent stopped without finishing: ${reason} (cost $${message.total_cost_usd.toFixed(2)}).`);
      }
      const report = AgentReportSchema.safeParse(message.structured_output);
      if (!report.success) throw new Error(`Agent report did not match the schema: ${report.error.message}`);
      return { report: report.data, costUsd: message.total_cost_usd, turns: message.num_turns, durationMs: message.duration_ms };
    }
  }
  throw new Error("Agent session ended without a result.");
}

export { CHECKS_TOOL };
