import type { AnnotatedFile, SkippedFile } from "./diff.js";
import { bySeverityDesc, SEVERITIES, type Category, type Finding, type Review } from "./schema.js";

export const REVIEW_MARKER = "<!-- ai-dev-automation:review -->";

/** Skipped files listed by name in the summary; the rest are counted. */
export const MAX_LISTED_SKIPPED = 50;

/** GitHub rejects review and comment bodies over 65,536 characters. Leave headroom. */
export const MAX_BODY_CHARS = 60_000;

/** Keep a body under GitHub's size limit, saying so when it had to cut. */
export function fitBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n_…truncated to fit GitHub's comment size limit._`;
}

const CATEGORY_LABEL: Record<Category, string> = {
  bug: "🐛 Bug",
  security: "🔒 Security",
  "missing-tests": "🧪 Missing tests",
  performance: "⚡ Performance",
  maintainability: "🧹 Maintainability",
};

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** Split findings into ones GitHub can anchor inline and ones that must go in the summary. */
export function anchorFindings(
  findings: Finding[],
  files: AnnotatedFile[],
): { inline: InlineComment[]; anchored: Finding[]; unanchored: Finding[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const inline: InlineComment[] = [];
  const anchored: Finding[] = [];
  const unanchored: Finding[] = [];

  for (const finding of [...findings].sort(bySeverityDesc)) {
    if (byPath.get(finding.path)?.commentableLines.has(finding.line)) {
      anchored.push(finding);
      inline.push({ path: finding.path, line: finding.line, side: "RIGHT", body: renderFinding(finding) });
    } else {
      unanchored.push(finding);
    }
  }
  return { inline, anchored, unanchored };
}

export function renderFinding(f: Finding): string {
  return `**${CATEGORY_LABEL[f.category]} · ${f.severity}**: ${f.title}\n\n${f.body}`;
}

/** One-line list item, for findings shown in the review body instead of inline. */
export function renderFindingListItem(f: Finding): string {
  return `- \`${f.path}:${f.line}\` ${renderFinding(f).replace(/\s*\n+\s*/g, " ")}`;
}

export interface SummaryMeta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  reviewedFiles: number;
}

export function renderSummary(
  review: Review,
  unanchored: Finding[],
  skipped: SkippedFile[],
  meta: SummaryMeta,
): string {
  const tally = review.findings.length
    ? [...SEVERITIES]
        .reverse()
        .map((s) => [s, review.findings.filter((f) => f.severity === s).length] as const)
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ")
    : "no issues found";

  const parts = [REVIEW_MARKER, "## 🤖 AI review", review.summary, `**Findings:** ${tally}`];

  if (unanchored.length) {
    parts.push("### Findings outside the diff", unanchored.map(renderFindingListItem).join("\n"));
  }
  if (skipped.length) {
    const listed = skipped.slice(0, MAX_LISTED_SKIPPED).map((s) => `- \`${s.path}\`: ${s.reason}`);
    if (skipped.length > MAX_LISTED_SKIPPED) listed.push(`- …and ${skipped.length - MAX_LISTED_SKIPPED} more`);
    parts.push(`<details><summary>Files not reviewed (${skipped.length})</summary>\n\n${listed.join("\n")}\n</details>`);
  }
  const n = (x: number) => x.toLocaleString("en-US");
  parts.push(
    `<sub>${meta.model} · ${meta.reviewedFiles} file(s) · ${n(meta.inputTokens)} in / ${n(meta.outputTokens)} out tokens · ` +
      "AI review is advisory; a human approves the merge.</sub>",
  );
  return parts.join("\n\n");
}
