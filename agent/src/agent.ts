import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createChecksServer, type Sandbox } from "./checks.js";
import type { Exec } from "./exec.js";
import type { RunLog } from "./runlog.js";
import { AGENT_TOOLS, CHECKS_TOOL, createPolicyHook, createToolPolicy } from "./policy.js";
import type { Spec } from "./spec.js";
import { systemPromptOption } from "./standards.js";
import type { Standard } from "standards";

export const AgentReportSchema = z.object({
  plan: z.array(z.string()).describe("The steps you planned, in order, one short sentence each."),
  summary: z.string().describe("What you built and the main design decisions, 2-5 sentences, for the PR description."),
  testing: z.string().describe("Which tests you added and what they cover."),
  checksPassed: z.boolean().describe("Whether the last run_checks call returned PASSED."),
  notes: z.string().describe("Anything the reviewer should know: assumptions, spec ambiguities, follow-ups. Empty if none."),
});
export type AgentReport = z.infer<typeof AgentReportSchema>;

/** Draft-07, because the Claude Code CLI validates --json-schema with a draft-07 validator and rejects 2020-12. */
export const AGENT_REPORT_JSON_SCHEMA = z.toJSONSchema(AgentReportSchema, { target: "draft-7" }) as Record<string, unknown>;

export interface AgentConfig {
  repoRoot: string;
  writableDirs: string[];
  model: string;
  effort: NonNullable<Options["effort"]>;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Environment for run_checks, without credentials. */
  checksEnv?: NodeJS.ProcessEnv;
  /** Where run_checks executes the agent's code. Default: directly, with checksEnv. */
  sandbox?: Sandbox;
  /** Audit log: every SDK message (the transcript) and every policy decision. */
  runLog?: RunLog;
  /** Org standards, appended to the system prompt. Trusted operator input, unlike the spec and findings. */
  standards?: Standard[];
}

export interface AgentRun<Report = AgentReport> {
  report: Report;
  costUsd: number;
  turns: number;
  durationMs: number;
}

/** The agent's instructions live in agent/prompt.md so they can be edited as prose; guardrails stay in code. */
export const PROMPT_FILE = fileURLToPath(new URL("../prompt.md", import.meta.url));

export async function loadPromptTemplate(path: string = PROMPT_FILE): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * Fills the {{placeholders}} in a prompt template. One pass, so placeholder-like text inside the
 * values is never expanded, and an unknown placeholder is an error rather than a silent gap in the prompt.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.trimEnd().replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Unknown placeholder ${match} in the prompt template.`);
    return value;
  });
}

export function buildPrompt(template: string, spec: Spec, writableDirs: string[]): string {
  return fillTemplate(template, { writableDirs: writableDirs.join(", "), specPath: spec.path, specBody: spec.body });
}

/** What one agent session is asked to do, and the shape of the report it must return. */
export interface AgentTask<Report> {
  prompt: string;
  schema: z.ZodType<Report>;
}

/** The implement-a-spec task, from agent/prompt.md. */
export async function specTask(spec: Spec, writableDirs: string[]): Promise<AgentTask<AgentReport>> {
  return { prompt: buildPrompt(await loadPromptTemplate(), spec, writableDirs), schema: AgentReportSchema };
}

/** One line per notable event, so a human watching the terminal can follow along. */
export function describeMessage(message: SDKMessage, repoRoot?: string): string | undefined {
  if (message.type !== "assistant") return undefined;
  const lines: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      let target = String(input.file_path ?? input.pattern ?? input.path ?? "");
      if (repoRoot && isAbsolute(target)) target = relative(repoRoot, target).replace(/\\/g, "/");
      lines.push(`  → ${block.name.replace("mcp__repo__", "")} ${target}`.trimEnd());
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}

export async function runAgent<Report>(
  task: AgentTask<Report>,
  config: AgentConfig,
  exec: Exec,
  log: (line: string) => void = console.log,
): Promise<AgentRun<Report>> {
  const policy = { repoRoot: config.repoRoot, writableDirs: config.writableDirs };
  const options: Options = {
    cwd: config.repoRoot,
    model: config.model,
    effort: config.effort,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    // Load the repo's CLAUDE.md for conventions; skip user and local settings so runs are reproducible.
    settingSources: ["project"],
    // The standards come from the operator and are trusted, so they go in the system prompt. The
    // spec body and findings stay in the user prompt, as untrusted input.
    systemPrompt: systemPromptOption(config.standards ?? []),
    tools: AGENT_TOOLS,
    mcpServers: { repo: createChecksServer(exec, config.repoRoot, config.checksEnv, config.sandbox) },
    // The policy runs as a PreToolUse hook, which sees every tool call, and again as canUseTool for
    // anything Claude Code would otherwise prompt for. Nothing is pre-approved.
    permissionMode: "default",
    hooks: {
      PreToolUse: [
        {
          hooks: [
            createPolicyHook(policy, (tool, result) =>
              // Denials are security events: a spec or finding may be trying to steer the agent.
              config.runLog?.event({ type: "policy.decision", tool, behavior: result.behavior, ...(result.behavior === "deny" ? { reason: result.message } : {}) }),
            ),
          ],
        },
      ],
    },
    canUseTool: createToolPolicy(policy),
    outputFormat: { type: "json_schema", schema: z.toJSONSchema(task.schema, { target: "draft-7" }) as Record<string, unknown> },
    persistSession: false,
  };

  config.runLog?.event({ type: "agent.start", model: config.model, effort: config.effort, maxTurns: config.maxTurns, maxBudgetUsd: config.maxBudgetUsd, prompt: task.prompt });
  for await (const message of query({ prompt: task.prompt, options })) {
    config.runLog?.event({ type: "sdk.message", message });
    const line = describeMessage(message, config.repoRoot);
    if (line) log(line);

    if (message.type === "result") {
      config.runLog?.event({
        type: "agent.end",
        subtype: message.subtype,
        costUsd: message.total_cost_usd,
        turns: message.num_turns,
        durationMs: message.duration_ms,
      });
      if (message.subtype !== "success" || message.is_error) {
        const reason = message.subtype === "success" ? message.result : message.subtype;
        throw new Error(`Agent stopped without finishing: ${reason} (cost $${message.total_cost_usd.toFixed(2)}).`);
      }
      const report = task.schema.safeParse(message.structured_output);
      if (!report.success) throw new Error(`Agent report did not match the schema: ${report.error.message}`);
      return { report: report.data, costUsd: message.total_cost_usd, turns: message.num_turns, durationMs: message.duration_ms };
    }
  }
  throw new Error("Agent session ended without a result.");
}

export { CHECKS_TOOL };
