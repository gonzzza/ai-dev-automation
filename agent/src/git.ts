import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Exec } from "./exec.js";

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
    const out = await this.git("status", "--porcelain", "--untracked-files=all");
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, ""))
      .map((path) => (path.includes(" -> ") ? path.split(" -> ")[1]! : path));
  }

  async branchExists(name: string): Promise<boolean> {
    const local = await this.exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: this.cwd });
    return local.code === 0;
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
