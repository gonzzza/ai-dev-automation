import { resolve } from "node:path";
import { repoRelative } from "./policy.js";
import { MAX_SESSION_MINUTES } from "./session.js";

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
  local: boolean;
  worktreeDir: boolean;
  session: boolean;
  /** Given explicitly, not by default. */
  maxTurns: boolean;
  maxMinutes: boolean;
}

/**
 * The usage error for a combination of mode flags, or undefined when it is valid. A spec run takes
 * one spec path; --fix-pr takes none; --plan takes none and none of the options that only make
 * sense for one spec; --dispatch, --max-parallel and --local only work with --plan; --local can't
 * dispatch, and --worktree-dir only works with --local. --session is a spec run's option (a wave
 * passes it to its runs itself); sessions have a time limit, not a turn limit.
 */
export function usageErrorOf(flags: ModeFlags): string | undefined {
  if (flags.worktreeDir && !flags.local) return "--worktree-dir only works with --local.";
  if (flags.session && flags.plan) return "--session can't be combined with --plan; --plan --local runs sessions already.";
  if (flags.session && flags.fixPr) return "--session can't be combined with --fix-pr.";
  if (flags.maxTurns && (flags.session || flags.local)) return "--max-turns doesn't apply to Claude Code sessions; use --max-minutes.";
  if (flags.maxMinutes && !flags.session && !flags.local) return "--max-minutes only works with --session or --local.";
  if (flags.plan) {
    const extra = [
      flags.positionals ? "a spec path" : "",
      flags.fixPr ? "--fix-pr" : "",
      flags.dryRun ? "--dry-run" : "",
      flags.base ? "--base" : "",
    ].filter(Boolean);
    if (extra.length) return `--plan can't be combined with ${extra.join(", ")}.`;
    return flags.local && flags.dispatch ? "--local can't be combined with --dispatch." : undefined;
  }
  const planOnly = [flags.dispatch ? "--dispatch" : "", flags.maxParallel ? "--max-parallel" : "", flags.local ? "--local" : ""].filter(Boolean);
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

/** The CLI options a local wave passes on to each of its runs, by name. */
export interface WaveOptions {
  scope: string[];
  model: string;
  effort: string;
  "max-minutes": string;
  "max-budget": string;
  sandbox: string;
  "sandbox-image": string;
  standards?: string;
  "standards-packs"?: string;
  "standards-ref"?: string;
  "max-standards-chars": string;
  /** Absolute, so every run's audit log lands in one folder. */
  "log-dir": string;
}

/**
 * The arguments every run of a local wave gets after its spec path. Relative paths in them resolve
 * in each run's worktree, which is at origin/main.
 */
export function waveAgentArgs(options: WaveOptions): string[] {
  const flag = (name: Exclude<keyof WaveOptions, "scope">) => {
    const value = options[name];
    return value === undefined ? [] : [`--${name}`, value];
  };
  return [
    ...options.scope.flatMap((dir) => ["--scope", dir]),
    ...(["model", "effort", "max-minutes", "max-budget", "sandbox", "sandbox-image"] as const).flatMap(flag),
    ...(["standards", "standards-packs", "standards-ref", "max-standards-chars", "log-dir"] as const).flatMap(flag),
  ];
}

/**
 * Parses --max-minutes. Checked by the CLI before any git work, so a value runSession would refuse
 * never leaves a claimed branch behind.
 */
export function parseMaxMinutes(raw: string): number {
  const minutes = parseLimit("--max-minutes", raw, { integer: true });
  if (minutes > MAX_SESSION_MINUTES) throw new RangeError(`--max-minutes must be at most ${MAX_SESSION_MINUTES}, got "${raw}".`);
  return minutes;
}
