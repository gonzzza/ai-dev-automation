import { resolve } from "node:path";
import { repoRelative } from "./policy.js";

/**
 * Parses a CLI limit. Turn and budget caps are guardrails, so anything that isn't a finite
 * positive number (NaN would silently disable the cap downstream) is an error.
 */
export function parseLimit(flag: string, raw: string, { integer = false } = {}): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${flag} must be a positive ${integer ? "integer" : "number"}, got "${raw}".`);
  }
  return value;
}

/** Which mode flags a command line has, for usageErrorOf. */
export interface ModeFlags {
  plan: boolean;
  positionals: number;
  fixPr: boolean;
  dryRun: boolean;
  base: boolean;
  dispatch: boolean;
  maxParallel: boolean;
}

/**
 * The usage error for a combination of mode flags, or undefined when it is valid. A spec run takes
 * one spec path; --fix-pr takes none; --plan takes none and none of the options that only make
 * sense for one spec; --dispatch and --max-parallel only work with --plan.
 */
export function usageErrorOf(flags: ModeFlags): string | undefined {
  if (flags.plan) {
    const extra = [
      flags.positionals ? "a spec path" : "",
      flags.fixPr ? "--fix-pr" : "",
      flags.dryRun ? "--dry-run" : "",
      flags.base ? "--base" : "",
    ].filter(Boolean);
    return extra.length ? `--plan can't be combined with ${extra.join(", ")}.` : undefined;
  }
  const planOnly = [flags.dispatch ? "--dispatch" : "", flags.maxParallel ? "--max-parallel" : ""].filter(Boolean);
  if (planOnly.length) return `${planOnly.join(" and ")} only ${planOnly.length > 1 ? "work" : "works"} with --plan.`;
  if (flags.positionals !== (flags.fixPr ? 0 : 1)) return flags.fixPr ? "--fix-pr takes no spec path." : "Give exactly one spec path.";
  return undefined;
}

/** A --scope value as a repo-relative directory, so "./demo-app", "demo-app/" and absolute paths all work. */
export function scopeDir(repoRoot: string, cwd: string, dir: string): string {
  const rel = repoRelative(repoRoot, resolve(cwd, dir));
  if (rel === null) throw new Error(`--scope ${dir} is outside the repository.`);
  if (rel === ".") throw new Error("--scope must be a directory inside the repository, not the repository root.");
  return rel.replace(/\/+$/, "");
}
