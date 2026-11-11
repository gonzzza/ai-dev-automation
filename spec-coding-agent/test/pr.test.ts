import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { commitMessage, prBody, prTitle, UNFILLED_SECTION, type PrContext } from "../src/pr.js";
import { parseSpec, type Spec } from "../src/spec.js";
import type { PrTemplate } from "../src/template.js";

const spec = parseSpec(
  "specs/001-rate-limiter.md",
  "# Add a token bucket rate limiter\n\n## Goal\nx\n\n## Requirements\nx\n\n## Acceptance criteria\n- AC1: x\n",
);

const run: AgentRun = {
  report: { plan: ["Read retry.ts", "Write limiter and tests"], summary: "Adds createRateLimiter.", testing: "Unit tests with a fake clock.", checksPassed: true, notes: "", sections: [] },
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

describe("prBody opening line", () => {
  it("links the agent's workspace folder and the spec file on the base branch", () => {
    const body = prBody({ ...context, repoUrl: "https://github.com/o/r" });
    expect(body.split("\n\n")[0]).toBe(
      "> 🤖 Opened by the [spec-driven agent](https://github.com/o/r/tree/main/spec-coding-agent) " +
        "from [`specs/001-rate-limiter.md`](https://github.com/o/r/blob/main/specs/001-rate-limiter.md). A human reviews and merges.",
    );
  });

  it("links a folder that exists in this repo, so a rename can't leave the link dangling", () => {
    const body = prBody({ ...context, repoUrl: "https://github.com/o/r" });
    const folder = /\/tree\/main\/([^)]+)\)/.exec(body)?.[1];
    expect(folder).toBeDefined();
    expect(existsSync(new URL(`../../${folder}/package.json`, import.meta.url))).toBe(true);
  });
});

const withSlug = (slug: string, title: string): Spec => ({ ...spec, path: `specs/${slug}.md`, slug, title });
const codePoints = (text: string) => Array.from(text).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("prTitle", () => {
  it("AC1: starts with the spec number, padded to three digits", () => {
    expect(prTitle(spec)).toBe("SPEC-001 Add a token bucket rate limiter");
    expect(prTitle(withSlug("7-x", "Do x"))).toBe("SPEC-007 Do x");
    expect(prTitle(withSlug("1234-x", "Do x"))).toBe("SPEC-1234 Do x");
    // The leading digits are kept as written and only padded, so an extra zero stays.
    expect(prTitle(withSlug("0004-x", "Do x"))).toBe("SPEC-0004 Do x");
  });

  it("AC1: returns the title unchanged for a slug with no number", () => {
    expect(prTitle(withSlug("rate-limiter", "Add a limiter"))).toBe("Add a limiter");
  });

  it("AC1: cuts a long title to exactly 72 code points when the cut lands inside a word", () => {
    const title = prTitle(withSlug("x", "a".repeat(100)));
    expect(title).toBe(`${"a".repeat(71)}…`);
    expect(codePoints(title)).toBe(72);
  });

  it("AC1: trims whitespace at the cut, giving fewer than 72 code points", () => {
    const title = prTitle(withSlug("x", `${"a".repeat(70)} ${"b".repeat(10)}`));
    expect(title).toBe(`${"a".repeat(70)}…`);
    expect(codePoints(title)).toBe(71);
  });

  it("AC1: never splits a surrogate pair at the cut", () => {
    const title = prTitle(withSlug("x", `${"a".repeat(70)}😀😀😀`));
    expect(title).toBe(`${"a".repeat(70)}😀…`);
    expect(title).not.toMatch(LONE_SURROGATE);
  });

  it("AC1: counts the SPEC- prefix in the limit, and cuts a title with no number the same way", () => {
    const prefixed = prTitle(withSlug("001-x", "b".repeat(70)));
    expect(prefixed.startsWith("SPEC-001 ")).toBe(true);
    expect(prefixed.endsWith("…")).toBe(true);
    expect(codePoints(prefixed)).toBeLessThanOrEqual(72);

    const bare = prTitle(withSlug("x", "c".repeat(90)));
    expect(bare).toBe(`${"c".repeat(71)}…`);
    expect(codePoints(bare)).toBeLessThanOrEqual(72);
  });

  it("AC1: is the first line of the commit message", () => {
    for (const s of [spec, withSlug("x", "d".repeat(90))]) {
      expect(commitMessage(s, run, "r1").split("\n")[0]).toBe(prTitle(s));
    }
  });

  it("AC7: gives exactly the example title in this repo's PR template", () => {
    const text = readFileSync(new URL("../../.github/pull_request_template.md", import.meta.url), "utf8");
    const example = /"(SPEC-(\d+) ([^"]+))"/.exec(text);
    expect(example, "the PR template has no quoted SPEC-XXX example title").not.toBeNull();
    const [, full, number, rest] = example!;
    expect(prTitle(withSlug(`${number}-example`, rest!))).toBe(full);
  });
});

describe("prBody with a PR template", () => {
  const template: PrTemplate = {
    sections: [
      { heading: "What", guidance: "The change." },
      { heading: "Why", guidance: "The reason." },
      { heading: "Testing", guidance: "The tests." },
    ],
  };
  const reportWith = (sections: AgentRun["report"]["sections"], notes = ""): PrContext => ({
    ...context,
    template,
    run: { ...run, report: { ...run.report, sections, notes } },
  });
  const sectionText = (body: string, heading: string) => {
    const start = body.indexOf(`## ${heading}\n\n`) + `## ${heading}\n\n`.length;
    return body.slice(start, body.indexOf("\n\n## ", start));
  };

  it("AC5: renders the template's headings in order from matching entries, with the harness sections after them", () => {
    const body = prBody(
      reportWith([
        { heading: " testing ", text: "Unit tests with a fake clock." },
        { heading: "WHAT", text: "Adds createRateLimiter." },
        { heading: "Extra", text: "Not in the template." },
        { heading: "Why", text: "   " },
        { heading: "What", text: "A second, ignored entry." },
      ]),
    );
    expect(body).toBe(
      [
        "> 🤖 Opened by the spec-driven agent from `specs/001-rate-limiter.md`. A human reviews and merges.",
        "## What",
        "Adds createRateLimiter.",
        "## Why",
        UNFILLED_SECTION,
        "## Testing",
        "Unit tests with a fake clock.",
        "## Checks",
        "Re-run locally by the harness after the agent finished: `npm run check` (lint, typecheck, all tests) passed. CI verifies again on a clean checkout.",
        "## Plan",
        "1. Read retry.ts\n2. Write limiter and tests",
        "## Files changed",
        "- `demo-app/src/a.ts`",
        "<sub>claude-opus-5-5 · 18 turns · 95s · $1.23 · run r1</sub>",
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      ].join("\n\n"),
    );
    expect(body).not.toContain("## Summary");
  });

  it("AC5: shows the placeholder for a section the report has no entry for", () => {
    expect(sectionText(prBody(reportWith([])), "What")).toBe(UNFILLED_SECTION);
  });

  it("AC5: puts the notes and standards after Plan, and Files changed last", () => {
    const body = prBody({ ...reportWith([], "Assumed UTC."), standards: { checked: ["TS-003"], dropped: [] } });
    const order = ["## Testing", "## Checks", "## Plan", "## Notes for the reviewer", "## Standards", "## Files changed"].map((h) => body.indexOf(h));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("AC5: rewrites # and ## heading lines in the model's text as ###, but not inside a fence", () => {
    const text = ["# Big", "## Checks", "##\tTab", "##", "   ## Indented", "### Kept", "#hashtag", "```", "## In code", "```"].join("\n");
    expect(sectionText(prBody(reportWith([{ heading: "What", text }])), "What")).toBe(
      ["### Big", "### Checks", "###\tTab", "###", "   ### Indented", "### Kept", "#hashtag", "```", "## In code", "```"].join("\n"),
    );
  });

  it("AC5: closes a fence the model's text leaves open, with the same character and length", () => {
    const body = prBody(reportWith([{ heading: "What", text: "````ts\nconst a = 1;" }, { heading: "Why", text: "~~~\nx" }]));
    expect(body).toContain("## What\n\n````ts\nconst a = 1;\n````\n\n## Why\n\n~~~\nx\n~~~\n\n## Testing");
  });

  it("closes an HTML comment the model's text leaves open", () => {
    const body = prBody(reportWith([{ heading: "What", text: "Adds x. <!-- oops" }]));
    expect(body).toContain("## What\n\nAdds x. <!-- oops\n-->\n\n## Why");
  });

  it("AC5: without a template, ignores the report's sections and equals the body from before this change", () => {
    const withSections = { ...context, run: { ...run, report: { ...run.report, sections: [{ heading: "What", text: "x" }] } } };
    expect(prBody(withSections)).toBe(BODY_BEFORE);
  });
});
