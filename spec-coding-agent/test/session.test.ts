import { describe, expect, it, vi } from "vitest";
import { AGENT_REPORT_JSON_SCHEMA, AgentReportSchema, type AgentReport, type AgentTask } from "../src/agent.js";
import type { RunEvent, RunLog } from "../src/runlog.js";
import { classifyFailure } from "../src/runlog.js";
import { runSession, sessionEnv, type SessionConfig, type SessionResult, type SessionSpawn } from "../src/session.js";

const report: AgentReport = { plan: ["Read the code", "Write it"], summary: "Adds x.", testing: "Unit tests.", checksPassed: true, notes: "", sections: [] };
const task: AgentTask<AgentReport> = { prompt: "Implement the spec.", schema: AgentReportSchema };
const config: SessionConfig = {
  repoRoot: "/repo",
  writableDirs: ["demo-app", "specs"],
  model: "claude-opus-5-5",
  effort: "high",
  maxBudgetUsd: 5,
  maxMinutes: 60,
  env: { PATH: "/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "sk-ant-key", ANTHROPIC_AUTH_TOKEN: "token" },
};

const success = { type: "result", subtype: "success", is_error: false, num_turns: 12, duration_ms: 90_000, total_cost_usd: 1.5, structured_output: report };
const answer = (result: Partial<SessionResult> & { json?: unknown }): SessionSpawn =>
  vi.fn(async () => ({ code: 0, stderr: "", timedOut: false, stdout: JSON.stringify(result.json ?? success), ...result }));

function memoryLog(): RunLog & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { runId: "test", events, event: (e) => void events.push(e) };
}

describe("runSession", () => {
  it("AC8: runs claude with exactly the session arguments, in the repo root, the prompt on stdin", async () => {
    const spawn = answer({});
    await runSession(task, config, spawn);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(AGENT_REPORT_JSON_SCHEMA),
      "--permission-mode", "dontAsk",
      "--setting-sources", "project",
      "--no-session-persistence",
      "--model", "claude-opus-5-5",
      "--effort", "high",
      "--max-budget-usd", "5",
      "--allowedTools", "Read", "Glob", "Grep", "Bash(npm run check)",
      "Edit(./demo-app/**)", "Write(./demo-app/**)", "Edit(./specs/**)", "Write(./specs/**)",
      "--disallowedTools",
      "Read(**/.env)", "Read(**/.env.*)", "Read(**/CLAUDE.local.md)", "Read(**/.npmrc)",
      "Read(**/*.pem)", "Read(**/*.key)", "Read(**/*.p12)", "Read(**/*.pfx)",
      "Bash(git *)", "Bash(gh *)", "WebFetch", "WebSearch",
    ]);
    expect(args).not.toContain("--bare");
    expect(options).toMatchObject({ cwd: "/repo", input: "Implement the spec.", timeoutMs: 60 * 60_000 });
  });

  it("AC8: runs without the API key variables, so the session uses Claude Code's signed-in account", async () => {
    const spawn = answer({});
    await runSession(task, config, spawn);
    const { env } = vi.mocked(spawn).mock.calls[0]![2];
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me" });
    expect(sessionEnv({ A: "1", ANTHROPIC_API_KEY: "x" })).toEqual({ A: "1" });
  });

  it("AC8: turns a successful result into an AgentRun, and logs the session and its totals", async () => {
    const runLog = memoryLog();
    const run = await runSession(task, { ...config, runLog }, answer({}));
    expect(run).toEqual({ report, turns: 12, durationMs: 90_000, costUsd: 1.5 });
    expect(runLog.events.map((e) => e.type)).toEqual(["session.start", "session.end", "agent.end"]);
    expect(runLog.events[0]).toMatchObject({ command: expect.arrayContaining(["claude", "-p"]), prompt: "Implement the spec." });
    expect(runLog.events[2]).toMatchObject({ costUsd: 1.5, turns: 12 });
  });

  it.each([
    ["is_error", { ...success, is_error: true, result: "API Error: 529" }, "API Error: 529"],
    ["a non-success subtype", { ...success, subtype: "error_max_budget_usd" }, "error_max_budget_usd"],
  ])("AC8: throws the agent-stopped message for %s", async (_case, json, reason) => {
    const error = (await runSession(task, config, answer({ json })).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(`Agent stopped without finishing: ${reason}.`);
    expect(classifyFailure(error.message)).toBe("agent-stopped");
  });

  it("AC8: throws the agent-stopped message on a timeout, after the spawn killed the session", async () => {
    const error = (await runSession(task, { ...config, maxMinutes: 30 }, answer({ timedOut: true, code: 1, stdout: "" })).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("Agent stopped without finishing: timed out after 30 minutes.");
    expect(classifyFailure(error.message)).toBe("agent-stopped");
  });

  it("AC8: throws the agent-stopped message when claude prints no JSON, with its error output", async () => {
    const error = (await runSession(task, config, answer({ code: 1, stdout: "", stderr: "Not logged in" })).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^Agent stopped without finishing: claude exited 1 without a JSON result\.\nNot logged in/);
  });

  it.each([
    ["missing", { ...success, structured_output: undefined }],
    ["invalid", { ...success, structured_output: { plan: "not a list" } }],
  ])("AC8: throws the bad-report message for a %s structured_output", async (_case, json) => {
    const error = (await runSession(task, config, answer({ json })).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^Agent report did not match the schema: /);
    expect(classifyFailure(error.message)).toBe("bad-report");
  });
});
