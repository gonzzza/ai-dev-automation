import type { AgentRun } from "./agent.js";
import type { Spec } from "./spec.js";
import { sameHeading, scanMarkdown, type PrTemplate } from "./template.js";

export const branchName = (spec: Spec): string => `agent/${spec.slug}`;

/** Trailer that ties a commit to the run, and its audit log, that produced it. */
export const RUN_TRAILER = "Agent-Run";

export function commitMessage(spec: Spec, run: AgentRun, runId?: string): string {
  const trailer = runId ? `\n${RUN_TRAILER}: ${runId}\n` : "";
  return `${prTitle(spec)}\n\nImplements ${spec.path}.\n\n${run.report.summary}\n${trailer}`;
}

/** The footer line shared by the PR body and the fix-cycle comments. */
export function runFooter(model: string, run: AgentRun<unknown>, { runId, runLink }: { runId?: string; runLink?: string } = {}): string {
  const parts = [model, `${run.turns} turns`, `${Math.round(run.durationMs / 1000)}s`, `$${run.costUsd.toFixed(2)}`];
  if (runId) parts.push(runLink ? `run [${runId}](${runLink})` : `run ${runId}`);
  return `<sub>${parts.join(" · ")}</sub>`;
}

/** Longest title, in code points, the repo's PR template allows. */
export const MAX_TITLE_LENGTH = 72;

/**
 * `SPEC-<number> <title>`, the format the PR template asks for. The number is the slug's leading
 * digits, padded to three (`7-x` → `SPEC-007`, `0004-x` → `SPEC-0004`). A slug with no number gives
 * the bare title. Over 72 code points, the whole title is cut to 71 and ends in `…`.
 */
export function prTitle(spec: Spec): string {
  const number = /^\d+/.exec(spec.slug)?.[0];
  const title = number ? `SPEC-${number.padStart(3, "0")} ${spec.title}` : spec.title;
  // Code points, not UTF-16 units, so the cut never splits a surrogate pair.
  const chars = Array.from(title);
  if (chars.length <= MAX_TITLE_LENGTH) return title;
  return `${chars.slice(0, MAX_TITLE_LENGTH - 1).join("").trimEnd()}…`;
}

export interface PrContext {
  spec: Spec;
  run: AgentRun;
  files: string[];
  model: string;
  base: string;
  /** e.g. "https://github.com/o/r". Links are plain text without it. */
  repoUrl?: string;
  runId?: string;
  /** The org standards the agent was given, if any. */
  standards?: PrStandards;
  /** The repo's PR template, from the base checkout. Its sections replace Summary and Testing. */
  template?: PrTemplate;
}

export interface PrStandards {
  checked: string[];
  dropped: string[];
  ref?: string;
}

function standardsSection({ checked, dropped, ref }: PrStandards): string[] {
  const lines = [`- Given to the agent: ${checked.length ? checked.map((id) => `\`${id}\``).join(", ") : "none"}`];
  if (ref) lines.push(`- Version: \`${ref}\``);
  if (dropped.length) lines.push(`- Not given to the agent (over the size budget): ${dropped.map((id) => `\`${id}\``).join(", ")}`);
  return ["## Standards", lines.join("\n")];
}

const CHECKS_LINE =
  "Re-run locally by the harness after the agent finished: `npm run check` (lint, typecheck, all tests) passed. CI verifies again on a clean checkout.";

/** Shown under a template section the report left out or left blank. */
export const UNFILLED_SECTION = "_The agent did not fill this section._";

/**
 * Keeps the model's text for one section from reshaping the body around it. Outside code blocks
 * and comments, `#` and `##` heading lines become `###`. A code block or HTML comment left open at
 * the end is closed, so it can't swallow the sections after it. Tidiness, not a security boundary:
 * setext underlines and raw HTML can still draw a heading, and the PR's CI status, not its body,
 * is the evidence that the checks passed.
 */
export function tidySectionText(text: string): string {
  const scan = scanMarkdown(text.trimEnd());
  const lines = scan.lines.map(({ line, startsIn }) => (startsIn === "text" ? line.replace(/^( {0,3})#{1,2}(?=[ \t]|$)/, "$1###") : line));
  if (scan.openFence !== undefined) lines.push(scan.openFence);
  else if (scan.endsIn === "comment") lines.push("-->");
  return lines.join("\n");
}

/** One `## heading` and its text per template section, in template order, from the report's first matching entry. */
function templateSections(template: PrTemplate, entries: AgentRun["report"]["sections"]): string[] {
  return template.sections.flatMap(({ heading }) => {
    const text = entries.find((entry) => sameHeading(entry.heading, heading))?.text;
    return [`## ${heading}`, text?.trim() ? tidySectionText(text) : UNFILLED_SECTION];
  });
}

export function prBody({ spec, run, files, model, base, repoUrl, runId, standards, template }: PrContext): string {
  const { report } = run;
  const link = (text: string, path: string, kind: "blob" | "tree") =>
    repoUrl ? `[${text}](${repoUrl}/${kind}/${base}/${path})` : text;
  const opening =
    `> 🤖 Opened by the ${link("spec-driven agent", "agent", "tree")} from ${link(`\`${spec.path}\``, spec.path, "blob")}. ` +
    "A human reviews and merges.";
  const plan = ["## Plan", report.plan.map((step, i) => `${i + 1}. ${step}`).join("\n")];
  // With a template, its sections replace Summary and Testing, and the harness line gets its own heading.
  const sections = template
    ? [opening, ...templateSections(template, report.sections), "## Checks", CHECKS_LINE, ...plan]
    : [opening, "## Summary", report.summary, ...plan, "## Testing", report.testing, CHECKS_LINE];
  if (report.notes.trim()) sections.push("## Notes for the reviewer", report.notes);
  if (standards) sections.push(...standardsSection(standards));
  sections.push(
    "## Files changed",
    files.map((f) => `- \`${f}\``).join("\n"),
    runFooter(model, run, { runId }),
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  );
  return sections.join("\n\n");
}
