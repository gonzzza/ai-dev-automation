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

/** A --scope value as a repo-relative directory, so "./demo-app", "demo-app/" and absolute paths all work. */
export function scopeDir(repoRoot: string, cwd: string, dir: string): string {
  const rel = repoRelative(repoRoot, resolve(cwd, dir));
  if (rel === null) throw new Error(`--scope ${dir} is outside the repository.`);
  if (rel === ".") throw new Error("--scope must be a directory inside the repository, not the repository root.");
  return rel.replace(/\/+$/, "");
}
