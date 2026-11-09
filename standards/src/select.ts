import { matchesGlob } from "node:path";
import { SEVERITIES, type Standard, type StandardUse } from "./parse.js";

export interface SelectOptions {
  use: StandardUse;
  /**
   * Repo-relative paths of the files being worked on. When omitted, `applies_to` is not checked:
   * every standard for `use` is a candidate (the agent can't know which files it will create).
   */
  paths?: readonly string[];
  /** Budget for the selected standards' id + title + body, in characters. */
  maxChars: number;
}

export interface Selection {
  /** Most severe first, then by id. */
  selected: Standard[];
  /** Standards that applied but did not fit in `maxChars`, most severe first. */
  dropped: Standard[];
}

/** The characters a standard counts against the budget. */
export const standardSize = (s: Standard): number => s.id.length + s.title.length + s.body.length;

const severityRank = (s: Standard): number => SEVERITIES.indexOf(s.severity);

const applies = (s: Standard, paths: readonly string[] | undefined): boolean =>
  paths === undefined || s.appliesTo.length === 0 || paths.some((path) => s.appliesTo.some((glob) => matchesGlob(path, glob)));

/**
 * The standards for `use` that apply to at least one of `paths` (or all of them, when `paths` is
 * omitted), most severe first, then by id.
 * While their total size is over `maxChars`, the least severe one moves to `dropped`.
 */
export function selectStandards(standards: readonly Standard[], { use, paths, maxChars }: SelectOptions): Selection {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new RangeError(`maxChars must be a positive integer; got ${maxChars}`);

  const selected = standards
    .filter((s) => s.use.includes(use) && applies(s, paths))
    .sort((a, b) => severityRank(b) - severityRank(a) || a.id.localeCompare(b.id, "en", { numeric: true }));
  const dropped: Standard[] = [];
  let total = selected.reduce((sum, s) => sum + standardSize(s), 0);
  while (total > maxChars && selected.length > 0) {
    const last = selected.pop()!;
    total -= standardSize(last);
    dropped.unshift(last);
  }
  return { selected, dropped };
}
