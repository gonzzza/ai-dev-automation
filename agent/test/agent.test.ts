import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join, resolve } from "node:path";
import type { Standard } from "standards";
import { describe, expect, it } from "vitest";
import {
  AGENT_REPORT_JSON_SCHEMA,
  AgentReportSchema,
  agentOptions,
  buildPrompt,
  describeMessage,
  loadPromptTemplate,
  type AgentConfig,
} from "../src/agent.js";
import type { Exec } from "../src/exec.js";
import type { RunEvent } from "../src/runlog.js";
import { standardsPrompt } from "../src/standards.js";
import { parseSpec } from "../src/spec.js";

const spec = parseSpec("specs/002-x.md", "# X\n\n## Goal\ng\n\n## Requirements\nr\n\n## Acceptance criteria\n- AC1: a\n");

describe("buildPrompt", () => {
  it("fills prompt.md with the spec and states scope, tools and git rules", async () => {
    const prompt = buildPrompt(await loadPromptTemplate(), spec, ["demo-app", "specs"]);
    expect(prompt).toContain('<spec path="specs/002-x.md">\n# X');
    expect(prompt).toContain("Only create or edit files under: demo-app, specs");
    expect(prompt).toContain("You have no shell");
    expect(prompt).toContain("Do not commit");
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(prompt.endsWith("</spec>")).toBe(true);
  });

  it("does not expand placeholder-like text or $ patterns inside the spec", () => {
    const tricky = { ...spec, body: "use {{writableDirs}} and $& literally" };
    expect(buildPrompt("<spec>{{specBody}}</spec>", tricky, ["demo-app"])).toBe(
      "<spec>use {{writableDirs}} and $& literally</spec>",
    );
  });

  it("rejects unknown placeholders in the template", () => {
    expect(() => buildPrompt("Hi {{nope}}", spec, ["demo-app"])).toThrow("Unknown placeholder {{nope}}");
  });
});

describe("describeMessage", () => {
  it("summarizes tool calls and ignores other messages", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the code." },
          { type: "tool_use", id: "1", name: "Read", input: { file_path: "demo-app/src/retry.ts" } },
          { type: "tool_use", id: "2", name: "mcp__repo__run_checks", input: {} },
        ],
      },
    } as unknown as SDKMessage;
    expect(describeMessage(message)).toBe("  → Read demo-app/src/retry.ts\n  → run_checks");
    expect(describeMessage({ type: "system" } as unknown as SDKMessage)).toBeUndefined();
  });

  it("shows absolute paths relative to the repo root", () => {
    const root = resolve("repo");
    const message = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "1", name: "Write", input: { file_path: join(root, "demo-app", "src", "a.ts") } }] },
    } as unknown as SDKMessage;
    expect(describeMessage(message, root)).toBe("  → Write demo-app/src/a.ts");
  });
});

describe("AGENT_REPORT_JSON_SCHEMA", () => {
  it("is draft-07, which the Claude Code CLI accepts, and requires every report field", () => {
    expect(AGENT_REPORT_JSON_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(AGENT_REPORT_JSON_SCHEMA.required).toEqual(["plan", "summary", "testing", "checksPassed", "notes"]);
  });
});

describe("agentOptions", () => {
  const repoRoot = resolve("/repo");
  const exec: Exec = async () => {
    throw new Error("agentOptions must not run anything");
  };
  const standard: Standard = {
    id: "TS-002",
    title: "Inject clocks and timers",
    severity: "medium",
    appliesTo: ["**/src/**/*.ts"],
    use: ["agent", "review"],
    pack: "typescript",
    path: "org-standards/typescript/ts-002.md",
    body: "Take `now` and `sleep` as options.",
  };
  const task = { prompt: "Implement the spec.", schema: AgentReportSchema };
  const configWith = (over: Partial<AgentConfig> = {}): AgentConfig => ({
    repoRoot,
    writableDirs: ["demo-app"],
    model: "claude-opus-5-5",
    effort: "high",
    maxTurns: 60,
    maxBudgetUsd: 5,
    ...over,
  });

  it("AC5: appends the org standards to the system prompt only when the config has some", () => {
    expect(agentOptions(task, configWith(), exec).systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(agentOptions(task, configWith({ standards: [] }), exec).systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(agentOptions(task, configWith({ standards: [standard] }), exec).systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: standardsPrompt([standard]),
    });
  });

  it("attaches the write policy as canUseTool and as a PreToolUse hook that logs denials", async () => {
    const events: RunEvent[] = [];
    const options = agentOptions(task, configWith({ runLog: { runId: "r", event: (e) => void events.push(e) } }), exec);
    expect(options.permissionMode).toBe("default");
    expect(options.settingSources).toEqual(["project"]);

    const outside = { file_path: join(repoRoot, "agent", "src", "policy.ts"), content: "x" };
    const signal = new AbortController().signal;
    const viaCanUseTool = await options.canUseTool!("Write", outside, { signal, suggestions: [], toolUseID: "1" } as never);
    expect(viaCanUseTool).toMatchObject({ behavior: "deny" });

    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const input = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: outside, tool_use_id: "1" } as unknown as HookInput;
    const viaHook = await hook(input, "1", { signal });
    expect(viaHook).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(events).toContainEqual(expect.objectContaining({ type: "policy.decision", tool: "Write", behavior: "deny" }));
  });
});
