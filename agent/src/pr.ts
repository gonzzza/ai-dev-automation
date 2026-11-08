import type { AgentRun } from "./agent.js";
import type { Spec } from "./spec.js";

export const branchName = (spec: Spec): string => `agent/${spec.slug}`;

export function commitMessage(spec: Spec, run: AgentRun): string {
  return `${spec.title}\n\nImplements ${spec.path}.\n\n${run.report.summary}\n`;
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
}

export function prBody({ spec, run, files, model, base, repoUrl }: PrContext): string {
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
    "Verified by the harness after the agent finished: `npm run check` (lint, typecheck, all tests) passed.",
  ];
  if (report.notes.trim()) sections.push("## Notes for the reviewer", report.notes);
  sections.push(
    "## Files changed",
    files.map((f) => `- \`${f}\``).join("\n"),
    `<sub>${model} · ${run.turns} turns · ${Math.round(run.durationMs / 1000)}s · $${run.costUsd.toFixed(2)}</sub>`,
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  );
  return sections.join("\n\n");
}
