import { fileURLToPath } from "node:url";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { annotatePatch } from "../src/diff.js";
import { buildUserPrompt, STANDARDS_INSTRUCTIONS, SYSTEM_PROMPT } from "../src/prompt.js";
import { FINDING_BODY_MAX_CHARS, FINDINGS_JSON_MAX_BYTES, findingsJson, run, type ActionIO, type RunDeps } from "../src/run.js";
import type { Finding } from "../src/schema.js";

const PATCH = "@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = a;";

/** ts/TS-001 (high, src/**), ts/TS-002 (*.py only), testing/TEST-001 (agent only), docs/DOC-001 (low, every file, long). */
const STANDARDS = fileURLToPath(new URL("./fixtures/standards", import.meta.url));

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
  "standards-path": "",
  "standards-packs": "",
  "standards-ref": "",
  "max-standards-chars": "40000",
};

type PostedComment = { id: number; pull_request_review_id: number; path: string; line: number; body: string };

/** Builds fake @actions/core, Octokit and Anthropic clients and records what the action does with them. */
function setup({
  inputs = {},
  files = [{ filename: "src/a.ts", status: "added", patch: PATCH }],
  findings = [finding()],
  supersedeError,
  commentIdsError,
  readBack = (comments) => comments,
}: {
  inputs?: Record<string, string>;
  files?: unknown[];
  findings?: Finding[];
  supersedeError?: Error;
  commentIdsError?: Error;
  /** Edits the inline comments the action reads back after posting, e.g. to lose one. */
  readBack?: (comments: PostedComment[]) => PostedComment[];
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
    listReviewComments: vi.fn(),
    createReview: vi.fn().mockResolvedValue({ data: { id: 99, user: { login: "github-actions[bot]" } } }),
    updateReview: vi.fn(),
  };
  const paginate = vi.fn(async (method: unknown) => {
    if (method === pulls.listFiles) return files;
    // The PR's review comments as GitHub returns them after createReview: the new review's are ids 1000, 1001…
    if (method === pulls.listReviewComments) {
      if (commentIdsError) throw commentIdsError;
      const review = pulls.createReview.mock.calls.at(-1)?.[0] as { comments?: { path: string; line: number; body: string }[] } | undefined;
      const { data } = (await pulls.createReview.mock.results.at(-1)?.value) as { data: { id: number } };
      const reviewId = data.id;
      return readBack(
        (review?.comments ?? []).map((c, i) => ({ id: 1000 + i, pull_request_review_id: reviewId, path: c.path, line: c.line, body: c.body })),
      );
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

  /** The params of the one request sent to the Anthropic client. */
  const request = () => (stream.mock.calls[0] as unknown[] | undefined)?.[0] as { system: string; messages: { content: string }[] };

  return { deps, io, outputs, pulls, stream, request };
}

/** The review schema as it was before org standards existed, to pin the request byte for byte. */
const PRE_STANDARDS_REVIEW_SCHEMA = z.object({
  summary: z.string().describe("2-4 sentences on what the PR does and its overall risk."),
  findings: z.array(
    z.object({
      path: z.string().describe("File path exactly as shown in the <file path> attribute."),
      line: z.number().int().describe("New-file line number from the left column of the annotated diff."),
      category: z.enum(["bug", "security", "missing-tests", "performance", "maintainability"]),
      severity: z.enum(["low", "medium", "high", "critical"]),
      title: z.string().describe("One line, under 80 characters."),
      body: z.string().describe("What is wrong, the concrete failure scenario, and how to fix it. Markdown."),
    }),
  ),
});

describe("run with org standards", () => {
  it("AC5: sends byte-for-byte the pre-standards request when standards-path is empty", async () => {
    const { deps, request } = setup({ inputs: { "standards-packs": "ts", "max-standards-chars": "oops" } });
    await run(deps);
    const expected = {
      model: "claude-sonnet-5-5",
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(PRE_STANDARDS_REVIEW_SCHEMA) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt({ title: "Add a", body: null }, [{ path: "src/a.ts", ...annotatePatch(PATCH) }]) }],
    };
    expect(JSON.stringify(request())).toBe(JSON.stringify(expected));
    expect(request().system).not.toContain("org_standards");
  });

  it("AC5: appends only the selected standards to the system prompt", async () => {
    const { deps, request } = setup({ inputs: { "standards-path": STANDARDS } });
    await run(deps);
    const { system, messages } = request();
    expect(system.startsWith(`${SYSTEM_PROMPT}\n\n${STANDARDS_INSTRUCTIONS}\n\n<org_standards>\n`)).toBe(true);
    expect(system.endsWith("</standard>\n</org_standards>")).toBe(true);
    // Most severe first. TS-002 matches no reviewed path and TEST-001 is for the agent only.
    expect(system.match(/<standard id="[^"]+"/g)).toEqual(['<standard id="TS-001"', '<standard id="DOC-001"']);
    expect(system).toContain(
      '<standard id="TS-001" severity="high" title="No any in exports">\nExported functions spell out types: no Promise&lt;any&gt; &amp; no casts.\n</standard>',
    );
    // The untrusted user message is unchanged.
    expect(messages[0]!.content).not.toContain("org_standards");
    expect(JSON.stringify(request())).toContain('"rule"');
  });

  it("AC5: sends no standards block when none apply to the reviewed files", async () => {
    const { deps, pulls, request } = setup({ inputs: { "standards-path": STANDARDS, "standards-packs": "testing" } });
    await run(deps);
    expect(request().system).toBe(SYSTEM_PROMPT);
    expect(pulls.createReview.mock.calls[0]![0].body).toContain("**Standards:** none applied to the reviewed files");
  });

  it("AC6: keeps a rule naming a sent standard, shows it inline and in findings-json, and drops unknown rules", async () => {
    const { deps, outputs, pulls } = setup({
      inputs: { "standards-path": STANDARDS },
      findings: [
        finding({ line: 1, rule: "TS-001" }),
        // TS-002 exists but was not sent: it only applies to Python files.
        finding({ line: 2, severity: "low", rule: "TS-002" }),
        finding({ line: 2, severity: "medium", rule: "MADE-UP-1" }),
      ],
    });
    await run(deps);

    const comments = pulls.createReview.mock.calls[0]![0].comments as { line: number; body: string }[];
    expect(comments.map((c) => c.body.split("\n")[0])).toEqual([
      "**🐛 Bug · high · TS-001**: Problem",
      "**🐛 Bug · medium**: Problem",
      "**🐛 Bug · low**: Problem",
    ]);
    const json = JSON.parse(outputs["findings-json"]!) as Record<string, unknown>[];
    expect(json[0]).toMatchObject({ rule: "TS-001", commentId: 1000 });
    expect(json.slice(1).every((f) => !("rule" in f))).toBe(true);
    expect(json).toHaveLength(3);
  });

  it("AC6: removes rules when no standards were sent", async () => {
    const { deps, outputs } = setup({ findings: [finding({ rule: "TS-001" })] });
    await run(deps);
    expect(JSON.parse(outputs["findings-json"]!)).toEqual([{ ...finding(), commentId: 1000 }]);
  });

  it("AC7: lists the checked ids, the standards-ref and the ids dropped for budget", async () => {
    const { deps, io, pulls, request } = setup({
      inputs: { "standards-path": STANDARDS, "standards-ref": "v1.2.0", "max-standards-chars": "150" },
    });
    await run(deps);
    const body = pulls.createReview.mock.calls[0]![0].body as string;
    expect(body).toContain("**Standards:** checked TS-001 at `v1.2.0` · not checked (over `max-standards-chars`): DOC-001");
    expect(io.warning).toHaveBeenCalledWith(expect.stringContaining("Not checking DOC-001"));
    expect(request().system).not.toContain("DOC-001");
  });

  it("AC7: loads only the packs named in standards-packs, comma- or newline-separated", async () => {
    for (const packs of ["ts, testing", "ts\ntesting\n"]) {
      const { deps, pulls } = setup({ inputs: { "standards-path": STANDARDS, "standards-packs": packs } });
      await run(deps);
      const body = pulls.createReview.mock.calls[0]![0].body as string;
      expect(body).toContain("**Standards:** checked TS-001\n");
      expect(body).not.toContain("DOC-001");
    }
  });

  it.each([
    [{ "standards-path": STANDARDS, "max-standards-chars": "0" }, /max-standards-chars must be a positive integer/],
    [{ "standards-path": STANDARDS, "max-standards-chars": "lots" }, /max-standards-chars must be a positive integer/],
    [{ "standards-path": fileURLToPath(new URL("./fixtures/missing", import.meta.url)) }, /standards directory does not exist/],
    [{ "standards-path": STANDARDS, "standards-packs": "ts,security" }, /unknown pack "security"; available packs: docs, testing, ts/],
  ])("AC7: fails before calling Anthropic on %o", async (inputs, error) => {
    const { deps, stream } = setup({ inputs });
    await expect(run(deps)).rejects.toThrow(error);
    expect(deps.createAnthropic).not.toHaveBeenCalled();
    expect(deps.createOctokit).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
});

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

  it("warns when some inline comments can't be matched to their ids", async () => {
    const { deps, io, outputs } = setup({
      findings: [finding({ line: 1 }), finding({ line: 2 })],
      readBack: (comments) => comments.slice(1),
    });
    await run(deps);
    expect(io.warning).toHaveBeenCalledWith(expect.stringContaining("Matched 1 of 2 inline comments"));
    expect((JSON.parse(outputs["findings-json"]!) as { commentId?: number }[]).filter((f) => f.commentId)).toHaveLength(1);
  });

  it("doesn't warn when every inline comment is matched", async () => {
    const { deps, io } = setup();
    await run(deps);
    expect(io.warning).not.toHaveBeenCalled();
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
