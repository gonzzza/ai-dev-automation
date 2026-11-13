import { describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../src/agent.js";
import { ClaimLostError, exitCodeFor, runPipeline, type GitOps, type PipelineDeps } from "../src/pipeline.js";
import { classifyFailure } from "../src/runlog.js";
import { parseSpec } from "../src/spec.js";

const spec = parseSpec(
  "specs/001-rate-limiter.md",
  "# Add a token bucket rate limiter\n\n## Goal\nx\n\n## Requirements\nx\n\n## Acceptance criteria\n- AC1: x\n",
);

const agentRun: AgentRun = {
  report: {
    plan: ["Read retry.ts", "Write limiter and tests"],
    summary: "Adds createRateLimiter.",
    testing: "Unit tests with a fake clock.",
    checksPassed: true,
    notes: "",
    sections: [{ heading: "What", text: "Adds createRateLimiter." }],
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
  onBase = true,
  claim = async (): Promise<unknown> => "",
  onOrigin = async (): Promise<boolean> => false,
} = {}) {
  let created = false;
  let ran = false;
  const git = {
    fingerprint: vi.fn(async () => (tamperGit && ran ? "changed" : "original")),
    currentBranch: vi.fn(async () => branch),
    changedFiles: vi.fn(async () => (created ? changed : dirty)),
    branchExists: vi.fn(async () => exists),
    branchExistsOnOrigin: vi.fn(onOrigin),
    createBranch: vi.fn(async () => void (created = true)),
    claimBranch: vi.fn(claim),
    headSha: vi.fn(async () => "0123456789abcdef"),
    headOnBase: vi.fn(async () => onBase),
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
      expect.stringMatching(/^SPEC-001 Add a token bucket rate limiter\n\nImplements specs\/001-rate-limiter\.md\./),
    );
    expect(git.push).toHaveBeenCalledWith("agent/001-rate-limiter");

    const [title, body, base, head] = git.openPullRequest.mock.calls[0]!;
    expect([title, base, head]).toEqual(["SPEC-001 Add a token bucket rate limiter", "main", "agent/001-rate-limiter"]);
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

  it("AC6: passes the standards from its deps through to the PR body", async () => {
    const { deps, git } = setup();
    deps.standards = { checked: ["TS-003"], dropped: ["TEST-001"], ref: "abc123" };
    await runPipeline(deps);
    const body = git.openPullRequest.mock.calls[0]![1];
    expect(body).toContain("## Standards\n\n- Given to the agent: `TS-003`\n- Version: `abc123`\n- Not given to the agent (over the size budget): `TEST-001`");
  });

  const TEMPLATE = ".github/pull_request_template.md";

  it("AC6: reads the PR template before the agent runs and passes it to the agent and the PR body", async () => {
    const { deps, git } = setup({ contents: { [TEMPLATE]: "<!-- Title rule. -->\n## What\n<!-- The change. -->\n## Why\n<!-- The reason. -->" } });
    await runPipeline(deps);
    const template = { sections: [{ heading: "What", guidance: "The change." }, { heading: "Why", guidance: "The reason." }] };
    expect(deps.readFile).toHaveBeenCalledWith(TEMPLATE);
    expect(deps.runAgent).toHaveBeenCalledWith(spec, template);
    const templateRead = vi.mocked(deps.readFile).mock.calls.findIndex(([path]) => path === TEMPLATE);
    expect(vi.mocked(deps.readFile).mock.invocationCallOrder[templateRead]).toBeLessThan(vi.mocked(deps.runAgent).mock.invocationCallOrder[0]!);
    const body = git.openPullRequest.mock.calls[0]![1];
    expect(body).toContain("## What\n\nAdds createRateLimiter.\n\n## Why\n\n_The agent did not fill this section._\n\n## Checks");
    expect(body).not.toContain("## Summary");
  });

  it("AC6: passes undefined and builds today's body when the template is missing", async () => {
    const { deps, git } = setup({ contents: { [TEMPLATE]: undefined } });
    await runPipeline(deps);
    expect(deps.runAgent).toHaveBeenCalledWith(spec, undefined);
    const body = git.openPullRequest.mock.calls[0]![1];
    expect(body).toContain("## Summary\n\nAdds createRateLimiter.");
    expect(body).not.toContain("## Checks");
  });

  it("AC6: aborts before the agent runs, and before branching, when reading the template fails", async () => {
    const { deps, git } = setup();
    const readFile = deps.readFile;
    deps.readFile = vi.fn(async (path: string) => {
      if (path === TEMPLATE) throw new Error("EISDIR: illegal operation on a directory");
      return readFile(path);
    });
    await expect(runPipeline(deps)).rejects.toThrow("EISDIR");
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  it("dry run verifies but does not commit, push or open a PR", async () => {
    const { deps, git } = setup({ dryRun: true });
    const result = await runPipeline(deps);
    expect(result).toMatchObject({ status: "dry-run", branch: "agent/001-rate-limiter" });
    expect(git.commit).not.toHaveBeenCalled();
    expect(git.openPullRequest).not.toHaveBeenCalled();
  });
});

describe("starting from a detached HEAD", () => {
  it("AC1: accepts a detached HEAD on origin/<base>, or behind it, and branches as usual", async () => {
    const { deps, git } = setup({ branch: "HEAD", onBase: true });
    await expect(runPipeline(deps)).resolves.toMatchObject({ status: "opened" });
    expect(git.headOnBase).toHaveBeenCalledWith("main");
    expect(git.createBranch).toHaveBeenCalledWith("agent/001-rate-limiter");
  });

  it("AC1: refuses a detached HEAD that isn't on origin/<base>, naming its short SHA", async () => {
    const { deps, git } = setup({ branch: "HEAD", onBase: false });
    await expect(runPipeline(deps)).rejects.toThrow("Check out main, or detach on origin/main, first (currently detached at 0123456).");
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it("AC1: on a named branch, runs on base and refuses any other, without asking headOnBase", async () => {
    const onBase = setup();
    await expect(runPipeline(onBase.deps)).resolves.toMatchObject({ status: "opened" });
    const other = setup({ branch: "feature" });
    await expect(runPipeline(other.deps)).rejects.toThrow("Check out main first (currently on feature).");
    expect(onBase.git.headOnBase).not.toHaveBeenCalled();
    expect(other.git.headOnBase).not.toHaveBeenCalled();
  });
});

describe("claiming the branch", () => {
  const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;

  it("AC2: claims after creating the branch and before the fingerprint and the agent", async () => {
    const { deps, git } = setup();
    await runPipeline(deps);
    expect(git.claimBranch).toHaveBeenCalledWith("agent/001-rate-limiter");
    expect(order(git.createBranch)).toBeLessThan(order(git.claimBranch));
    expect(order(git.claimBranch)).toBeLessThan(order(git.fingerprint));
    expect(order(git.claimBranch)).toBeLessThan(order(vi.mocked(deps.runAgent)));
  });

  it("AC2: a failed claim with the branch now on origin is a lost race: ClaimLostError, exit code 3, no agent", async () => {
    const { deps, git } = setup({ claim: async () => Promise.reject(new Error("stale info")), onOrigin: async () => true });
    const error = await runPipeline(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimLostError);
    expect((error as Error).message).toBe("Another run already claimed specs/001-rate-limiter.md: agent/001-rate-limiter exists on origin.");
    expect(exitCodeFor(error)).toBe(3);
    expect(git.branchExistsOnOrigin).toHaveBeenCalledWith("agent/001-rate-limiter");
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["the branch isn't on origin", async () => false],
    ["origin can't be read", async () => Promise.reject(new Error("could not read from remote"))],
  ])("AC2: rethrows the push's error unchanged when %s, and never runs the agent", async (_case, onOrigin) => {
    const pushError = new Error("Permission denied (publickey)");
    const { deps } = setup({ claim: async () => Promise.reject(pushError), onOrigin });
    const error = await runPipeline(deps).catch((e: unknown) => e);
    expect(error).toBe(pushError);
    expect(error).not.toBeInstanceOf(ClaimLostError);
    expect(exitCodeFor(error)).toBe(1);
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it("AC2: a branch that exists at preflight is the ordinary 'already exists' error, before any claim", async () => {
    const { deps, git } = setup({ exists: true });
    const error = await runPipeline(deps).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^Branch agent\/001-rate-limiter already exists/);
    expect(error).not.toBeInstanceOf(ClaimLostError);
    expect(git.claimBranch).not.toHaveBeenCalled();
  });

  it("AC2: exitCodeFor gives 1 for a plain Error and anything else", () => {
    expect(exitCodeFor(new Error("x"))).toBe(1);
    expect(exitCodeFor("x")).toBe(1);
    expect(exitCodeFor(new ClaimLostError("specs/a.md", "agent/a"))).toBe(3);
  });

  it("AC2: a dry run never claims or pushes", async () => {
    const { deps, git } = setup({ dryRun: true });
    await runPipeline(deps);
    expect(git.claimBranch).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
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
    [{ changed: ["spec-coding-agent/src/policy.ts"] }, "out-of-scope"],
    [{ symlinks: ["demo-app/src/rate-limiter.ts"] }, "out-of-scope"],
    [{ contents: { "demo-app/src/rate-limiter.ts": "const k = 'sk-test-value-from-the-env';" } }, "secret-found"],
    [{ changed: [] as string[] }, "no-changes"],
    [{ branch: "feature/x" }, "preflight"],
    [{ dirty: ["README.md"] }, "preflight"],
    [{ exists: true }, "preflight"],
    [{ branch: "HEAD", onBase: false }, "preflight"],
    [{ claim: async () => Promise.reject(new Error("stale info")), onOrigin: async () => true }, "claim-lost"],
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
