import { describe, expect, it, vi } from "vitest";
import { publishReview, SUPERSEDED_BODY, supersedePreviousReviews, type Octokit } from "../src/publish.js";
import { REVIEW_MARKER } from "../src/render.js";
import type { Finding } from "../src/schema.js";

const target = { owner: "o", repo: "r", pullNumber: 7, commitId: "abc123" };
const finding: Finding = {
  path: "src/a.ts",
  line: 3,
  category: "security",
  severity: "high",
  title: "SQL injection",
  body: "User input is concatenated into the query.",
};
const inline = [{ path: "src/a.ts", line: 3, side: "RIGHT" as const, body: "inline body" }];

function fakeOctokit(createReview: ReturnType<typeof vi.fn>) {
  return { rest: { pulls: { createReview } } } as unknown as Pick<Octokit, "rest">;
}

describe("publishReview", () => {
  it("posts a single COMMENT review with inline comments", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 11 } });
    const result = await publishReview(fakeOctokit(createReview), target, "summary", inline, [finding]);

    expect(result).toEqual({ mode: "inline", reviewId: 11 });
    expect(createReview).toHaveBeenCalledExactlyOnceWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      commit_id: "abc123",
      event: "COMMENT",
      body: "summary",
      comments: inline,
    });
  });

  it("falls back to a body-only review when GitHub rejects inline comments", async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 }))
      .mockResolvedValue({ data: { id: 12 } });
    const result = await publishReview(fakeOctokit(createReview), target, "summary", inline, [finding]);

    expect(result).toEqual({ mode: "body-only", reviewId: 12 });
    const retry = createReview.mock.calls[1]![0];
    expect(retry.comments).toBeUndefined();
    expect(retry.body).toContain("### Inline findings");
    expect(retry.body).toContain("`src/a.ts:3`");
    expect(retry.body).toContain("SQL injection");
  });

  it("rethrows other errors", async () => {
    const createReview = vi.fn().mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(publishReview(fakeOctokit(createReview), target, "s", inline, [finding])).rejects.toThrow("Forbidden");
  });
});

describe("supersedePreviousReviews", () => {
  const bot = { type: "Bot" };
  const reviews = [
    { id: 1, user: bot, body: `${REVIEW_MARKER}\n\nold review` },
    { id: 2, user: { type: "User" }, body: `quoting ${REVIEW_MARKER}` }, // a human, leave alone
    { id: 3, user: bot, body: SUPERSEDED_BODY }, // already handled
    { id: 4, user: bot, body: `${REVIEW_MARKER}\n\nnew review` }, // the one just posted
  ];

  function fakeClient() {
    const listReviews = vi.fn();
    const listCommentsForReview = vi.fn();
    const updateReview = vi.fn().mockResolvedValue({});
    const graphql = vi.fn().mockResolvedValue({});
    const paginate = vi.fn(async (method: unknown, params: { review_id?: number }) =>
      method === listReviews ? reviews : [{ node_id: `C_${params.review_id}_a` }, { node_id: `C_${params.review_id}_b` }],
    );
    const client = {
      rest: { pulls: { listReviews, listCommentsForReview, updateReview } },
      graphql,
      paginate,
    } as unknown as Pick<Octokit, "rest" | "graphql" | "paginate">;
    return { client, updateReview, graphql };
  }

  it("replaces older bot reviews and minimizes their inline comments", async () => {
    const { client, updateReview, graphql } = fakeClient();
    const count = await supersedePreviousReviews(client, target, 4);

    expect(count).toBe(1);
    expect(updateReview).toHaveBeenCalledExactlyOnceWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      review_id: 1,
      body: SUPERSEDED_BODY,
    });
    expect(graphql.mock.calls.map(([, vars]) => vars)).toEqual([{ id: "C_1_a" }, { id: "C_1_b" }]);
    expect(graphql.mock.calls[0]![0]).toContain("classifier: OUTDATED");
  });

  it("superseded body cannot be mistaken for a live review", () => {
    expect(SUPERSEDED_BODY.includes(REVIEW_MARKER)).toBe(false);
  });
});
