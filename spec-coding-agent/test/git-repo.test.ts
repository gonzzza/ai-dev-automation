import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec } from "../src/exec.js";
import { fixCommitMessage, parseCycleHistory } from "../src/fix.js";
import { Git } from "../src/git.js";

// Runs real git in a throwaway repo: offline, and it checks the git plumbing the fakes stand in for.
describe("Git, against a real repo", () => {
  let dir: string;
  const sh = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-git-test-"));
    sh("init", "-q", "-b", "agent/x");
    sh("config", "user.name", "t"); // Git.commit runs without -c overrides; CI has no global identity
    sh("config", "user.email", "t@t");
    writeFileSync(join(dir, "a.txt"), "a");
    sh("add", "a.txt");
    sh("commit", "-qm", "init");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Dozens of real git processes: slow on Windows, so more than Vitest's 5 s default.
  it("is stable, and changes on a commit, a branch switch, a config change or a new hook", { timeout: 30_000 }, async () => {
    const git = new Git(exec, dir);
    const before = await git.fingerprint();
    expect(await git.fingerprint()).toBe(before);

    sh("config", "core.sshCommand", "planted");
    expect(await git.fingerprint()).not.toBe(before);
    sh("config", "--unset", "core.sshCommand");
    expect(await git.fingerprint()).toBe(before);

    writeFileSync(join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
    expect(await git.fingerprint()).not.toBe(before);
    rmSync(join(dir, ".git", "hooks", "pre-push"));

    sh("update-index", "--assume-unchanged", "a.txt"); // hides edits to a.txt from git status
    expect(await git.fingerprint()).not.toBe(before);
    sh("update-index", "--no-assume-unchanged", "a.txt");
    sh("update-index", "--skip-worktree", "a.txt");
    expect(await git.fingerprint()).not.toBe(before);
    sh("update-index", "--no-skip-worktree", "a.txt");
    writeFileSync(join(dir, ".git", "info", "exclude"), "vitest.config.ts\n");
    expect(await git.fingerprint()).not.toBe(before);
    writeFileSync(join(dir, ".git", "info", "exclude"), "");
    const reset = await git.fingerprint();

    sh("switch", "-qc", "other");
    expect(await git.fingerprint()).not.toBe(before);
    sh("switch", "-q", "agent/x");

    sh("commit", "-q", "--allow-empty", "-m", "planted");
    expect(await git.fingerprint()).not.toBe(reset);
  });

  it("ignores the merge-base key VS Code adds for a new branch, but not other branch config", async () => {
    const git = new Git(exec, dir);
    const before = await git.fingerprint();
    sh("config", "branch.agent/x.vscode-merge-base", "origin/main"); // what VS Code wrote mid-run
    expect(await git.fingerprint()).toBe(before);

    sh("config", "branch.agent/x.pushRemote", "planted");
    expect(await git.fingerprint()).not.toBe(before);
  });

  it("falls back to the raw text when the config can't be parsed, so the change still counts", async () => {
    const git = new Git(exec, dir);
    const before = await git.fingerprint();
    writeFileSync(join(dir, ".git", "config.worktree"), "[core\n"); // not valid config syntax
    expect(await git.fingerprint()).not.toBe(before);
  });

  it("reads back the fix cycle trailers from real commits", async () => {
    const found = (category: string, line: number) => ({ path: "demo-app/src/a.ts", line, category, severity: "medium" as const, title: "t", body: "b" });
    const git = new Git(exec, dir);
    sh("branch", "base");
    sh("commit", "-q", "--allow-empty", "-m", fixCommitMessage(1, [found("bug", 44)], { outcomes: [], summary: "First fix.", testing: "", checksPassed: true }));
    sh("commit", "-q", "--allow-empty", "-m", "Merge main into agent/x"); // a human's commit, no trailers
    sh("commit", "-q", "--allow-empty", "-m", fixCommitMessage(2, [found("missing-tests", 73)], { outcomes: [], summary: "Second fix.", testing: "", checksPassed: true }));
    expect(parseCycleHistory(await git.cycleTrailers("base..HEAD"))).toEqual([
      { cycle: 1, addressed: [{ category: "bug", line: 44, path: "demo-app/src/a.ts" }] },
      { cycle: 2, addressed: [{ category: "missing-tests", line: 73, path: "demo-app/src/a.ts" }] },
    ]);
  });

  it("covers the shared config from a linked worktree", async () => {
    const worktree = `${dir}-wt`;
    sh("worktree", "add", "-q", worktree, "-b", "agent/wt");
    try {
      const git = new Git(exec, worktree);
      const before = await git.fingerprint();
      sh("config", "credential.helper", "planted"); // written to the main repo's config
      expect(await git.fingerprint()).not.toBe(before);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("reports a staged rename's source, and commits only the vetted files, not the whole index", async () => {
    const git = new Git(exec, dir);
    mkdirSync(join(dir, "demo-app"));
    sh("mv", "a.txt", "demo-app/a.txt"); // staged by "test code": deletes a.txt outside the scope
    writeFileSync(join(dir, "demo-app", "new.ts"), "export {};");
    expect((await git.changedFiles()).sort()).toEqual(["a.txt", "demo-app/a.txt", "demo-app/new.ts"]);

    await git.commit(["demo-app/new.ts"], "Add new.ts");
    const committed = String(sh("show", "--name-status", "--format=", "HEAD")).trim();
    expect(committed).toBe("A\tdemo-app/new.ts");
  });
});

// Two worktrees of one repository with a local bare origin, as in a local wave.
describe("AC3: claiming from parallel worktrees, against a real repo", () => {
  let root: string;
  let main: string;
  let a: string;
  let b: string;
  const sh = (cwd: string, ...args: string[]) => String(execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })).trim();
  const commit = (cwd: string, message: string) => sh(cwd, "commit", "-q", "--allow-empty", "-m", message);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-claim-test-"));
    main = join(root, "main");
    a = join(root, "wt-a");
    b = join(root, "wt-b");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "origin.git")]);
    mkdirSync(main);
    sh(main, "init", "-q", "-b", "main");
    sh(main, "config", "user.name", "t"); // Git.commit runs without -c overrides
    sh(main, "config", "user.email", "t@t");
    commit(main, "init");
    sh(main, "remote", "add", "origin", join(root, "origin.git"));
    sh(main, "push", "-q", "origin", "main");
    sh(main, "fetch", "-q", "origin");
    sh(main, "worktree", "add", "-q", "--detach", a, "origin/main");
    sh(main, "worktree", "add", "-q", "--detach", b, "origin/main");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("AC3: the first claim creates the branch; a second, from the other worktree at the same commit, fails", { timeout: 30_000 }, async () => {
    await new Git(exec, a).createBranch("agent/001-x");
    await new Git(exec, a).claimBranch("agent/001-x");
    expect(sh(main, "ls-remote", "--heads", "origin", "refs/heads/agent/001-x")).toMatch(/\trefs\/heads\/agent\/001-x$/);
    // Branches are shared between worktrees, so B pushes the same ref at the same commit.
    await expect(new Git(exec, b).claimBranch("agent/001-x")).rejects.toThrow(/did not create agent\/001-x/);
    expect(await new Git(exec, b).branchExistsOnOrigin("agent/001-x")).toBe(true);
  });

  it("AC3: a claim whose branch is at another commit is rejected by the lease", { timeout: 30_000 }, async () => {
    sh(a, "switch", "-qc", "agent/001-x");
    await new Git(exec, a).claimBranch("agent/001-x");
    commit(a, "moved on");
    await expect(new Git(exec, a).claimBranch("agent/001-x")).rejects.toThrow(/rejected|stale info/);
  });

  it("AC3: branching, claiming and pushing in worktree A leave worktree B's fingerprint unchanged", { timeout: 30_000 }, async () => {
    const gitA = new Git(exec, a);
    const before = await new Git(exec, b).fingerprint();
    await gitA.createBranch("agent/001-x");
    await gitA.claimBranch("agent/001-x");
    writeFileSync(join(a, "new.txt"), "work");
    await gitA.commit(["new.txt"], "SPEC-001 x");
    await gitA.push("agent/001-x");
    expect(await new Git(exec, b).fingerprint()).toBe(before);
    expect(sh(main, "config", "--list")).not.toMatch(/branch\.agent\/001-x\./);
  });

  it("AC3: headOnBase is true behind origin/main and false for a commit that isn't on it", { timeout: 30_000 }, async () => {
    commit(main, "later");
    sh(main, "push", "-q", "origin", "main");
    sh(main, "fetch", "-q", "origin"); // moves the shared origin/main past both worktrees
    expect(await new Git(exec, b).headOnBase("main")).toBe(true);
    commit(b, "not on main");
    expect(await new Git(exec, b).headOnBase("main")).toBe(false);
  });
});
