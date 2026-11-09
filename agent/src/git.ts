import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Exec } from "./exec.js";
import { ADDRESSED_TRAILER, CYCLE_TRAILER, type PullRequestInfo } from "./fix.js";

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

/**
 * Config keys that editors write by themselves and that change no git behavior. VS Code's Git
 * extension sets branch.<name>.vscode-merge-base a few seconds after it sees a new branch.
 * Keep this list to inert keys: anything that can run code or redirect a remote must still count.
 */
const INERT_CONFIG_KEY = /^branch\..+\.vscode-merge-base$/;

/**
 * The entries of `git config --list -z` ("key\nvalue" records, NUL-separated) that matter for the
 * fingerprint, with inert IDE keys removed. Order is kept: later entries override earlier ones.
 */
export function fingerprintConfig(listOutput: string): string {
  return listOutput
    .split("\0")
    .filter((entry) => entry !== "" && !INERT_CONFIG_KEY.test(entry.split("\n", 1)[0]!))
    .join("\0");
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
    // Config is hashed as git parses it, minus keys editors write on their own, so an IDE noticing the
    // new branch doesn't fail the run. If git can't parse the file, the raw text is hashed instead.
    const config = async (path: string) => {
      const result = await this.exec("git", [...Git.SAFE, "config", "--file", path, "--list", "-z"], { cwd: this.cwd });
      return result.code === 0 ? fingerprintConfig(result.stdout) : `raw\n${await read(path)}`;
    };
    const parts = [
      `HEAD ${head} ${branch}`,
      `config\n${await config(join(commonDir, "config"))}`,
      `config.worktree\n${await config(join(gitDir, "config.worktree"))}`,
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

  headSha() {
    return this.git("rev-parse", "HEAD");
  }

  /** The trailers the fix cycle writes, one NUL-led record per commit in `range`. */
  cycleTrailers(range: string) {
    return this.git("log", `--format=%x00%(trailers:key=${CYCLE_TRAILER},key=${ADDRESSED_TRAILER},unfold)`, range);
  }

  async pullRequest(number: number): Promise<PullRequestInfo> {
    const json = await run(this.exec, "gh", ["pr", "view", String(number), "--json", "state,isCrossRepository,headRefName,headRefOid,baseRefName"], this.cwd);
    return JSON.parse(json) as PullRequestInfo;
  }

  /** Posts a PR comment and returns its URL. */
  commentOnPullRequest(number: number, body: string): Promise<string> {
    return withTempFile(body, (path) => run(this.exec, "gh", ["pr", "comment", String(number), "--body-file", path], this.cwd));
  }

  /** Replies on an inline review comment's thread. The body goes as a JSON file, so nothing is parsed by gh. */
  async replyToReviewComment(number: number, commentId: number, body: string): Promise<void> {
    await withTempFile(JSON.stringify({ body }), (path) =>
      run(this.exec, "gh", ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${number}/comments/${commentId}/replies`, "--input", path], this.cwd),
    );
  }

  /** Resolves the thread whose first comment is `commentId`. Threads are only addressable through GraphQL. */
  async resolveReviewThread(number: number, commentId: number): Promise<void> {
    const threadId = await run(
      this.exec,
      "gh",
      [
        "api", "graphql", "--paginate",
        "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${number}`,
        "-f", `query=${REVIEW_THREADS_QUERY}`,
        "--jq", `.data.repository.pullRequest.reviewThreads.nodes[] | select(.comments.nodes[0].databaseId == ${commentId}) | .id`,
      ],
      this.cwd,
    );
    if (!threadId) throw new Error(`No review thread starts with comment ${commentId} on PR #${number}.`);
    await run(this.exec, "gh", ["api", "graphql", "-f", `id=${threadId.split("\n")[0]}`, "-f", `query=${RESOLVE_THREAD_MUTATION}`], this.cwd);
  }

  /** "https://github.com/owner/repo", for links in the PR body. */
  async repoUrl(): Promise<string | undefined> {
    const result = await this.exec("gh", ["repo", "view", "--json", "url", "--jq", ".url"], { cwd: this.cwd });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes { id comments(first: 1) { nodes { databaseId } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`;

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
