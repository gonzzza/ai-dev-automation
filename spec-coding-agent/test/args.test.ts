import { describe, expect, it } from "vitest";
import { usageErrorOf, waveAgentArgs, type ModeFlags } from "../src/args.js";

const none: ModeFlags = { plan: false, positionals: 0, fixPr: false, dryRun: false, base: false, dispatch: false, maxParallel: false, local: false, worktreeDir: false, session: false, maxTurns: false, maxMinutes: false };

describe("usageErrorOf", () => {
  it("accepts a spec run, a fix run and the plan modes", () => {
    expect(usageErrorOf({ ...none, positionals: 1, dryRun: true, base: true })).toBeUndefined();
    expect(usageErrorOf({ ...none, fixPr: true })).toBeUndefined();
    expect(usageErrorOf({ ...none, plan: true })).toBeUndefined();
    expect(usageErrorOf({ ...none, plan: true, dispatch: true, maxParallel: true })).toBeUndefined();
  });

  it.each([
    ["a spec path", { positionals: 1 }],
    ["--fix-pr", { fixPr: true }],
    ["--dry-run", { dryRun: true }],
    ["--base", { base: true }],
  ])("rejects --plan with %s", (name, flags) => {
    expect(usageErrorOf({ ...none, plan: true, ...flags })).toBe(`--plan can't be combined with ${name}.`);
  });

  it("rejects --dispatch and --max-parallel without --plan", () => {
    expect(usageErrorOf({ ...none, positionals: 1, dispatch: true })).toBe("--dispatch only works with --plan.");
    expect(usageErrorOf({ ...none, positionals: 1, maxParallel: true })).toBe("--max-parallel only works with --plan.");
  });

  it("accepts --plan --local with --max-parallel and --worktree-dir", () => {
    expect(usageErrorOf({ ...none, plan: true, local: true, maxParallel: true, worktreeDir: true })).toBeUndefined();
  });

  it("rejects --local without --plan, --local with --dispatch, and --worktree-dir without --local", () => {
    expect(usageErrorOf({ ...none, local: true })).toBe("--local only works with --plan.");
    expect(usageErrorOf({ ...none, plan: true, local: true, dispatch: true })).toBe("--local can't be combined with --dispatch.");
    expect(usageErrorOf({ ...none, plan: true, worktreeDir: true })).toBe("--worktree-dir only works with --local.");
    expect(usageErrorOf({ ...none, positionals: 1, worktreeDir: true })).toBe("--worktree-dir only works with --local.");
  });

  it("AC8: accepts --session spec runs with --max-minutes, and --max-minutes with --local", () => {
    expect(usageErrorOf({ ...none, positionals: 1, session: true, maxMinutes: true })).toBeUndefined();
    expect(usageErrorOf({ ...none, plan: true, local: true, maxMinutes: true })).toBeUndefined();
  });

  it("AC8: rejects --session with --plan or --fix-pr, --max-turns with sessions, and --max-minutes without them", () => {
    expect(usageErrorOf({ ...none, plan: true, session: true })).toBe("--session can't be combined with --plan; --plan --local runs sessions already.");
    expect(usageErrorOf({ ...none, fixPr: true, session: true })).toBe("--session can't be combined with --fix-pr.");
    const turns = "--max-turns doesn't apply to Claude Code sessions; use --max-minutes.";
    expect(usageErrorOf({ ...none, positionals: 1, session: true, maxTurns: true })).toBe(turns);
    expect(usageErrorOf({ ...none, plan: true, local: true, maxTurns: true })).toBe(turns);
    expect(usageErrorOf({ ...none, positionals: 1, maxMinutes: true })).toBe("--max-minutes only works with --session or --local.");
    expect(usageErrorOf({ ...none, positionals: 1, maxTurns: true })).toBeUndefined();
  });

  it("needs exactly one spec path outside --plan and --fix-pr", () => {
    expect(usageErrorOf(none)).toBe("Give exactly one spec path.");
    expect(usageErrorOf({ ...none, positionals: 2 })).toBe("Give exactly one spec path.");
    expect(usageErrorOf({ ...none, fixPr: true, positionals: 1 })).toBe("--fix-pr takes no spec path.");
  });
});

describe("waveAgentArgs", () => {
  it("passes every run option on, repeating --scope and leaving out unset standards options", () => {
    const options = {
      scope: ["demo-app", "standards"],
      model: "claude-opus-5-5",
      effort: "high",
      "max-minutes": "60",
      "max-budget": "5",
      sandbox: "docker",
      "sandbox-image": "node:24-bookworm",
      standards: "org-standards",
      "standards-ref": "abc1234",
      "max-standards-chars": "40000",
      "log-dir": "/abs/runs",
    };
    expect(waveAgentArgs(options)).toEqual([
      "--scope", "demo-app", "--scope", "standards",
      "--model", "claude-opus-5-5", "--effort", "high", "--max-minutes", "60", "--max-budget", "5",
      "--sandbox", "docker", "--sandbox-image", "node:24-bookworm",
      "--standards", "org-standards", "--standards-ref", "abc1234", "--max-standards-chars", "40000", "--log-dir", "/abs/runs",
    ]);
  });
});
