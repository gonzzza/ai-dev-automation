import { spawn } from "node:child_process";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { createInterface } from "node:readline";
import { checkMainCheckout, formatPlanned, planSpecs, readGithubState, type PlannedSpec } from "./coordinate.js";
import { run, tail, type Exec } from "./exec.js";
import type { RunLog } from "./runlog.js";
import { padSpecNumber, type Spec } from "./spec.js";

// A local wave runs the coordinator's plan on this machine: one git worktree per ready spec, one
// agent run per worktree, all at once. Each run claims its spec on origin before its agent starts,
// so local and CI coordinators can run side by side. A failed run keeps its worktree as the record.

/**
 * Marks specs whose worktree a previous wave kept (its run failed) as `needs-human` /
 * `local-worktree`, when GitHub alone says `ready` or `in-progress` with only a branch. Once a PR or
 * a run exists, GitHub's view wins. Paths are compared with the rules of `platform`, so the Windows
 * case (slashes, letter case) is tested on any host.
 */
export function applyLocalWorktrees(
  plan: readonly PlannedSpec[],
  worktrees: readonly string[],
  worktreeDir: string,
  platform: NodeJS.Platform = process.platform,
): PlannedSpec[] {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const key = (p: string) => (windows ? path.resolve(p).toLowerCase() : path.resolve(p));
  const listed = new Set(worktrees.map(key));
  return plan.map((spec) => {
    const worktree = path.resolve(worktreeDir, spec.slug);
    const { state } = spec;
    const leftover = state.status === "ready" || (state.status === "in-progress" && state.branch !== undefined && state.pr === undefined && !state.run);
    if (!leftover || !listed.has(key(worktree))) return spec;
    return { ...spec, state: { status: "needs-human", reason: "local-worktree", worktree } };
  });
}

/** The path of each `worktree <path>` line of `git worktree list --porcelain`. */
export function parseWorktreeList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** A child's exit code; a child killed by a signal has none, and counts as a failure. */
export function childExitCode(code: number | null, _signal: NodeJS.Signals | null): number {
  return typeof code === "number" ? code : 1;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
}

/** Starts one agent run with these CLI arguments and resolves to its exit code. */
export type SpawnAgent = (args: string[], options: SpawnOptions) => Promise<number>;

/**
 * Quotes an argument for the Windows shell. `%` and `!` expand even inside quotes, and a `"` would
 * end the quoting, so those are refused rather than escaped. Inside quotes, backslashes before the
 * closing quote are doubled, or the program's argument parser would read `\"` as a literal quote.
 */
export function cmdArg(arg: string): string {
  if (/["%!\r\n]/.test(arg)) throw new Error(`Can't pass ${JSON.stringify(arg)} to npm safely on Windows.`);
  if (/^[\w\-.,:\\/=@+]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Runs a command and streams its stdout and stderr line by line, resolving to its exit code (1 if
 * it couldn't start or was killed by a signal). Like exec, it uses a shell only for npm on Windows,
 * where npm is a .cmd script, with every argument passed through cmdArg.
 */
export function spawnLines(command: string, args: string[], { cwd, env, onLine }: SpawnOptions): Promise<number> {
  return new Promise((resolve) => {
    const child =
      process.platform === "win32" && command === "npm"
        ? spawn([command, ...args].map(cmdArg).join(" "), { cwd, env, shell: true })
        : spawn(command, args, { cwd, env });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", onLine);
    child.on("error", (error) => {
      onLine(`Could not start the run: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code, signal) => resolve(childExitCode(code, signal)));
  });
}

/** Runs `npm run agent -- <args>` in the worktree given as `cwd`. */
export const spawnAgent: SpawnAgent = (args, options) => spawnLines("npm", ["run", "agent", "--", ...args], options);

export interface LocalWaveDeps {
  specs: readonly Spec[];
  exec: Exec;
  repoRoot: string;
  /** Parent folder of the wave's worktrees, one per spec slug. Created if missing. */
  worktreeDir: string;
  /** Most runs in one wave. */
  maxParallel: number;
  /** Passed to every run after the spec path. */
  agentArgs: string[];
  /** The runs' environment. INIT_CWD is set to each worktree on top of it. */
  env: NodeJS.ProcessEnv;
  spawnAgent: SpawnAgent;
  /** With a Docker sandbox: installs its dependency volume once, before any run starts. */
  prepareSandbox?: () => Promise<unknown>;
  log: (line: string) => void;
  runLog?: RunLog;
}

export interface LocalWaveResult {
  plan: PlannedSpec[];
  started: string[];
  succeeded: string[];
  lostClaim: string[];
  failed: { spec: string; worktree: string; exitCode: number }[];
}

const NPM_CI_TIMEOUT_MS = 15 * 60_000;

/**
 * Plans every spec, then runs the agent on up to `maxParallel` ready specs at once, each in its own
 * worktree detached on origin/main. Successful runs and lost claims leave nothing behind; a failed
 * run keeps its worktree for a person to inspect.
 */
export async function runLocalWave(deps: LocalWaveDeps): Promise<LocalWaveResult> {
  const { exec, repoRoot, maxParallel } = deps;
  if (!Number.isInteger(maxParallel) || maxParallel <= 0) throw new RangeError(`maxParallel must be a positive integer; got ${maxParallel}`);
  const git = (args: string[]) => run(exec, "git", args, repoRoot);

  await checkMainCheckout(exec, repoRoot);

  // Git records worktrees by their real path, so a symlinked folder would never match its own.
  await mkdir(deps.worktreeDir, { recursive: true });
  const worktreeDir = await realpath(deps.worktreeDir);
  const lock = join(worktreeDir, ".lock");
  try {
    await (await open(lock, "wx")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another local wave is running, or one crashed and left ${lock}; delete it if none is running.`, { cause: error });
    }
    throw error;
  }
  try {
    return await wave({ ...deps, worktreeDir }, git);
  } finally {
    await rm(lock, { force: true });
  }
}

async function wave(deps: LocalWaveDeps, git: (args: string[]) => Promise<string>): Promise<LocalWaveResult> {
  const { specs, exec, worktreeDir, maxParallel, log, runLog } = deps;

  // Prune first: a kept worktree whose folder was deleted by hand no longer holds its spec back.
  const github = await readGithubState(exec, deps.repoRoot);
  await git(["worktree", "prune"]);
  const worktrees = parseWorktreeList(await git(["worktree", "list", "--porcelain"]));
  const plan = applyLocalWorktrees(planSpecs(specs, github), worktrees, worktreeDir);
  for (const planned of plan) log(formatPlanned(planned));
  runLog?.event({ type: "plan.result", plan });

  const chosen = plan.filter((p) => p.state.status === "ready").slice(0, maxParallel);
  const result: LocalWaveResult = { plan, started: [], succeeded: [], lostClaim: [], failed: [] };
  if (!chosen.length) {
    log("No ready specs; starting nothing.");
    return result;
  }

  // One at a time: each worktree gets its own node_modules, since the workspace packages are linked
  // in it, and parallel installs would compete for the same npm cache.
  const prepared: { spec: PlannedSpec; worktree: string }[] = [];
  let preparing = "";
  try {
    for (const spec of chosen) {
      preparing = spec.path;
      const worktree = join(worktreeDir, spec.slug);
      await git(["worktree", "add", "--detach", worktree, "origin/main"]);
      prepared.push({ spec, worktree });
      log(`Installing dependencies in ${worktree}...`);
      const install = await exec("npm", ["ci"], { cwd: worktree, timeoutMs: NPM_CI_TIMEOUT_MS });
      if (install.code !== 0) throw new Error(`npm ci failed (exit ${install.code}):\n${tail(`${install.stdout}\n${install.stderr}`.trim(), 4_000)}`);
    }
    preparing = "the Docker sandbox";
    await deps.prepareSandbox?.();
  } catch (error) {
    // No agent ran and nothing was claimed, so there's no failure to keep a record of.
    for (const { worktree } of prepared) await removeWorktree(git, worktree, log, true);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Preparing ${preparing} failed; removed this wave's worktrees.\n${message}`, { cause: error });
  }

  const runs = prepared.map(async ({ spec, worktree }) => {
    const prefix = `[${padSpecNumber(spec.number)}] `;
    result.started.push(spec.path);
    runLog?.event({ type: "local.start", spec: spec.path, worktree });
    log(`${prefix}Started in ${worktree}`);
    const exitCode = await deps
      .spawnAgent([spec.path, ...deps.agentArgs], { cwd: worktree, env: { ...deps.env, INIT_CWD: worktree }, onLine: (line) => log(`${prefix}${line}`) })
      .catch((error: unknown) => {
        log(`${prefix}Could not run: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      });
    const kept = exitCode !== 0 && exitCode !== 3;
    if (exitCode === 0) {
      result.succeeded.push(spec.path);
      await removeWorktree(git, worktree, log, false);
    } else if (exitCode === 3) {
      // The worktree holds no work, and the local branch points at the base commit.
      result.lostClaim.push(spec.path);
      log(`${prefix}Another run claimed it first; removing ${worktree}.`);
      await removeWorktree(git, worktree, log, true);
      await git(["branch", "-D", `agent/${spec.slug}`]).catch((error: unknown) =>
        log(`⚠️ Could not delete the local branch agent/${spec.slug}: ${error instanceof Error ? error.message : String(error)}`),
      );
    } else {
      result.failed.push({ spec: spec.path, worktree, exitCode });
      log(`${prefix}Failed (exit ${exitCode}). Kept ${worktree} for inspection.`);
    }
    runLog?.event({ type: "local.end", spec: spec.path, worktree, exitCode, kept });
  });
  await Promise.all(runs);
  return result;
}

async function removeWorktree(git: (args: string[]) => Promise<string>, worktree: string, log: (line: string) => void, force: boolean): Promise<void> {
  try {
    await git(["worktree", "remove", ...(force ? ["--force"] : []), worktree]);
  } catch (error) {
    log(`⚠️ Could not remove the worktree; remove ${worktree} by hand: ${error instanceof Error ? error.message : String(error)}`);
  }
}
