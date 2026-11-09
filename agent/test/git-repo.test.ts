import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec } from "../src/exec.js";
import { Git } from "../src/git.js";

// Runs real git in a throwaway repo: offline, and it checks the git plumbing the fakes stand in for.
describe("Git.fingerprint", () => {
  let dir: string;
  const sh = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-git-test-"));
    sh("init", "-q", "-b", "agent/x");
    writeFileSync(join(dir, "a.txt"), "a");
    sh("add", "a.txt");
    sh("commit", "-qm", "init");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is stable, and changes on a commit, a branch switch, a config change or a new hook", async () => {
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

    sh("switch", "-qc", "other");
    expect(await git.fingerprint()).not.toBe(before);
    sh("switch", "-q", "agent/x");

    sh("commit", "-q", "--allow-empty", "-m", "planted");
    expect(await git.fingerprint()).not.toBe(before);
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
});
