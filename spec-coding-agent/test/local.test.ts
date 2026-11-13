import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPlanned, type PlannedSpec, type SpecState } from "../src/coordinate.js";
import type { Exec, ExecResult } from "../src/exec.js";
import { applyLocalWorktrees, childExitCode, cmdArg, parseWorktreeList, runLocalWave, spawnLines, type LocalWaveDeps, type SpawnAgent } from "../src/local.js";
import type { RunEvent, RunLog } from "../src/runlog.js";
import { parseSpec, type Spec } from "../src/spec.js";

const planned = (number: number, state: SpecState): PlannedSpec => {
  const slug = `${String(number).padStart(3, "0")}-x`;
  return { number, path: `specs/${slug}.md`, slug, state };
};

describe("applyLocalWorktrees", () => {
  const dir = "C:\\Users\\Me\\repo-worktrees";

  it("AC4: marks a ready spec and an in-progress spec with only a branch whose worktree is listed", () => {
    const plan = [planned(1, { status: "ready" }), planned(2, { status: "in-progress", branch: "agent/002-x" })];
    const listed = ["C:/Users/Me/repo", "C:/Users/Me/repo-worktrees/001-x", "C:/Users/Me/repo-worktrees/002-x"];
    expect(applyLocalWorktrees(plan, listed, dir, "win32").map((p) => p.state)).toEqual([
      { status: "needs-human", reason: "local-worktree", worktree: "C:\\Users\\Me\\repo-worktrees\\001-x" },
      { status: "needs-human", reason: "local-worktree", worktree: "C:\\Users\\Me\\repo-worktrees\\002-x" },
    ]);
  });

  it("AC4: on win32, forward slashes and a different letter case, drive letter included, still match", () => {
    const plan = [planned(1, { status: "ready" })];
    expect(applyLocalWorktrees(plan, ["c:/users/me/REPO-WORKTREES/001-x"], dir, "win32")[0]!.state).toMatchObject({ reason: "local-worktree" });
    expect(applyLocalWorktrees(plan, ["C:\\Users\\Me\\repo-worktrees\\001-x\\"], dir.toLowerCase(), "win32")[0]!.state).toMatchObject({
      reason: "local-worktree",
    });
  });

  it("AC4: on linux, paths that differ only in case don't match", () => {
    const plan = [planned(1, { status: "ready" })];
    expect(applyLocalWorktrees(plan, ["/home/me/Repo-worktrees/001-x"], "/home/me/repo-worktrees", "linux")[0]!.state).toEqual({ status: "ready" });
    expect(applyLocalWorktrees(plan, ["/home/me/repo-worktrees/001-x"], "/home/me/repo-worktrees", "linux")[0]!.state).toEqual({
      status: "needs-human",
      reason: "local-worktree",
      worktree: "/home/me/repo-worktrees/001-x",
    });
  });

  it("AC4: leaves an open PR, a merged PR, an in-flight run and a spec with no worktree unchanged", () => {
    const plan = [
      planned(1, { status: "in-progress", pr: 40 }),
      planned(2, { status: "done", pr: 33 }),
      planned(3, { status: "in-progress", run: true }),
      planned(4, { status: "ready" }),
      planned(5, { status: "blocked", waitingOn: [4] }),
    ];
    const listed = ["001-x", "002-x", "003-x", "005-x"].map((slug) => `/wt/${slug}`);
    expect(applyLocalWorktrees(plan, listed, "/wt", "linux")).toEqual(plan);
  });

  it("AC4: formatPlanned prints the new state with its path", () => {
    const state: SpecState = { status: "needs-human", reason: "local-worktree", worktree: "/wt/006-x" };
    expect(formatPlanned(planned(6, state))).toBe("006 needs-human: local-worktree (/wt/006-x)");
  });

  it("AC4: parses the worktree paths of git worktree list --porcelain", () => {
    const out = "worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo-worktrees/001-x\nHEAD def\ndetached\n";
    expect(parseWorktreeList(out)).toEqual(["C:/repo", "C:/repo-worktrees/001-x"]);
  });
});

describe("childExitCode", () => {
  it("AC7: returns the code, and 1 for a child killed by a signal", () => {
    expect(childExitCode(0, null)).toBe(0);
    expect(childExitCode(1, null)).toBe(1);
    expect(childExitCode(null, "SIGTERM")).toBe(1);
    expect(childExitCode(null, "SIGKILL")).toBe(1);
  });
});

describe("cmdArg", () => {
  it("leaves plain arguments alone and quotes ones with spaces or shell characters", () => {
    expect(cmdArg("--scope")).toBe("--scope");
    expect(cmdArg("C:\\Users\\me\\runs")).toBe("C:\\Users\\me\\runs");
    expect(cmdArg("C:\\Users\\Jo Smith\\runs")).toBe('"C:\\Users\\Jo Smith\\runs"');
    expect(cmdArg("a&b|c<d>e^f")).toBe('"a&b|c<d>e^f"');
    expect(cmdArg("")).toBe('""');
  });

  it("doubles trailing backslashes inside quotes, so they don't escape the closing quote", () => {
    expect(cmdArg("C:\\Jo Smith\\")).toBe('"C:\\Jo Smith\\\\"');
    expect(cmdArg("C:\\Jo Smith\\\\")).toBe('"C:\\Jo Smith\\\\\\\\"');
    expect(cmdArg("C:\\NoSpace\\")).toBe("C:\\NoSpace\\");
  });

  it.each(['say "hi"', "%PATH%", "wow!", "a\nb", "a\rb"])("refuses %j, which cmd would expand or split", (arg) => {
    expect(() => cmdArg(arg)).toThrow(/Can't pass .* to npm safely on Windows/);
  });
});

// Real child processes: node itself, offline and fast.
describe("spawnLines", () => {
  const script = (code: number) =>
    `process.stdout.write("out one\\nout two\\n"); process.stderr.write("err one\\n"); process.exitCode = ${code};`;

  it.each([0, 3, 1])("streams stdout and stderr line by line and resolves to exit code %i", async (code) => {
    const lines: string[] = [];
    const exit = await spawnLines(process.execPath, ["-e", script(code)], { cwd: tmpdir(), env: process.env, onLine: (l) => lines.push(l) });
    expect(exit).toBe(code);
    expect(lines.sort()).toEqual(["err one", "out one", "out two"]);
  });

  it("passes cwd and env to the child", async () => {
    const lines: string[] = [];
    const cwd = realpathSync(tmpdir());
    await spawnLines(process.execPath, ["-e", "console.log(process.cwd()); console.log(process.env.WAVE_TEST)"], {
      cwd,
      env: { ...process.env, WAVE_TEST: "from-the-wave" },
      onLine: (l) => lines.push(l),
    });
    expect(lines.map((l) => l.toLowerCase())).toEqual([cwd.toLowerCase(), "from-the-wave"]);
  });

  it("resolves to 1 and reports it when the command can't start", async () => {
    const lines: string[] = [];
    const exit = await spawnLines(join(tmpdir(), "no-such-command-for-the-wave"), [], { cwd: tmpdir(), env: process.env, onLine: (l) => lines.push(l) });
    expect(exit).toBe(1);
    expect(lines[0]).toMatch(/^Could not start the run: .*ENOENT/);
  });
});

function spec(number: number, name: string): Spec {
  const padded = String(number).padStart(3, "0");
  return parseSpec(`specs/${padded}-${name}.md`, `# Spec ${padded}\n\n## Goal\nx\n\n## Requirements\nx\n\n## Acceptance criteria\n- AC1: x\n`);
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const PULLS = "gh api --paginate repos/{owner}/{repo}/pulls?state=all&base=main&per_page=100 --jq .[] | {number, title, state, merged_at}";
const BRANCHES = "git ls-remote --heads origin refs/heads/agent/* refs/heads/spec/*";
const RUNS = "gh run list --workflow implement-spec.yml --limit 200 --json databaseId,displayTitle,status,conclusion,createdAt";

/** A fake Exec: known lines answer ok, `override` can answer any line (and sees the cwd). Every call is recorded. */
function fakeExec(override: (line: string, cwd?: string) => ExecResult | undefined = () => undefined) {
  const calls: { line: string; cwd?: string }[] = [];
  const known: Record<string, ExecResult> = {
    "git fetch origin main": ok(),
    "git rev-parse HEAD": ok("abc123\n"),
    "git rev-parse origin/main": ok("abc123\n"),
    "git status --porcelain -- specs/": ok(),
    [PULLS]: ok(),
    [BRANCHES]: ok(),
    [RUNS]: ok("[]"),
    "git worktree prune": ok(),
    "git worktree list --porcelain": ok("worktree /repo\nHEAD abc123\nbranch refs/heads/main\n"),
  };
  const exec: Exec = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
    const line = [command, ...args].join(" ");
    calls.push({ line, cwd: options?.cwd });
    const answer = override(line, options?.cwd) ?? known[line];
    if (answer) return answer;
    if (/^git (worktree (add|remove)|branch -D) /.test(line) || line === "npm ci") return ok();
    return { code: 1, stdout: "", stderr: `unexpected command: ${line}` };
  });
  return { exec, calls, lines: () => calls.map((c) => c.line) };
}

function memoryLog(): RunLog & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { runId: "test", events, event: (e) => void events.push(e) };
}

describe("runLocalWave", () => {
  let tmp: string;
  let dir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-wave-test-"));
    dir = join(tmp, "worktrees");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const specs = [spec(1, "a"), spec(2, "b"), spec(3, "c")];
  const wt = (slug: string) => join(realpathSync(dir), slug);
  function deps(over: Partial<LocalWaveDeps> = {}): LocalWaveDeps & { spawnAgent: ReturnType<typeof vi.fn<SpawnAgent>> } {
    return {
      specs,
      exec: fakeExec().exec,
      repoRoot: "/repo",
      worktreeDir: dir,
      maxParallel: 2,
      agentArgs: ["--scope", "demo-app", "--log-dir", "/abs/runs"],
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "k" },
      log: () => {},
      ...over,
      spawnAgent: vi.fn<SpawnAgent>(async () => 0),
    };
  }

  it("AC5: creates a missing worktreeDir before taking the lock, and removes the lock after a successful wave", async () => {
    const nested = join(tmp, "a", "b");
    const result = await runLocalWave({ ...deps(), worktreeDir: nested, specs: [] });
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(join(nested, ".lock"))).toBe(false);
    expect(result.started).toEqual([]);
  });

  it("AC5: runs git worktree add with the real path of a symlinked worktreeDir", async () => {
    const real = join(tmp, "real");
    mkdirSync(real);
    const link = join(tmp, "link");
    symlinkSync(real, link, "junction"); // a junction on Windows; the type is ignored elsewhere
    const { exec, lines } = fakeExec();
    await runLocalWave({ ...deps(), exec, worktreeDir: link, specs: [spec(1, "a")] });
    expect(lines()).toContain(`git worktree add --detach ${join(realpathSync(real), "001-a")} origin/main`);
  });

  it.each([
    ["HEAD isn't origin/main", (line: string) => (line === "git rev-parse origin/main" ? ok("fff999\n") : undefined), /HEAD is at abc123, but origin\/main is at fff999/],
    ["specs/ has uncommitted changes", (line: string) => (line === "git status --porcelain -- specs/" ? ok(" M specs/001-a.md\n") : undefined), /not clean under specs\//],
  ])("AC5: throws before creating any worktree when %s", async (_case, override, message) => {
    const { exec, lines } = fakeExec(override);
    const error = (await runLocalWave({ ...deps(), exec }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(message);
    expect(error.message).not.toMatch(/Another local wave/);
    expect(lines().some((l) => l.startsWith("git worktree add"))).toBe(false);
  });

  it("AC5: throws before creating any worktree when the lock file exists, and leaves that lock alone", async () => {
    mkdirSync(dir);
    writeFileSync(join(dir, ".lock"), "");
    const { exec, lines } = fakeExec();
    await expect(runLocalWave({ ...deps(), exec })).rejects.toThrow(
      `Another local wave is running, or one crashed and left ${join(realpathSync(dir), ".lock")}; delete it if none is running.`,
    );
    expect(lines().some((l) => l.startsWith("git worktree add"))).toBe(false);
    expect(existsSync(join(dir, ".lock"))).toBe(true);
  });

  it.each([0, -1, 1.5])("AC5: throws RangeError for maxParallel %s", async (maxParallel) => {
    await expect(runLocalWave({ ...deps(), maxParallel })).rejects.toThrow(RangeError);
  });

  it("AC5: removes its lock file after a wave that throws", async () => {
    const { exec } = fakeExec((line) => (line === PULLS ? { code: 4, stdout: "", stderr: "HTTP 401" } : undefined));
    await expect(runLocalWave({ ...deps(), exec })).rejects.toThrow(/HTTP 401/);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("AC6: prepares and starts only the two lowest of three ready specs, with the exact commands and arguments", async () => {
    const { exec, calls, lines } = fakeExec();
    const prepareSandbox = vi.fn(async () => {});
    const d = deps({ exec, prepareSandbox });
    const result = await runLocalWave(d);

    const all = lines();
    expect(all.indexOf("git worktree prune")).toBeLessThan(all.indexOf("git worktree list --porcelain"));
    expect(all.filter((l) => l.startsWith("git worktree add") || l === "npm ci")).toEqual([
      `git worktree add --detach ${wt("001-a")} origin/main`,
      "npm ci",
      `git worktree add --detach ${wt("002-b")} origin/main`,
      "npm ci",
    ]);
    expect(calls.filter((c) => c.line === "npm ci").map((c) => c.cwd)).toEqual([wt("001-a"), wt("002-b")]);
    expect(prepareSandbox).toHaveBeenCalledOnce();
    expect(prepareSandbox.mock.invocationCallOrder[0]).toBeLessThan(d.spawnAgent.mock.invocationCallOrder[0]!);
    expect(d.spawnAgent.mock.calls.map(([args, options]) => [args, options.cwd, options.env])).toEqual([
      [["specs/001-a.md", "--scope", "demo-app", "--log-dir", "/abs/runs"], wt("001-a"), { PATH: "/bin", ANTHROPIC_API_KEY: "k", INIT_CWD: wt("001-a") }],
      [["specs/002-b.md", "--scope", "demo-app", "--log-dir", "/abs/runs"], wt("002-b"), { PATH: "/bin", ANTHROPIC_API_KEY: "k", INIT_CWD: wt("002-b") }],
    ]);
    expect(result.started).toEqual(["specs/001-a.md", "specs/002-b.md"]);
    expect(result.succeeded).toEqual(["specs/001-a.md", "specs/002-b.md"]);
  });

  it("AC6: when npm ci fails for the second spec, removes both worktrees and throws naming it, without starting any run", async () => {
    const { exec, lines } = fakeExec((line, cwd) => (line === "npm ci" && cwd?.endsWith("002-b") ? { code: 1, stdout: "", stderr: "ERESOLVE" } : undefined));
    const d = deps({ exec });
    const error = (await runLocalWave(d).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^Preparing specs\/002-b\.md failed[\s\S]*ERESOLVE/);
    expect(lines().filter((l) => l.startsWith("git worktree remove"))).toEqual([
      `git worktree remove --force ${wt("001-a")}`,
      `git worktree remove --force ${wt("002-b")}`,
    ]);
    expect(d.spawnAgent).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("AC7: removes a success's worktree, keeps a failure's, and cleans up after a lost claim", async () => {
    const { exec, lines } = fakeExec();
    const logged: string[] = [];
    const runLog = memoryLog();
    const exits: Record<string, number> = { "specs/001-a.md": 0, "specs/002-b.md": 1, "specs/003-c.md": 3 };
    const d = deps({ exec, maxParallel: 3, log: (l) => logged.push(l), runLog });
    d.spawnAgent.mockImplementation(async ([path], { onLine }) => {
      onLine(`Created agent/${path!.slice(6, -3)}`);
      return exits[path!]!;
    });
    const result = await runLocalWave(d);

    expect(result.succeeded).toEqual(["specs/001-a.md"]);
    expect(result.failed).toEqual([{ spec: "specs/002-b.md", worktree: wt("002-b"), exitCode: 1 }]);
    expect(result.lostClaim).toEqual(["specs/003-c.md"]);
    expect(lines().filter((l) => /^git (worktree remove|branch -D)/.test(l))).toEqual([
      `git worktree remove ${wt("001-a")}`,
      `git worktree remove --force ${wt("003-c")}`,
      "git branch -D agent/003-c",
    ]);
    expect(logged).toEqual(expect.arrayContaining(["[001] Created agent/001-a", "[002] Created agent/002-b", "[003] Created agent/003-c"]));
    expect(logged.some((l) => l.includes(wt("002-b")) && l.includes("Kept"))).toBe(true);
    // Runs end in any order, so compare sorted by event type, then spec.
    const local = runLog.events.filter((e) => e.type.startsWith("local."));
    const key = (e: RunEvent) => `${e.type} ${String(e.spec)}`;
    // Every run starts before any ends: they go in parallel.
    expect(local.findLastIndex((e) => e.type === "local.start")).toBeLessThan(local.findIndex((e) => e.type === "local.end"));
    expect([...local].sort((x, y) => key(x).localeCompare(key(y)))).toEqual([
      { type: "local.end", spec: "specs/001-a.md", worktree: wt("001-a"), exitCode: 0, kept: false },
      { type: "local.end", spec: "specs/002-b.md", worktree: wt("002-b"), exitCode: 1, kept: true },
      { type: "local.end", spec: "specs/003-c.md", worktree: wt("003-c"), exitCode: 3, kept: false },
      { type: "local.start", spec: "specs/001-a.md", worktree: wt("001-a") },
      { type: "local.start", spec: "specs/002-b.md", worktree: wt("002-b") },
      { type: "local.start", spec: "specs/003-c.md", worktree: wt("003-c") },
    ]);
  });

  it("AC7: logs a failed worktree removal instead of throwing", async () => {
    const { exec } = fakeExec((line) => (line.startsWith("git worktree remove") ? { code: 128, stdout: "", stderr: "contains modified files" } : undefined));
    const logged: string[] = [];
    const result = await runLocalWave({ ...deps({ exec, log: (l) => logged.push(l) }), specs: [spec(1, "a")] });
    expect(result.succeeded).toEqual(["specs/001-a.md"]);
    expect(logged.some((l) => l.startsWith(`⚠️ Could not remove the worktree; remove ${wt("001-a")} by hand`))).toBe(true);
  });

  it("AC4: skips specs whose worktree a previous wave kept", async () => {
    mkdirSync(dir);
    const kept = join(realpathSync(dir), "001-a").replace(/\\/g, "/");
    const { exec } = fakeExec((line) => (line === "git worktree list --porcelain" ? ok(`worktree /repo\n\nworktree ${kept}\ndetached\n`) : undefined));
    const d = deps({ exec, maxParallel: 1 });
    const result = await runLocalWave(d);
    expect(result.plan[0]!.state).toMatchObject({ status: "needs-human", reason: "local-worktree" });
    expect(result.started).toEqual(["specs/002-b.md"]);
  });
});
