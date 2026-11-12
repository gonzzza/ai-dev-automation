import { describe, expect, it } from "vitest";
import { usageErrorOf, type ModeFlags } from "../src/args.js";

const none: ModeFlags = { plan: false, positionals: 0, fixPr: false, dryRun: false, base: false, dispatch: false, maxParallel: false };

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

  it("needs exactly one spec path outside --plan and --fix-pr", () => {
    expect(usageErrorOf(none)).toBe("Give exactly one spec path.");
    expect(usageErrorOf({ ...none, positionals: 2 })).toBe("Give exactly one spec path.");
    expect(usageErrorOf({ ...none, fixPr: true, positionals: 1 })).toBe("--fix-pr takes no spec path.");
  });
});
