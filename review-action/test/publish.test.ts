import { describe, expect, it, vi } from "vitest";
import { inlineCommentIds, publishReview, SUPERSEDED_BODY, supersedePreviousReviews, type Octokit } from "../src/publish.js";
import { MAX_BODY_CHARS, REVIEW_MARKER } from "../src/render.js";
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
    const createReview = vi.fn().mockResolvedValue({ data: { id: 11, user: { login: "bot" } } });
    const result = await publishReview(fakeOctokit(createReview), target, "summary", inline, [finding]);

    expect(result).toEqual({ mode: "inline", reviewId: 11, author: "bot" });
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
      .mockResolvedValue({ data: { id: 12, user: null } });
    const result = await publishReview(fakeOctokit(createReview), target, "summary", inline, [finding]);

    expect(result).toEqual({ mode: "body-only", reviewId: 12, author: null });
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

describe("inlineCommentIds", () => {
  const comment = (over: Partial<{ path: string; line: number; body: string }> = {}) => ({ path: "src/a.ts", line: 3, side: "RIGHT" as const, body: "b", ...over });

  function fakeClient(posted: { id: number; path: string; line: number | null; original_line?: number; body: string }[]) {
    const listCommentsForReview = vi.fn();
    const paginate = vi.fn().mockResolvedValue(posted);
    return { client: { rest: { pulls: { listCommentsForReview } }, paginate } as unknown as Pick<Octokit, "rest" | "paginate">, paginate };
  }

  it("matches posted comments to the inline list by path, line and body", async () => {
    const { client, paginate } = fakeClient([
      { id: 2, path: "src/b.ts", line: 9, body: "other" },
      { id: 1, path: "src/a.ts", line: 3, body: "b" },
    ]);
    const ids = await inlineCommentIds(client, target, 11, [comment(), comment({ path: "src/b.ts", line: 9, body: "other" }), comment({ line: 4 })]);
    expect(ids).toEqual([1, 2, undefined]);
    expect(paginate.mock.calls[0]![1]).toMatchObject({ pull_number: 7, review_id: 11 });
  });

  it("gives identical comments distinct ids, in order", async () => {
    const { client } = fakeClient([
      { id: 5, path: "src/a.ts", line: 3, body: "b" },
      { id: 6, path: "src/a.ts", line: null, original_line: 3, body: "b" },
    ]);
    expect(await inlineCommentIds(client, target, 11, [comment(), comment()])).toEqual([5, 6]);
  });

  it("matches bodies as posted, after truncation", async () => {
    const long = "x".repeat(MAX_BODY_CHARS + 10);
    const { client } = fakeClient([{ id: 7, path: "src/a.ts", line: 3, body: `${long.slice(0, MAX_BODY_CHARS)}

_…truncated to fit GitHub's comment size limit._` }]);
    expect(await inlineCommentIds(client, target, 11, [comment({ body: long })])).toEqual([7]);
  });
});

describe("supersedePreviousReviews", () => {
  const me = { login: "ai-reviewer" };
  const reviews = [
    { id: 1, user: me, body: `${REVIEW_MARKER}\n\nold review` },
    { id: 2, user: { login: "alice" }, body: `quoting ${REVIEW_MARKER}` }, // a human, leave alone
    { id: 5, user: { login: "other-app[bot]" }, body: `${REVIEW_MARKER}\n\nanother install` }, // another identity
    { id: 3, user: me, body: SUPERSEDED_BODY }, // already handled
    { id: 4, user: me, body: `${REVIEW_MARKER}\n\nnew review` }, // the one just posted
  ];

  function fakeClient(replies: { id: number; in_reply_to_id?: number }[] = []) {
    const listReviews = vi.fn();
    const listCommentsForReview = vi.fn();
    const listReviewComments = vi.fn();
    const updateReview = vi.fn().mockResolvedValue({});
    const graphql = vi.fn().mockResolvedValue({});
    const paginate = vi.fn(async (method: unknown, params: { review_id?: number }) => {
      if (method === listReviews) return reviews;
      if (method === listReviewComments) return replies;
      return [
        { id: params.review_id! * 100 + 1, node_id: `C_${params.review_id}_a` },
        { id: params.review_id! * 100 + 2, node_id: `C_${params.review_id}_b` },
      ];
    });
    const client = {
      rest: { pulls: { listReviews, listCommentsForReview, listReviewComments, updateReview } },
      graphql,
      paginate,
    } as unknown as Pick<Octokit, "rest" | "graphql" | "paginate">;
    return { client, updateReview, graphql };
  }

  it("replaces older reviews by the same author and minimizes their inline comments", async () => {
    const { client, updateReview, graphql } = fakeClient();
    const count = await supersedePreviousReviews(client, target, { reviewId: 4, author: "ai-reviewer" });

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

  it("leaves threads that have replies visible", async () => {
    const { client, graphql } = fakeClient([{ id: 101 }, { id: 500, in_reply_to_id: 101 }]);
    await supersedePreviousReviews(client, target, { reviewId: 4, author: "ai-reviewer" });
    expect(graphql.mock.calls.map(([, vars]) => vars)).toEqual([{ id: "C_1_b" }]);
  });

  it("works for non-bot identities such as a PAT user", async () => {
    const { client, updateReview } = fakeClient();
    await supersedePreviousReviews(client, target, { reviewId: 99, author: "alice" });
    expect(updateReview.mock.calls.map(([args]) => args.review_id)).toEqual([2]);
  });

  it("does nothing when the author is unknown", async () => {
    const { client, updateReview } = fakeClient();
    expect(await supersedePreviousReviews(client, target, { reviewId: 99, author: null })).toBe(0);
    expect(updateReview).not.toHaveBeenCalled();
  });

  it("superseded body cannot be mistaken for a live review", () => {
    expect(SUPERSEDED_BODY.includes(REVIEW_MARKER)).toBe(false);
  });
});
