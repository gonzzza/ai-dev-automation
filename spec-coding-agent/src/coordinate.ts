import { z } from "zod";
import { run, type Exec } from "./exec.js";
import type { RunLog } from "./runlog.js";
import { padSpecNumber, specNumber, type Spec } from "./spec.js";

// The coordinator works out which specs are ready and dispatches one CI agent run for each. GitHub
// (pull requests, branches and workflow runs) is the only shared state: no claim store, no
// agent-to-agent messages. Anything unexpected goes to a human; nothing is retried automatically.

export interface PullSummary {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
}

export interface RunSummary {
  id: number;
  title: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}

export interface GithubState {
  pulls: readonly PullSummary[];
  branches: readonly string[];
  runs: readonly RunSummary[];
}

export type SpecState =
  | { status: "done"; pr: number }
  | { status: "in-progress"; pr?: number; branch?: string; run?: true }
  | { status: "needs-human"; reason: "closed" | "reverted"; pr: number }
  | { status: "needs-human"; reason: "failed"; conclusion: string }
  | { status: "needs-human"; reason: "no-pr" }
  /** A local wave kept this spec's worktree after its run failed. */
  | { status: "needs-human"; reason: "local-worktree"; worktree: string }
  | { status: "blocked"; waitingOn: number[] }
  | { status: "ready" };

export interface PlannedSpec {
  number: number;
  path: string;
  slug: string;
  state: SpecState;
}

/** The workflow the coordinator dispatches and watches. */
export const WORKFLOW = "implement-spec.yml";

/** The title `implement-spec.yml` gives a (non-dry) run for a spec, through its `run-name`. */
export function runTitle(specPath: string): string {
  return `Implement ${specPath}`;
}

/** The spec number a PR title claims, from the agent's and session mode's "SPEC-<n> <title>" format. */
function pullSpec(title: string): number | undefined {
  const digits = /^SPEC-(\d+) /.exec(title)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/** The spec number a revert PR undoes, from GitHub's revert button title `Revert "SPEC-<n> …"`. */
function revertSpec(title: string): number | undefined {
  const digits = /^Revert "SPEC-(\d+) /.exec(title)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

const byMergedAt = (a: PullSummary, b: PullSummary) => Date.parse(a.mergedAt ?? "") - Date.parse(b.mergedAt ?? "");

/** Rules 1 to 6 of the plan: every state that comes from GitHub alone, before dependencies. */
function githubState(spec: Spec, number: number, github: GithubState): SpecState | undefined {
  const pulls = github.pulls.filter((p) => pullSpec(p.title) === number);
  const open = pulls.filter((p) => p.state === "OPEN").map((p) => p.number);
  if (open.length) return { status: "in-progress", pr: Math.min(...open) };

  const merged = pulls.filter((p) => p.state === "MERGED").sort(byMergedAt);
  const latest = merged.at(-1);
  if (latest) {
    const revert = github.pulls
      .filter((p) => p.state === "MERGED" && revertSpec(p.title) === number)
      .sort(byMergedAt)
      .at(-1);
    if (revert && byMergedAt(revert, latest) > 0) return { status: "needs-human", reason: "reverted", pr: revert.number };
    return { status: "done", pr: latest.number };
  }

  const runs = github.runs.filter((r) => r.title === runTitle(spec.path));
  if (runs.some((r) => r.status !== "completed")) return { status: "in-progress", run: true };

  const closed = pulls.filter((p) => p.state === "CLOSED").map((p) => p.number);
  if (closed.length) return { status: "needs-human", reason: "closed", pr: Math.max(...closed) };

  const last = [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
  if (last) {
    if (last.conclusion === "success") return { status: "needs-human", reason: "no-pr" };
    return { status: "needs-human", reason: "failed", conclusion: last.conclusion ?? "unknown" };
  }

  const branch = [`agent/${spec.slug}`, `spec/${spec.slug}`].find((b) => github.branches.includes(b));
  if (branch) return { status: "in-progress", branch };
  return undefined;
}

/**
 * Decides each spec's state from GitHub, by the first rule that applies, then marks the rest
 * `ready` when every dependency is `done` and `blocked` otherwise. Pure: the caller reads GitHub.
 * Returns the specs sorted by number.
 */
export function planSpecs(specs: readonly Spec[], github: GithubState): PlannedSpec[] {
  const numbered = specs.map((spec) => {
    const number = specNumber(spec.slug);
    if (number === undefined) throw new Error(`${spec.path}: file name must start with a number to be planned`);
    return { spec, number, state: githubState(spec, number, github) };
  });
  const done = new Set(numbered.filter((s) => s.state?.status === "done").map((s) => s.number));
  return numbered
    .map(({ spec, number, state }): PlannedSpec => {
      const waitingOn = spec.dependsOn.filter((d) => !done.has(d)).sort((a, b) => a - b);
      const resolved: SpecState = state ?? (waitingOn.length ? { status: "blocked", waitingOn } : { status: "ready" });
      return { number, path: spec.path, slug: spec.slug, state: resolved };
    })
    .sort((a, b) => a.number - b.number);
}

/** One line per spec, e.g. `005 blocked: waiting on 004` or `001 done (#33)`. */
export function formatPlanned({ number, state }: PlannedSpec): string {
  const detail = ((): string => {
    switch (state.status) {
      case "done":
        return `done (#${state.pr})`;
      case "in-progress":
        if (state.pr !== undefined) return `in-progress (#${state.pr})`;
        if (state.branch !== undefined) return `in-progress (${state.branch})`;
        return "in-progress (run)";
      case "needs-human":
        if (state.reason === "failed") return `needs-human: failed (${state.conclusion})`;
        if (state.reason === "no-pr") return "needs-human: no-pr";
        if (state.reason === "local-worktree") return `needs-human: local-worktree (${state.worktree})`;
        return `needs-human: ${state.reason} (#${state.pr})`;
      case "blocked":
        return `blocked: waiting on ${state.waitingOn.map(padSpecNumber).join(", ")}`;
      case "ready":
        return "ready";
    }
  })();
  return `${padSpecNumber(number)} ${detail}`;
}

// The exact read commands. Matching happens on the titles in code, so the PR list has no search
// tokenizing and no result cap.
const PULLS_ARGS = ["api", "--paginate", "repos/{owner}/{repo}/pulls?state=all&base=main&per_page=100", "--jq", ".[] | {number, title, state, merged_at}"];
const BRANCHES_ARGS = ["ls-remote", "--heads", "origin", "refs/heads/agent/*", "refs/heads/spec/*"];
const RUNS_ARGS = ["run", "list", "--workflow", WORKFLOW, "--limit", "200", "--json", "databaseId,displayTitle,status,conclusion,createdAt"];

const PullLine = z.object({ number: z.number().int(), title: z.string(), state: z.string(), merged_at: z.string().nullable() });
const RunList = z.array(
  z.object({ databaseId: z.number().int(), displayTitle: z.string(), status: z.string(), conclusion: z.string().nullable(), createdAt: z.string() }),
);

/** Parses the `gh api --paginate --jq` output: one JSON object per line, across every page. */
export function parsePulls(stdout: string): PullSummary[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const p = PullLine.parse(JSON.parse(line));
      const state = p.merged_at ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED";
      return { number: p.number, title: p.title, state, mergedAt: p.merged_at };
    });
}

/** Branch names from `git ls-remote --heads`, without `refs/heads/`. */
export function parseBranches(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => /\trefs\/heads\/(.+)$/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Parses `gh run list --json databaseId,displayTitle,status,conclusion,createdAt`. */
export function parseRuns(stdout: string): RunSummary[] {
  return RunList.parse(JSON.parse(stdout || "[]")).map((r) => ({
    id: r.databaseId,
    title: r.displayTitle,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.createdAt,
  }));
}

/** The three reads every plan is made from: PRs against main, agent/spec branches on origin, and runs. */
export async function readGithubState(exec: Exec, repoRoot: string): Promise<GithubState> {
  const sh = (command: string, args: string[]) => run(exec, command, args, repoRoot);
  return {
    pulls: parsePulls(await sh("gh", PULLS_ARGS)),
    branches: parseBranches(await sh("git", BRANCHES_ARGS)),
    runs: parseRuns(await sh("gh", RUNS_ARGS)),
  };
}

/**
 * Throws unless HEAD is origin/main, after a fetch, with nothing uncommitted under specs/. Runs
 * started from a plan, in CI or in local worktrees, implement the specs as they are on main.
 */
export async function checkMainCheckout(exec: Exec, repoRoot: string): Promise<void> {
  const sh = (command: string, args: string[]) => run(exec, command, args, repoRoot);
  await sh("git", ["fetch", "origin", "main"]);
  const [head, main] = [await sh("git", ["rev-parse", "HEAD"]), await sh("git", ["rev-parse", "origin/main"])];
  if (head !== main) throw new Error(`Local HEAD is at ${head}, but origin/main is at ${main}. Start from an up-to-date main.`);
  const dirty = await sh("git", ["status", "--porcelain", "--", "specs/"]);
  if (dirty) throw new Error(`Working tree is not clean under specs/; runs use the specs on main:
${dirty}`);
}

export interface CoordinatorDeps {
  specs: readonly Spec[];
  exec: Exec;
  repoRoot: string;
  /** Start runs for ready specs. Default false: plan only. */
  dispatch?: boolean;
  /** Most runs to start in one wave. */
  maxParallel: number;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  runLog?: RunLog;
}

export interface CoordinatorResult {
  plan: PlannedSpec[];
  dispatched: string[];
  inFlightRuns: number;
}

const POLL_MS = 5_000;
const POLL_LIMIT_MS = 60_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Plans every spec from GitHub's state and, with `dispatch`, starts one *Implement a spec* run for
 * each ready spec, up to `maxParallel`, lowest number first. Dispatches one wave at a time: nothing
 * while any run of the workflow is in flight. Returns once GitHub lists a new run for every spec it
 * dispatched, so the next pass sees them.
 */
export async function runCoordinator(deps: CoordinatorDeps): Promise<CoordinatorResult> {
  const { specs, exec, repoRoot, dispatch = false, maxParallel, log, sleep = defaultSleep, runLog } = deps;
  if (!Number.isInteger(maxParallel) || maxParallel <= 0) throw new RangeError(`maxParallel must be a positive integer; got ${maxParallel}`);

  // The workflow implements each spec as it is on main, so the local plan must be made from main.
  if (dispatch) await checkMainCheckout(exec, repoRoot);

  const github = await readGithubState(exec, repoRoot);
  const plan = planSpecs(specs, github);
  for (const planned of plan) log(formatPlanned(planned));
  runLog?.event({ type: "plan.result", plan });

  const inFlightRuns = github.runs.filter((r) => r.status !== "completed").length;
  const dispatched: string[] = [];
  if (!dispatch) return { plan, dispatched, inFlightRuns };
  if (inFlightRuns > 0) {
    log(`Waiting on ${inFlightRuns} ${WORKFLOW} run(s) in flight; dispatching nothing.`);
    return { plan, dispatched, inFlightRuns };
  }

  for (const { path } of plan.filter((p) => p.state.status === "ready").slice(0, maxParallel)) {
    try {
      await run(exec, "gh", ["workflow", "run", WORKFLOW, "--ref", "main", "-f", `spec=${path}`], repoRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Dispatching ${path} failed. Already dispatched: ${dispatched.join(", ") || "none"}.\n${message}`, { cause: error });
    }
    dispatched.push(path);
    runLog?.event({ type: "dispatch", spec: path });
    log(`Dispatched ${path}`);
  }

  // gh workflow run returns before GitHub lists the run. Wait for a run with an id that wasn't there
  // before, in flight or already finished, so the next pass sees every spec this one dispatched.
  // Ids, not createdAt, so a skewed local clock can't matter.
  const known = new Set(github.runs.map((r) => r.id));
  let missing = dispatched;
  for (let waited = 0; missing.length && waited < POLL_LIMIT_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    const runs = parseRuns(await run(exec, "gh", RUNS_ARGS, repoRoot));
    missing = missing.filter((path) => !runs.some((r) => r.title === runTitle(path) && !known.has(r.id)));
  }
  if (missing.length) {
    throw new Error(`GitHub listed no new ${WORKFLOW} run after ${POLL_LIMIT_MS / 1000}s for: ${missing.join(", ")}`);
  }
  return { plan, dispatched, inFlightRuns };
}
