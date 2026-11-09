import { describe, expect, it } from "vitest";
import { annotatePatch } from "../src/diff.js";
import { anchorFindings, fitBody, MAX_BODY_CHARS, renderSummary, REVIEW_MARKER } from "../src/render.js";
import type { Finding } from "../src/schema.js";

const file = { path: "src/a.ts", ...annotatePatch("@@ -1,1 +1,2 @@\n line one\n+line two") };

const finding = (over: Partial<Finding>): Finding => ({
  path: "src/a.ts",
  line: 2,
  category: "bug",
  severity: "medium",
  title: "Off by one",
  body: "Loop skips the last item.",
  ...over,
});

describe("anchorFindings", () => {
  it("anchors findings on diff lines and sorts by severity", () => {
    const { inline, anchored, unanchored } = anchorFindings(
      [finding({ severity: "low" }), finding({ severity: "critical", line: 1 })],
      [file],
    );
    expect(inline.map((c) => c.line)).toEqual([1, 2]);
    expect(inline[0]).toMatchObject({ path: "src/a.ts", side: "RIGHT" });
    expect(inline[0]?.body).toContain("**🐛 Bug · critical**: Off by one");
    expect(anchored).toHaveLength(2);
    expect(unanchored).toEqual([]);
  });

  it("keeps findings that GitHub cannot anchor", () => {
    const outside = finding({ line: 99 });
    const otherFile = finding({ path: "src/elsewhere.ts" });
    const { inline, unanchored } = anchorFindings([outside, otherFile], [file]);
    expect(inline).toEqual([]);
    expect(unanchored).toEqual([outside, otherFile]);
  });
});

describe("fitBody", () => {
  it("leaves normal bodies alone and visibly truncates huge ones", () => {
    expect(fitBody("short")).toBe("short");
    const fitted = fitBody("x".repeat(100_000));
    expect(fitted.length).toBeLessThan(65_536);
    expect(fitted.length).toBeGreaterThan(MAX_BODY_CHARS);
    expect(fitted).toMatch(/truncated to fit/);
  });
});

describe("renderSummary", () => {
  const meta = { model: "claude-sonnet-5-5", inputTokens: 12345, outputTokens: 678, reviewedFiles: 1 };

  it("includes the marker, tally, unanchored findings and skipped files", () => {
    const review = {
      summary: "Adds a helper.",
      findings: [finding({ severity: "high" }), finding({ severity: "high" }), finding({ severity: "low" })],
    };
    const body = renderSummary(review, [finding({ line: 99 })], [{ path: "logo.png", reason: "binary" }], meta);
    expect(body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(body).toContain("**Findings:** 2 high, 1 low");
    expect(body).toContain("### Findings outside the diff");
    expect(body).toContain("- `src/a.ts:99` **🐛 Bug · medium**: Off by one Loop skips the last item.");
    expect(body).toContain("Files not reviewed (1)");
    expect(body).toContain("12,345 in / 678 out tokens");
  });

  it("lists at most 50 skipped files and counts the rest", () => {
    const skipped = Array.from({ length: 1000 }, (_, i) => ({ path: `gen/${i}.json`, reason: "excluded by pattern" }));
    const body = renderSummary({ summary: "s", findings: [] }, [], skipped, meta);
    expect(body).toContain("Files not reviewed (1000)");
    expect(body).toContain("`gen/49.json`");
    expect(body).not.toContain("`gen/50.json`");
    expect(body).toContain("…and 950 more");
  });

  it("says so when the PR is clean", () => {
    const body = renderSummary({ summary: "Docs only.", findings: [] }, [], [], meta);
    expect(body).toContain("**Findings:** no issues found");
    expect(body).not.toContain("Files not reviewed");
  });
});
