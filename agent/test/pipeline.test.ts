import { describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { runPipeline, type GitOps, type PipelineDeps } from "../src/pipeline.js";
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
} = {}) {
  let created = false;
  const git = {
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
    runAgent: vi.fn(async () => agentRun),
    runChecks: vi.fn(async () => ({ passed: checksPassed, output: checksPassed ? "ok" : "1 test failed" })),
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
    await expect(runPipeline(deps)).rejects.toThrow(/outside demo-app:\n\.github\/workflows\/ci\.yml/);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("does not trust the agent: failing checks block the PR", async () => {
    const { deps, git } = setup({ checksPassed: false });
    await expect(runPipeline(deps)).rejects.toThrow(/Checks failed.*kept for inspection[\s\S]*1 test failed/);
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
