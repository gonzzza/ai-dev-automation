import { describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { runPipeline, type GitOps, type PipelineDeps } from "../src/pipeline.js";
import { classifyFailure } from "../src/runlog.js";
import { parseSpec } from "../src/spec.js";

const spec = parseSpec(
  "specs/001-rate-limiter.md",
  "# Add a token bucket rate limiter\n\n## Goal\nx\n\n## Requirements\nx\n\n## Acceptance criteria\nx\n",
);

const agentRun: AgentRun = {
  report: {
    plan: ["Read retry.ts", "Write limiter and tests"],
    summary: "Adds createRateLimiter.",
    testing: "Unit tests with a fake clock.",
    checksPassed: true,
    notes: "",
  },
  costUsd: 1.234,
  turns: 18,
  durationMs: 95_000,
};

function setup({
  branch = "main",
  dirty = [] as string[],
  exists = false,
  changed = ["demo-app/src/rate-limiter.ts", "demo-app/test/rate-limiter.test.ts"],
  checksPassed = true,
  dryRun = false,
  contents = {} as Record<string, string | undefined>,
  tamperGit = false,
  symlinks = [] as string[],
} = {}) {
  let created = false;
  let ran = false;
  const git = {
    fingerprint: vi.fn(async () => (tamperGit && ran ? "changed" : "original")),
    currentBranch: vi.fn(async () => branch),
    changedFiles: vi.fn(async () => (created ? changed : dirty)),
    branchExists: vi.fn(async () => exists),
    createBranch: vi.fn(async () => void (created = true)),
    commit: vi.fn(async () => {}),
    push: vi.fn(async () => ""),
    openPullRequest: vi.fn(async (_title: string, _body: string, _base: string, _head: string) => "https://github.com/o/r/pull/2"),
    repoUrl: vi.fn(async () => "https://github.com/o/r"),
  } satisfies GitOps;
  const deps: PipelineDeps = {
    spec,
    git,
    base: "main",
    writableDirs: ["demo-app"],
    model: "claude-opus-5-5",
    dryRun,
    runAgent: vi.fn(async () => ((ran = true), agentRun)),
    runChecks: vi.fn(async () => ({ passed: checksPassed, output: checksPassed ? "ok" : "1 test failed" })),
    readFile: vi.fn(async (path: string) => (path in contents ? contents[path] : "export {};")),
    isSymlink: vi.fn(async (path: string) => symlinks.includes(path)),
    secrets: ["sk-test-value-from-the-env"],
    log: () => {},
  };
  return { deps, git };
}

describe("runPipeline", () => {
  it("branches, runs the agent, verifies, commits, pushes and opens the PR", async () => {
    const { deps, git } = setup();
    const result = await runPipeline(deps);

    expect(result).toMatchObject({ status: "opened", url: "https://github.com/o/r/pull/2" });
    expect(git.createBranch).toHaveBeenCalledWith("agent/001-rate-limiter");
    expect(deps.runChecks).toHaveBeenCalledOnce();
    expect(git.commit).toHaveBeenCalledWith(
      ["demo-app/src/rate-limiter.ts", "demo-app/test/rate-limiter.test.ts"],
      expect.stringMatching(/^Add a token bucket rate limiter\n\nImplements specs\/001-rate-limiter\.md\./),
    );
    expect(git.push).toHaveBeenCalledWith("agent/001-rate-limiter");

    const [title, body, base, head] = git.openPullRequest.mock.calls[0]!;
    expect([title, base, head]).toEqual(["Add a token bucket rate limiter", "main", "agent/001-rate-limiter"]);
    expect(body).toContain("[`specs/001-rate-limiter.md`](https://github.com/o/r/blob/main/specs/001-rate-limiter.md)");
    expect(body).toContain("1. Read retry.ts\n2. Write limiter and tests");
    expect(body).toContain("18 turns · 95s · $1.23");
    expect(body).not.toContain("Notes for the reviewer");
  });

  it.each([
    [{ branch: "feature" }, /Check out main first/],
    [{ dirty: ["README.md"] }, /not clean/],
    [{ exists: true }, /already exists/],
  ])("refuses to start when %o", async (opts, error) => {
    const { deps } = setup(opts);
    await expect(runPipeline(deps)).rejects.toThrow(error);
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it("stops when the agent made no changes", async () => {
    const { deps, git } = setup({ changed: [] });
    await expect(runPipeline(deps)).rejects.toThrow(/no changes/);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("stops when the agent changed files outside its scope", async () => {
    const { deps, git } = setup({ changed: ["demo-app/src/a.ts", ".github/workflows/ci.yml"] });
    await expect(runPipeline(deps)).rejects.toThrow(/outside demo-app or protected config files:\n\.github\/workflows\/ci\.yml/);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("stops when the files that define the checks changed, even inside the scope", async () => {
    const { deps, git } = setup({ changed: ["demo-app/src/a.ts", "demo-app/package.json"] });
    await expect(runPipeline(deps)).rejects.toThrow(/protected config files:\ndemo-app\/package\.json/);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("stops before any further git command when HEAD, the branch, .git/config or hooks changed during the run", async () => {
    const { deps, git } = setup({ tamperGit: true });
    await expect(runPipeline(deps)).rejects.toThrow("The git state (HEAD, branch, .git/config or hooks) changed during the run");
    expect(git.changedFiles).toHaveBeenCalledTimes(1); // only the preflight, before the agent ran
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("rejects symlinks, whose committed target path the secret scan would not see", async () => {
    const { deps, git } = setup({ changed: ["demo-app/src/a.ts", "demo-app/x"], symlinks: ["demo-app/x"], contents: { "demo-app/x": undefined } });
    await expect(runPipeline(deps)).rejects.toThrow("The run created symlinks, which are not allowed:\ndemo-app/x");
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("commits deletions without trying to scan the deleted file", async () => {
    const { deps, git } = setup({ changed: ["demo-app/src/a.ts", "demo-app/test/old.test.ts"], contents: { "demo-app/test/old.test.ts": undefined } });
    await expect(runPipeline(deps)).resolves.toMatchObject({ status: "opened" });
    expect(git.commit).toHaveBeenCalledWith(["demo-app/src/a.ts", "demo-app/test/old.test.ts"], expect.any(String));
  });

  it("does not trust the agent: failing checks block the PR", async () => {
    const { deps, git } = setup({ checksPassed: false });
    await expect(runPipeline(deps)).rejects.toThrow(/Checks failed.*kept for inspection[\s\S]*1 test failed/);
    expect(git.commit).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
  });

  it("blocks the commit when a changed file contains a secret", async () => {
    const { deps, git } = setup({ contents: { "demo-app/src/rate-limiter.ts": 'const key = "sk-test-value-from-the-env";' } });
    await expect(runPipeline(deps)).rejects.toThrow("Possible secret in demo-app/src/rate-limiter.ts");
    expect(git.commit).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
  });

  it("dry run verifies but does not commit, push or open a PR", async () => {
    const { deps, git } = setup({ dryRun: true });
    const result = await runPipeline(deps);
    expect(result).toMatchObject({ status: "dry-run", branch: "agent/001-rate-limiter" });
    expect(git.commit).not.toHaveBeenCalled();
    expect(git.openPullRequest).not.toHaveBeenCalled();
  });
});

describe("traceability", () => {
  it("puts the run id in a commit trailer and the PR footer", async () => {
    const { deps, git } = setup();
    deps.runId = "20261109T073012Z-3f9a1c";
    await runPipeline(deps);
    expect(git.commit).toHaveBeenCalledWith(expect.any(Array), expect.stringMatching(/\n\nAgent-Run: 20261109T073012Z-3f9a1c\n$/));
    expect(git.openPullRequest.mock.calls[0]![1]).toContain("· run 20261109T073012Z-3f9a1c</sub>");
  });

  // Run against the errors the gates really throw, so rewording a gate message breaks this test
  // instead of silently turning a failure category into "other" on the dashboards.
  it.each([
    [{ checksPassed: false }, "checks-failed"],
    [{ tamperGit: true }, "git-state-changed"],
    [{ changed: ["agent/src/policy.ts"] }, "out-of-scope"],
    [{ symlinks: ["demo-app/src/rate-limiter.ts"] }, "out-of-scope"],
    [{ contents: { "demo-app/src/rate-limiter.ts": "const k = 'sk-test-value-from-the-env';" } }, "secret-found"],
    [{ changed: [] as string[] }, "no-changes"],
    [{ branch: "feature/x" }, "preflight"],
    [{ dirty: ["README.md"] }, "preflight"],
    [{ exists: true }, "preflight"],
  ])("classifies the gate failure for %o as %s", async (options, category) => {
    const { deps } = setup(options);
    const error = await runPipeline(deps).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(classifyFailure(error!.message)).toBe(category);
  });
});
