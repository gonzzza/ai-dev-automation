import { describe, expect, it, vi } from "vitest";
import { FINDING_BODY_MAX_CHARS, FINDINGS_JSON_MAX_BYTES, findingsJson, run, type ActionIO, type RunDeps } from "../src/run.js";
import type { Finding } from "../src/schema.js";

const PATCH = "@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = a;";

const finding = (over: Partial<Finding> = {}): Finding => ({
  path: "src/a.ts",
  line: 1,
  category: "bug",
  severity: "high",
  title: "Problem",
  body: "Details.",
  ...over,
});

const DEFAULT_INPUTS: Record<string, string> = {
  "anthropic-api-key": "sk-test",
  "github-token": "gh-test",
  model: "claude-sonnet-5-5",
  effort: "high",
  "fail-on": "none",
  "max-diff-chars": "400000",
  exclude: "",
};

/** Builds fake @actions/core, Octokit and Anthropic clients and records what the action does with them. */
function setup({
  inputs = {},
  files = [{ filename: "src/a.ts", status: "added", patch: PATCH }],
  findings = [finding()],
  supersedeError,
  commentIdsError,
}: {
  inputs?: Record<string, string>;
  files?: unknown[];
  findings?: Finding[];
  supersedeError?: Error;
  commentIdsError?: Error;
} = {}) {
  const all = { ...DEFAULT_INPUTS, ...inputs };
  const outputs: Record<string, string> = {};
  const io = {
    getInput: (name: string) => all[name] ?? "",
    getMultilineInput: (name: string) => (all[name] ?? "").split("\n").filter(Boolean),
    setOutput: (name: string, value: string) => void (outputs[name] = value),
    setFailed: vi.fn(),
    setSecret: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  } satisfies ActionIO;

  const pulls = {
    listFiles: vi.fn(),
    listReviews: vi.fn(),
    listCommentsForReview: vi.fn(),
    createReview: vi.fn().mockResolvedValue({ data: { id: 99, user: { login: "github-actions[bot]" } } }),
    updateReview: vi.fn(),
  };
  const paginate = vi.fn(async (method: unknown) => {
    if (method === pulls.listFiles) return files;
    // The inline comments as GitHub returns them after createReview: ids 1000, 1001…
    if (method === pulls.listCommentsForReview) {
      if (commentIdsError) throw commentIdsError;
      const review = pulls.createReview.mock.calls.at(-1)?.[0] as { comments?: { path: string; line: number; body: string }[] } | undefined;
      return (review?.comments ?? []).map((c, i) => ({ id: 1000 + i, path: c.path, line: c.line, body: c.body }));
    }
    if (supersedeError) throw supersedeError;
    return [];
  });
  const stream = vi.fn(() => ({
    finalMessage: async () => ({
      stop_reason: "end_turn",
      parsed_output: { summary: "Summary.", findings },
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  }));

  const deps = {
    io,
    repo: { owner: "o", repo: "r" },
    pullRequest: { number: 7, title: "Add a", body: null, head: { sha: "abc" } },
    createOctokit: vi.fn(() => ({ rest: { pulls }, graphql: vi.fn(), paginate })),
    createAnthropic: vi.fn(() => ({ beta: { messages: { stream } } })),
  } as unknown as RunDeps;

  return { deps, io, outputs, pulls, stream };
}

describe("run", () => {
  it("reviews the PR, posts inline comments and sets outputs", async () => {
    const { deps, io, outputs, pulls } = setup({ findings: [finding({ severity: "low" }), finding({ severity: "high", line: 2 })] });
    await run(deps);

    expect(io.setSecret).toHaveBeenCalledWith("sk-test");
    expect(pulls.createReview).toHaveBeenCalledOnce();
    const review = pulls.createReview.mock.calls[0]![0];
    expect(review).toMatchObject({ pull_number: 7, commit_id: "abc", event: "COMMENT" });
    expect(review.comments.map((c: { line: number }) => c.line)).toEqual([2, 1]);
    expect(outputs).toMatchObject({ findings: "2", "highest-severity": "high" });
    // Most severe first, with everything a downstream fixer needs to locate and understand each one.
    const json = JSON.parse(outputs["findings-json"]!) as { severity: string; line: number; path: string; body: string }[];
    expect(json.map((f) => [f.severity, f.line])).toEqual([["high", 2], ["low", 1]]);
    expect(json[0]).toMatchObject({ path: expect.any(String), body: expect.any(String) });
    expect(io.setFailed).not.toHaveBeenCalled();
  });

  it("gives each inline finding the id of its comment, for replies on its thread", async () => {
    const { deps, outputs } = setup({
      findings: [finding({ severity: "low", line: 1 }), finding({ severity: "high", line: 2 }), finding({ line: 40, title: "Off the diff" })],
    });
    await run(deps);
    const json = JSON.parse(outputs["findings-json"]!) as { line: number; commentId?: number }[];
    // Inline comments are posted most severe first: line 2 is comment 1000, line 1 is 1001.
    expect(json.map((f) => [f.line, f.commentId])).toEqual([[2, 1000], [40, undefined], [1, 1001]]);
  });

  it("leaves comment ids out when the inline comments were rejected", async () => {
    const { deps, outputs, pulls } = setup();
    pulls.createReview
      .mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 }))
      .mockResolvedValue({ data: { id: 100, user: null } });
    await run(deps);
    expect(JSON.parse(outputs["findings-json"]!)).toEqual([finding()]);
  });

  it("warns and still sets outputs when the comment ids can't be read", async () => {
    const { deps, io, outputs } = setup({ commentIdsError: new Error("rate limited") });
    await run(deps);
    expect(io.warning).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
    expect(JSON.parse(outputs["findings-json"]!)).toEqual([finding()]);
  });

  it("skips with a warning when the API key is missing (fork PRs)", async () => {
    const { deps, io, pulls } = setup({ inputs: { "anthropic-api-key": "" } });
    await run(deps);
    expect(io.warning).toHaveBeenCalledWith(expect.stringContaining("skipping AI review"));
    expect(deps.createOctokit).not.toHaveBeenCalled();
    expect(pulls.createReview).not.toHaveBeenCalled();
  });

  it.each([
    [{ effort: "extreme" }, /effort must be one of/],
    [{ "max-diff-chars": "-5" }, /max-diff-chars must be a positive integer/],
    [{ "fail-on": "severe" }, /fail-on must be one of/],
  ])("rejects invalid input %o", async (inputs, error) => {
    const { deps } = setup({ inputs });
    await expect(run(deps)).rejects.toThrow(error);
  });

  it("posts nothing when every file is excluded", async () => {
    const { deps, outputs, pulls, stream } = setup({ inputs: { exclude: "src/**" } });
    await run(deps);
    expect(stream).not.toHaveBeenCalled();
    expect(pulls.createReview).not.toHaveBeenCalled();
    expect(outputs).toEqual({ findings: "0", "highest-severity": "none", "findings-json": "[]" });
  });

  it("reports files beyond what GitHub's files API lists", async () => {
    const { deps, pulls } = setup();
    deps.pullRequest = { ...deps.pullRequest!, changed_files: 3500 };
    await run(deps);
    expect(pulls.createReview.mock.calls[0]![0].body).toContain("3499 more file(s)");
  });

  it("fails the check when a finding meets fail-on", async () => {
    const { deps, io } = setup({ inputs: { "fail-on": "high" } });
    await run(deps);
    expect(io.setFailed).toHaveBeenCalledWith(expect.stringContaining('"high"'));
  });

  it("warns instead of failing when cleaning up old reviews fails", async () => {
    const { deps, io, outputs } = setup({ supersedeError: new Error("GraphQL down") });
    await run(deps);
    expect(io.warning).toHaveBeenCalledWith(expect.stringContaining("GraphQL down"));
    expect(io.setFailed).not.toHaveBeenCalled();
    expect(outputs.findings).toBe("1");
  });
});

describe("findingsJson", () => {
  it("truncates long bodies and drops the least severe findings past the size cap", () => {
    const big = "é".repeat(FINDING_BODY_MAX_CHARS + 500); // 2 bytes each in UTF-8
    const findings = [
      ...Array.from({ length: 30 }, (_, i) => finding({ severity: "low", line: i, body: big })),
      finding({ severity: "critical", title: "Keep me", body: big }),
    ];
    const json = findingsJson(findings);
    const parsed = JSON.parse(json) as Finding[];

    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(FINDINGS_JSON_MAX_BYTES);
    expect(parsed[0]).toMatchObject({ severity: "critical", title: "Keep me" });
    expect(parsed[0]!.body).toHaveLength(FINDING_BODY_MAX_CHARS + 1); // + the ellipsis
    expect(parsed.length).toBeLessThan(findings.length);
  });

  it("always keeps the most severe finding, however long its fields", () => {
    const parsed = JSON.parse(findingsJson([finding({ title: "t".repeat(100_000), path: "p".repeat(100_000) })])) as Finding[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.title).toHaveLength(301);
  });

  it("keeps small reviews whole", () => {
    expect(JSON.parse(findingsJson([finding()]))).toEqual([finding()]);
    expect(findingsJson([])).toBe("[]");
  });

  it("adds the comment id where there is one", () => {
    const [a, b] = [finding({ line: 1 }), finding({ line: 2 })];
    expect(JSON.parse(findingsJson([a, b], new Map([[b, 42]])))).toEqual([a, { ...b, commentId: 42 }]);
  });
});
