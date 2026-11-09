import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Exec } from "./exec.js";

/**
 * Parses `git status --porcelain=v1 -z`: NUL-separated "XY path" entries, no quoting.
 * A rename or copy is followed by an extra entry holding the original path. Both paths are
 * returned: a rename deletes its source, so the source has to pass the scope gate too.
 */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]!);
  }
  return paths;
}

/** Thin git/gh wrapper. Messages go through temp files so nothing is shell-parsed. */
export class Git {
  constructor(
    private readonly exec: Exec,
    private readonly cwd: string,
  ) {}

  /**
   * Every harness git command runs with credentials, after agent-written code has run. Hooks and
   * fsmonitor are turned off so nothing planted in the repo can run then; fingerprint() catches
   * other config changes. /dev/null works for hooksPath on Git for Windows too.
   */
  private static readonly SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

  private git(...args: string[]) {
    return run(this.exec, "git", [...Git.SAFE, ...args], this.cwd);
  }

  /**
   * A hash of the git state that agent-run code could change without it showing in `git status`:
   * the checked-out branch and commit (a commit made during the run would hide its files from the
   * scope gate), the repo config and hooks, `info/exclude`, and index entries flagged
   * assume-unchanged or skip-worktree. Uses the common dir, so linked worktrees are covered.
   */
  async fingerprint(): Promise<string> {
    const [head, branch, gitDir, commonDir, flagged] = await Promise.all([
      this.git("rev-parse", "HEAD"),
      this.currentBranch(),
      this.git("rev-parse", "--absolute-git-dir"),
      this.git("rev-parse", "--path-format=absolute", "--git-common-dir"),
      // assume-unchanged (lowercase tag) and skip-worktree (S) hide a tracked file's edits from status.
      this.git("ls-files", "-v").then((out) => out.split("\n").filter((line) => /^([a-z]|S) /.test(line)).join("\n")),
    ]);
    const read = (path: string) => readFile(path, "utf8").catch(() => "<missing>");
    const hooksDir = join(commonDir, "hooks");
    const hooks = await readdir(hooksDir).catch(() => [] as string[]);
    const parts = [
      `HEAD ${head} ${branch}`,
      `config\n${await read(join(commonDir, "config"))}`,
      `config.worktree\n${await read(join(gitDir, "config.worktree"))}`,
      `info/exclude\n${await read(join(commonDir, "info", "exclude"))}`,
      `hidden index entries\n${flagged}`,
    ];
    for (const name of hooks.sort()) parts.push(`hooks/${name}\n${await read(join(hooksDir, name))}`);
    return createHash("sha256").update(parts.join("\0")).digest("hex");
  }

  currentBranch() {
    return this.git("rev-parse", "--abbrev-ref", "HEAD");
  }

  /** Paths with uncommitted changes, including untracked files. */
  async changedFiles(): Promise<string[]> {
    // Not run(): it trims, and the leading space of " M path" is part of the status format.
    const result = await this.exec("git", [...Git.SAFE, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: this.cwd });
    if (result.code !== 0) throw new Error(`git status failed (exit ${result.code}):\n${result.stderr}`);
    return parsePorcelainZ(result.stdout);
  }

  /** Locally or on origin: a leftover remote branch would only fail at push time, after the agent has run. */
  async branchExists(name: string): Promise<boolean> {
    const local = await this.exec("git", [...Git.SAFE, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: this.cwd });
    if (local.code === 0) return true;
    // ls-remote matches ref name suffixes, so compare exactly. A failure (no origin, offline) surfaces later at push.
    const ref = `refs/heads/${name}`;
    const remote = await this.exec("git", [...Git.SAFE, "ls-remote", "--heads", "origin", ref], { cwd: this.cwd });
    return remote.code === 0 && remote.stdout.split("\n").some((line) => line.split("\t")[1] === ref);
  }

  createBranch(name: string) {
    return this.git("switch", "-c", name);
  }

  /** Commits exactly `files`: the index is reset first, so nothing staged during the run rides along. */
  async commit(files: string[], message: string): Promise<void> {
    await this.git("reset", "-q");
    await this.git("add", "-A", "--", ...files);
    await withTempFile(message, (path) => this.git("commit", "--no-verify", "-F", path));
  }

  push(branch: string) {
    return this.git("push", "--no-verify", "-u", "origin", branch);
  }

  /** Opens the PR with gh and returns its URL. */
  openPullRequest(title: string, body: string, base: string, head: string): Promise<string> {
    return withTempFile(body, (path) =>
      run(this.exec, "gh", ["pr", "create", "--base", base, "--head", head, "--title", title, "--body-file", path], this.cwd),
    );
  }

  /** "https://github.com/owner/repo", for links in the PR body. */
  async repoUrl(): Promise<string | undefined> {
    const result = await this.exec("gh", ["repo", "view", "--json", "url", "--jq", ".url"], { cwd: this.cwd });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }
}

async function withTempFile<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spec-agent-"));
  const path = join(dir, "message.md");
  try {
    await writeFile(path, content, "utf8");
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
