import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Exec } from "./exec.js";

/**
 * Parses `git status --porcelain=v1 -z`: NUL-separated "XY path" entries, no quoting.
 * A rename or copy is followed by an extra entry holding the original path, which is skipped.
 */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return paths;
}

/** Thin git/gh wrapper. Messages go through temp files so nothing is shell-parsed. */
export class Git {
  constructor(
    private readonly exec: Exec,
    private readonly cwd: string,
  ) {}

  private git(...args: string[]) {
    return run(this.exec, "git", args, this.cwd);
  }

  currentBranch() {
    return this.git("rev-parse", "--abbrev-ref", "HEAD");
  }

  /** Paths with uncommitted changes, including untracked files. */
  async changedFiles(): Promise<string[]> {
    // Not run(): it trims, and the leading space of " M path" is part of the status format.
    const result = await this.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: this.cwd });
    if (result.code !== 0) throw new Error(`git status failed (exit ${result.code}):\n${result.stderr}`);
    return parsePorcelainZ(result.stdout);
  }

  /** Locally or on origin: a leftover remote branch would only fail at push time, after the agent has run. */
  async branchExists(name: string): Promise<boolean> {
    const local = await this.exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: this.cwd });
    if (local.code === 0) return true;
    // Exit 2 means no matching branch; any other failure (no origin, offline) surfaces later at push.
    const remote = await this.exec("git", ["ls-remote", "--exit-code", "--heads", "origin", name], { cwd: this.cwd });
    return remote.code === 0;
  }

  createBranch(name: string) {
    return this.git("switch", "-c", name);
  }

  async commit(files: string[], message: string): Promise<void> {
    await this.git("add", "--", ...files);
    await withTempFile(message, (path) => this.git("commit", "-F", path));
  }

  push(branch: string) {
    return this.git("push", "-u", "origin", branch);
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
