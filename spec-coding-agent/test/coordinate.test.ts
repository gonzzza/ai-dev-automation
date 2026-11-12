import { describe, expect, it } from "vitest";
import {
  formatPlanned,
  planSpecs,
  runCoordinator,
  type GithubState,
  type PlannedSpec,
  type PullSummary,
  type RunSummary,
} from "../src/coordinate.js";
import type { Exec, ExecResult } from "../src/exec.js";
import type { RunEvent, RunLog } from "../src/runlog.js";
import { parseSpec, type Spec } from "../src/spec.js";

function spec(number: number, deps: number[] = [], name = "feature"): Spec {
  const padded = String(number).padStart(3, "0");
  const frontmatter = deps.length ? `---\ndepends_on: [${deps.join(", ")}]\n---\n` : "";
  return parseSpec(`specs/${padded}-${name}.md`, `${frontmatter}# Spec ${padded}\n\n## Goal\nx\n\n## Requirements\nx\n\n## Acceptance criteria\n- AC1: x\n`);
}

const pr = (number: number, title: string, state: PullSummary["state"], mergedAt: string | null = null): PullSummary => ({ number, title, state, mergedAt });
const runOf = (id: number, title: string, status: string, conclusion: string | null, createdAt = "2026-11-10T10:00:00Z"): RunSummary => ({
  id,
  title,
  status,
  conclusion,
  createdAt,
});
const github = (state: Partial<GithubState> = {}): GithubState => ({ pulls: [], branches: [], runs: [], ...state });
const stateOf = (s: Spec, g: GithubState) => planSpecs([s], g)[0]!.state;

describe("planSpecs", () => {
  const s4 = spec(4, [], "agent-pr-template");
  const title = "SPEC-004 Follow the PR template";

  it("AC3: an open PR wins over a merged one, with the lowest open number", () => {
    const g = github({ pulls: [pr(30, title, "MERGED", "2026-11-01T00:00:00Z"), pr(41, title, "OPEN"), pr(40, title, "OPEN")] });
    expect(stateOf(s4, g)).toEqual({ status: "in-progress", pr: 40 });
  });

  it("AC3: a merged PR gives done, with the latest merged PR", () => {
    const g = github({ pulls: [pr(33, title, "MERGED", "2026-11-02T00:00:00Z"), pr(31, title, "MERGED", "2026-11-01T00:00:00Z")] });
    expect(stateOf(s4, g)).toEqual({ status: "done", pr: 33 });
  });

  it("AC3: a later merged revert gives needs-human / reverted", () => {
    const g = github({
      pulls: [pr(33, title, "MERGED", "2026-11-02T00:00:00Z"), pr(41, `Revert "${title}"`, "MERGED", "2026-11-03T00:00:00Z")],
    });
    expect(stateOf(s4, g)).toEqual({ status: "needs-human", reason: "reverted", pr: 41 });
  });

  it("AC3: a revert merged before the latest merge still gives done", () => {
    const g = github({
      pulls: [
        pr(33, title, "MERGED", "2026-11-02T00:00:00Z"),
        pr(41, `Revert "${title}"`, "MERGED", "2026-11-03T00:00:00Z"),
        pr(45, title, "MERGED", "2026-11-04T00:00:00Z"),
        pr(46, `Revert "${title}"`, "OPEN"),
      ],
    });
    expect(stateOf(s4, g)).toEqual({ status: "done", pr: 45 });
  });

  it("AC3: an in-flight run gives in-progress, even with a closed PR", () => {
    const g = github({ pulls: [pr(40, title, "CLOSED")], runs: [runOf(7, `Implement ${s4.path}`, "in_progress", null)] });
    expect(stateOf(s4, g)).toEqual({ status: "in-progress", run: true });
  });

  it("AC3: a closed, unmerged PR gives needs-human / closed, even when its branch still exists", () => {
    const g = github({ pulls: [pr(38, title, "CLOSED"), pr(40, title, "CLOSED")], branches: [`agent/${s4.slug}`] });
    expect(stateOf(s4, g)).toEqual({ status: "needs-human", reason: "closed", pr: 40 });
  });

  it.each(["failure", "cancelled"])("AC3: a most recent run concluded %s gives needs-human / failed, even with the branch", (conclusion) => {
    const g = github({
      branches: [`agent/${s4.slug}`],
      runs: [runOf(1, `Implement ${s4.path}`, "completed", "success", "2026-11-01T00:00:00Z"), runOf(2, `Implement ${s4.path}`, "completed", conclusion, "2026-11-02T00:00:00Z")],
    });
    expect(stateOf(s4, g)).toEqual({ status: "needs-human", reason: "failed", conclusion });
  });

  it("AC3: a most recent run concluded success with no PR gives needs-human / no-pr, despite an older failure", () => {
    const g = github({
      runs: [runOf(2, `Implement ${s4.path}`, "completed", "success", "2026-11-02T00:00:00Z"), runOf(1, `Implement ${s4.path}`, "completed", "failure", "2026-11-01T00:00:00Z")],
    });
    expect(stateOf(s4, g)).toEqual({ status: "needs-human", reason: "no-pr" });
  });

  it.each(["agent", "spec"])("AC3: a %s/<slug> branch with no PR and no completed run gives in-progress", (prefix) => {
    expect(stateOf(s4, github({ branches: [`${prefix}/${s4.slug}`] }))).toEqual({ status: "in-progress", branch: `${prefix}/${s4.slug}` });
  });

  it("AC3: dry runs and runs titled 'Implement a spec' affect no spec", () => {
    const g = github({
      runs: [
        runOf(1, `Implement ${s4.path} (dry run)`, "in_progress", null),
        runOf(2, `Implement ${s4.path} (dry run)`, "completed", "failure"),
        runOf(3, "Implement a spec", "completed", "failure"),
      ],
    });
    expect(stateOf(s4, g)).toEqual({ status: "ready" });
  });

  it("AC3: SPEC-004 and SPEC-4 match spec 4; SPEC-0040 and XSPEC-004 don't", () => {
    expect(stateOf(s4, github({ pulls: [pr(1, "SPEC-004 x", "MERGED", "2026-11-01T00:00:00Z")] }))).toEqual({ status: "done", pr: 1 });
    expect(stateOf(s4, github({ pulls: [pr(2, "SPEC-4 x", "MERGED", "2026-11-01T00:00:00Z")] }))).toEqual({ status: "done", pr: 2 });
    expect(stateOf(s4, github({ pulls: [pr(3, "SPEC-0040 x", "OPEN"), pr(4, "XSPEC-004 x", "OPEN")] }))).toEqual({ status: "ready" });
  });

  it("AC4: ready only when every dependency is done; blocked lists the rest in ascending order; sorted by number", () => {
    const specs = [spec(9, [6, 5, 1, 2, 3], "all"), spec(1, [], "a"), spec(2, [], "b"), spec(3, [], "c"), spec(5, [], "e"), spec(6, [5], "f"), spec(7, [1], "g")];
    const g = github({
      pulls: [pr(10, "SPEC-001 a", "MERGED", "2026-11-01T00:00:00Z"), pr(11, "SPEC-002 b", "OPEN"), pr(12, "SPEC-003 c", "CLOSED")],
    });
    const plan = planSpecs(specs, g);
    expect(plan.map((p) => p.number)).toEqual([1, 2, 3, 5, 6, 7, 9]);
    expect(plan.map((p) => p.state)).toEqual([
      { status: "done", pr: 10 },
      { status: "in-progress", pr: 11 },
      { status: "needs-human", reason: "closed", pr: 12 },
      { status: "ready" },
      { status: "blocked", waitingOn: [5] },
      { status: "ready" },
      // in-progress (2), needs-human (3), ready (5) and blocked (6) all count as unfinished.
      { status: "blocked", waitingOn: [2, 3, 5, 6] },
    ]);
    expect(plan[0]).toEqual({ number: 1, path: "specs/001-a.md", slug: "001-a", state: { status: "done", pr: 10 } });
  });
});

/** A fake Exec answering by command line. A function answer sees how often that line has run. */
type Answer = ExecResult | ((call: number) => ExecResult);
function fakeExec(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const exec: Exec = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const count = (counts.get(line) ?? 0) + 1;
    counts.set(line, count);
    const answer = answers[line];
    if (answer === undefined) return { code: 1, stdout: "", stderr: `unexpected command: ${line}` };
    return typeof answer === "function" ? answer(count) : answer;
  };
  return { exec, calls };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const PULLS = 'gh api --paginate repos/{owner}/{repo}/pulls?state=all&base=main&per_page=100 --jq .[] | {number, title, state, merged_at}';
const BRANCHES = "git ls-remote --heads origin refs/heads/agent/* refs/heads/spec/*";
const RUNS = "gh run list --workflow implement-spec.yml --limit 200 --json databaseId,displayTitle,status,conclusion,createdAt";
const dispatchCmd = (path: string) => `gh workflow run implement-spec.yml --ref main -f spec=${path}`;
const runsJson = (runs: { databaseId: number; displayTitle: string; status: string; conclusion: string | null }[]) =>
  ok(JSON.stringify(runs.map((r) => ({ createdAt: "2026-11-10T10:00:00Z", ...r }))));

const CLEAN_CHECKOUT = {
  "git fetch origin main": ok(""),
  "git rev-parse HEAD": ok("abc123\n"),
  "git rev-parse origin/main": ok("abc123\n"),
  "git status --porcelain -- specs/": ok(""),
};

function memoryLog(): RunLog & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { runId: "test", events, event: (e) => void events.push(e) };
}

const specs = [spec(1, [], "a"), spec(2, [], "b"), spec(3, [], "c"), spec(4, [1], "d")];
const base = { specs, repoRoot: "/repo", maxParallel: 2, log: () => {}, sleep: async () => {} };

describe("runCoordinator reading GitHub", () => {
  it("AC5: runs exactly the three read commands and builds the state from every page", async () => {
    const { exec, calls } = fakeExec({
      // Two pages from --paginate, one object per line.
      [PULLS]: ok(
        [
          '{"number":10,"title":"SPEC-001 a","state":"closed","merged_at":"2026-11-01T00:00:00Z"}',
          '{"number":11,"title":"SPEC-002 b","state":"open","merged_at":null}',
          '{"number":12,"title":"SPEC-003 c","state":"closed","merged_at":null}',
          "",
        ].join("\n"),
      ),
      [BRANCHES]: ok("deadbeef\trefs/heads/agent/004-d\n"),
      [RUNS]: runsJson([]),
    });
    const lines: string[] = [];
    const result = await runCoordinator({ ...base, exec, log: (l) => lines.push(l) });
    expect(calls).toEqual([PULLS, BRANCHES, RUNS]);
    expect(result.plan.map((p) => p.state)).toEqual([
      { status: "done", pr: 10 },
      { status: "in-progress", pr: 11 },
      { status: "needs-human", reason: "closed", pr: 12 },
      { status: "in-progress", branch: "agent/004-d" },
    ]);
    expect(result).toMatchObject({ dispatched: [], inFlightRuns: 0 });
    expect(lines).toEqual(["001 done (#10)", "002 in-progress (#11)", "003 needs-human: closed (#12)", "004 in-progress (agent/004-d)"]);
  });

  it("AC5: maps runs from gh run list", async () => {
    const { exec } = fakeExec({
      [PULLS]: ok(""),
      [BRANCHES]: ok(""),
      [RUNS]: runsJson([{ databaseId: 5, displayTitle: "Implement specs/001-a.md", status: "queued", conclusion: null }]),
    });
    const result = await runCoordinator({ ...base, exec });
    expect(result.plan[0]!.state).toEqual({ status: "in-progress", run: true });
    expect(result.inFlightRuns).toBe(1);
  });

  it.each([PULLS, BRANCHES, RUNS])("AC5: throws with the output when a read command fails: %s", async (failing) => {
    const answers: Record<string, Answer> = { [PULLS]: ok(""), [BRANCHES]: ok(""), [RUNS]: runsJson([]) };
    answers[failing] = { code: 4, stdout: "", stderr: "HTTP 401" };
    const { exec } = fakeExec(answers);
    await expect(runCoordinator({ ...base, exec })).rejects.toThrow(/HTTP 401/);
  });

  it("AC5: with dispatch false, never fetches or dispatches", async () => {
    const { exec, calls } = fakeExec({ [PULLS]: ok(""), [BRANCHES]: ok(""), [RUNS]: runsJson([]) });
    await runCoordinator({ ...base, exec, dispatch: false });
    expect(calls.some((c) => c.startsWith("git fetch") || c.startsWith("gh workflow run"))).toBe(false);
  });

  it("rejects a maxParallel that isn't a positive integer", async () => {
    const { exec } = fakeExec({});
    await expect(runCoordinator({ ...base, exec, maxParallel: 0 })).rejects.toThrow(RangeError);
  });
});

describe("runCoordinator dispatching", () => {
  const reads = (runs: Answer = runsJson([])) => ({ ...CLEAN_CHECKOUT, [PULLS]: ok(""), [BRANCHES]: ok(""), [RUNS]: runs });
  const newRuns = (paths: string[], startId = 100) =>
    runsJson(paths.map((p, i) => ({ databaseId: startId + i, displayTitle: `Implement ${p}`, status: "queued", conclusion: null })));

  it("AC6: dispatches ready specs lowest number first, at most maxParallel, with the exact arguments", async () => {
    const { exec, calls } = fakeExec({
      ...reads((call) => (call === 1 ? runsJson([]) : newRuns(["specs/001-a.md", "specs/002-b.md"]))),
      [dispatchCmd("specs/001-a.md")]: ok(""),
      [dispatchCmd("specs/002-b.md")]: ok(""),
    });
    const result = await runCoordinator({ ...base, exec, dispatch: true });
    expect(result.dispatched).toEqual(["specs/001-a.md", "specs/002-b.md"]);
    expect(calls.filter((c) => c.startsWith("gh workflow run"))).toEqual([dispatchCmd("specs/001-a.md"), dispatchCmd("specs/002-b.md")]);
  });

  it("AC6: dispatches nothing while any run of the workflow is in flight, dry runs included", async () => {
    const { exec, calls } = fakeExec(reads(runsJson([{ databaseId: 1, displayTitle: "Implement specs/009-z.md (dry run)", status: "in_progress", conclusion: null }])));
    const lines: string[] = [];
    const result = await runCoordinator({ ...base, exec, dispatch: true, log: (l) => lines.push(l) });
    expect(result).toMatchObject({ dispatched: [], inFlightRuns: 1 });
    expect(calls.some((c) => c.startsWith("gh workflow run"))).toBe(false);
    expect(lines.at(-1)).toMatch(/Waiting on 1 implement-spec\.yml run/);
  });

  it("AC6: fetches origin main before comparing", async () => {
    const { exec, calls } = fakeExec({ ...reads(), [dispatchCmd("specs/001-a.md")]: ok(""), [dispatchCmd("specs/002-b.md")]: ok("") });
    await runCoordinator({ ...base, exec, dispatch: true }).catch(() => {});
    expect(calls.slice(0, 2)).toEqual(["git fetch origin main", "git rev-parse HEAD"]);
  });

  it("AC6: throws before dispatching when HEAD isn't origin/main", async () => {
    const { exec, calls } = fakeExec({ ...reads(), "git rev-parse origin/main": ok("fff999\n") });
    await expect(runCoordinator({ ...base, exec, dispatch: true })).rejects.toThrow(/HEAD is at abc123, but origin\/main is at fff999/);
    expect(calls.some((c) => c.startsWith("gh workflow run"))).toBe(false);
  });

  it("AC6: throws before dispatching when a file under specs/ has uncommitted changes", async () => {
    const { exec, calls } = fakeExec({ ...reads(), "git status --porcelain -- specs/": ok(" M specs/001-a.md\n") });
    await expect(runCoordinator({ ...base, exec, dispatch: true })).rejects.toThrow(/not clean under specs\/[\s\S]*specs\/001-a\.md/);
    expect(calls.some((c) => c.startsWith("gh workflow run"))).toBe(false);
  });

  it("AC6: when the second of three dispatches fails, names the first and doesn't attempt the third", async () => {
    const { exec, calls } = fakeExec({
      ...reads(),
      [dispatchCmd("specs/001-a.md")]: ok(""),
      [dispatchCmd("specs/002-b.md")]: { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" },
      [dispatchCmd("specs/003-c.md")]: ok(""),
    });
    const error = await runCoordinator({ ...base, exec, dispatch: true, maxParallel: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Dispatching specs\/002-b\.md failed\. Already dispatched: specs\/001-a\.md\.[\s\S]*HTTP 403/);
    expect(calls).not.toContain(dispatchCmd("specs/003-c.md"));
  });

  it("AC6: re-lists runs through sleep until each dispatched spec has a new run; an already failed one counts", async () => {
    const failed = { databaseId: 101, displayTitle: "Implement specs/001-a.md", status: "completed", conclusion: "failure" };
    const queued = { databaseId: 102, displayTitle: "Implement specs/002-b.md", status: "queued", conclusion: null };
    const sleeps: number[] = [];
    const { exec, calls } = fakeExec({
      // The read before dispatching, a poll with spec 1's run (already failed), then one with both.
      ...reads((call) => (call === 1 ? runsJson([]) : call === 2 ? runsJson([failed]) : runsJson([failed, queued]))),
      [dispatchCmd("specs/001-a.md")]: ok(""),
      [dispatchCmd("specs/002-b.md")]: ok(""),
    });
    const result = await runCoordinator({ ...base, exec, dispatch: true, sleep: async (ms) => void sleeps.push(ms) });
    expect(result.dispatched).toEqual(["specs/001-a.md", "specs/002-b.md"]);
    expect(sleeps).toEqual([5000, 5000]);
    expect(calls.filter((c) => c === RUNS)).toHaveLength(3);
  });

  it("AC6: ignores a run of the spec whose id was listed before dispatching", async () => {
    const before = { databaseId: 50, displayTitle: "Implement specs/001-a.md (dry run)", status: "completed", conclusion: "success" };
    const sameId = { databaseId: 50, displayTitle: "Implement specs/001-a.md", status: "completed", conclusion: "failure" };
    const sleeps: number[] = [];
    const { exec } = fakeExec({
      ...reads((call) => (call === 1 ? runsJson([before]) : call === 2 ? runsJson([sameId]) : newRuns(["specs/001-a.md"]))),
      [dispatchCmd("specs/001-a.md")]: ok(""),
    });
    const result = await runCoordinator({ ...base, specs: [spec(1, [], "a")], exec, dispatch: true, sleep: async (ms) => void sleeps.push(ms) });
    expect(result.dispatched).toEqual(["specs/001-a.md"]);
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("AC6: throws naming the missing specs after 60 seconds of fake time with no new run", async () => {
    let fakeMs = 0;
    const { exec } = fakeExec({
      ...reads((call) => (call === 1 ? runsJson([]) : newRuns(["specs/001-a.md"]))),
      [dispatchCmd("specs/001-a.md")]: ok(""),
      [dispatchCmd("specs/002-b.md")]: ok(""),
    });
    const error = await runCoordinator({ ...base, exec, dispatch: true, sleep: async (ms) => void (fakeMs += ms) }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/no new implement-spec\.yml run after 60s for: specs\/002-b\.md$/);
    expect(fakeMs).toBe(60_000);
  });
});

describe("runCoordinator logging", () => {
  it("AC7: logs one plan.result event and one dispatch event per dispatched spec", async () => {
    const runLog = memoryLog();
    const { exec } = fakeExec({
      ...CLEAN_CHECKOUT,
      [PULLS]: ok(""),
      [BRANCHES]: ok(""),
      [RUNS]: (call) =>
        call === 1
          ? runsJson([])
          : runsJson([
              { databaseId: 1, displayTitle: "Implement specs/001-a.md", status: "queued", conclusion: null },
              { databaseId: 2, displayTitle: "Implement specs/002-b.md", status: "queued", conclusion: null },
            ]),
      [dispatchCmd("specs/001-a.md")]: ok(""),
      [dispatchCmd("specs/002-b.md")]: ok(""),
    });
    const result = await runCoordinator({ ...base, exec, dispatch: true, runLog });
    expect(runLog.events).toEqual([
      { type: "plan.result", plan: result.plan },
      { type: "dispatch", spec: "specs/001-a.md" },
      { type: "dispatch", spec: "specs/002-b.md" },
    ]);
  });

  it("AC7: formats each state's line", () => {
    const line = (number: number, state: PlannedSpec["state"]) => formatPlanned({ number, path: "", slug: "", state });
    expect([
      line(1, { status: "done", pr: 33 }),
      line(1, { status: "in-progress", branch: "agent/001-rate-limiter" }),
      line(2, { status: "in-progress", run: true }),
      line(3, { status: "in-progress", pr: 12 }),
      line(6, { status: "blocked", waitingOn: [5] }),
      line(4, { status: "needs-human", reason: "reverted", pr: 41 }),
      line(4, { status: "needs-human", reason: "closed", pr: 40 }),
      line(4, { status: "needs-human", reason: "failed", conclusion: "failure" }),
      line(4, { status: "needs-human", reason: "no-pr" }),
      line(7, { status: "ready" }),
    ]).toEqual([
      "001 done (#33)",
      "001 in-progress (agent/001-rate-limiter)",
      "002 in-progress (run)",
      "003 in-progress (#12)",
      "006 blocked: waiting on 005",
      "004 needs-human: reverted (#41)",
      "004 needs-human: closed (#40)",
      "004 needs-human: failed (failure)",
      "004 needs-human: no-pr",
      "007 ready",
    ]);
  });
});
