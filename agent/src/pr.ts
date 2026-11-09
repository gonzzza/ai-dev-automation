import type { AgentRun } from "./agent.js";
import type { Spec } from "./spec.js";

export const branchName = (spec: Spec): string => `agent/${spec.slug}`;

/** Trailer that ties a commit to the run, and its audit log, that produced it. */
export const RUN_TRAILER = "Agent-Run";

export function commitMessage(spec: Spec, run: AgentRun, runId?: string): string {
  const trailer = runId ? `\n${RUN_TRAILER}: ${runId}\n` : "";
  return `${spec.title}\n\nImplements ${spec.path}.\n\n${run.report.summary}\n${trailer}`;
}

/** The footer line shared by the PR body and the fix-cycle comments. */
export function runFooter(model: string, run: AgentRun<unknown>, { runId, runLink }: { runId?: string; runLink?: string } = {}): string {
  const parts = [model, `${run.turns} turns`, `${Math.round(run.durationMs / 1000)}s`, `$${run.costUsd.toFixed(2)}`];
  if (runId) parts.push(runLink ? `run [${runId}](${runLink})` : `run ${runId}`);
  return `<sub>${parts.join(" · ")}</sub>`;
}

export function prTitle(spec: Spec): string {
  return spec.title;
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

export function prBody({ spec, run, files, model, base, repoUrl, runId, standards }: PrContext): string {
  const { report } = run;
  const link = (text: string, path: string, kind: "blob" | "tree") =>
    repoUrl ? `[${text}](${repoUrl}/${kind}/${base}/${path})` : text;
  const sections = [
    `> 🤖 Opened by the ${link("spec-driven agent", "agent", "tree")} from ${link(`\`${spec.path}\``, spec.path, "blob")}. ` +
      "A human reviews and merges.",
    "## Summary",
    report.summary,
    "## Plan",
    report.plan.map((step, i) => `${i + 1}. ${step}`).join("\n"),
    "## Testing",
    report.testing,
    "Re-run locally by the harness after the agent finished: `npm run check` (lint, typecheck, all tests) passed. CI verifies again on a clean checkout.",
  ];
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
