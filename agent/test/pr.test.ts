import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { prBody, type PrContext } from "../src/pr.js";
import { parseSpec } from "../src/spec.js";

const spec = parseSpec(
  "specs/001-rate-limiter.md",
  "# Add a token bucket rate limiter\n\n## Goal\nx\n\n## Requirements\nx\n\n## Acceptance criteria\n- AC1: x\n",
);

const run: AgentRun = {
  report: { plan: ["Read retry.ts", "Write limiter and tests"], summary: "Adds createRateLimiter.", testing: "Unit tests with a fake clock.", checksPassed: true, notes: "" },
  costUsd: 1.234,
  turns: 18,
  durationMs: 95_000,
};

const context: PrContext = { spec, run, files: ["demo-app/src/a.ts"], model: "claude-opus-5-5", base: "main", runId: "r1" };

// The body prBody produced for `context` before standards existed.
const BODY_BEFORE = [
  "> 🤖 Opened by the spec-driven agent from `specs/001-rate-limiter.md`. A human reviews and merges.",
  "## Summary",
  "Adds createRateLimiter.",
  "## Plan",
  "1. Read retry.ts\n2. Write limiter and tests",
  "## Testing",
  "Unit tests with a fake clock.",
  "Re-run locally by the harness after the agent finished: `npm run check` (lint, typecheck, all tests) passed. CI verifies again on a clean checkout.",
  "## Files changed",
  "- `demo-app/src/a.ts`",
  "<sub>claude-opus-5-5 · 18 turns · 95s · $1.23 · run r1</sub>",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
].join("\n\n");

describe("prBody standards section", () => {
  it("AC6: without standards, equals the body from before this change", () => {
    expect(prBody(context)).toBe(BODY_BEFORE);
  });

  it("AC6: lists the checked ids, the ref and the dropped ids before ## Files changed", () => {
    const body = prBody({ ...context, standards: { checked: ["SEC-001", "TS-003"], dropped: ["TEST-001"], ref: "v1.2.0" } });
    const section = body.slice(body.indexOf("## Standards"), body.indexOf("## Files changed"));
    expect(body.indexOf("## Standards")).toBeGreaterThan(body.indexOf("## Testing"));
    expect(body.indexOf("## Standards")).toBeLessThan(body.indexOf("## Files changed"));
    expect(section).toBe(
      "## Standards\n\n" +
        "- Given to the agent: `SEC-001`, `TS-003`\n" +
        "- Version: `v1.2.0`\n" +
        "- Not given to the agent (over the size budget): `TEST-001`\n\n",
    );
    // Everything else is as before.
    expect(body.replace(section, "")).toBe(BODY_BEFORE);
  });

  it("AC6: comes after the reviewer notes and leaves out the ref and dropped lines when there are none", () => {
    const withNotes = { ...context, run: { ...run, report: { ...run.report, notes: "Assumed UTC." } } };
    const body = prBody({ ...withNotes, standards: { checked: ["TS-003"], dropped: [] } });
    expect(body).toContain("## Notes for the reviewer\n\nAssumed UTC.\n\n## Standards\n\n- Given to the agent: `TS-003`\n\n## Files changed");
    expect(body).not.toContain("Version:");
    expect(body).not.toContain("Not given to the agent");
  });
});
