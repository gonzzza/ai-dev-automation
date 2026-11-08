import { describe, expect, it, vi } from "vitest";
import { publishReview, type Octokit } from "../src/publish.js";
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
    const createReview = vi.fn().mockResolvedValue({});
    const mode = await publishReview(fakeOctokit(createReview), target, "summary", inline, [finding]);

    expect(mode).toBe("inline");
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
    const createReview = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 })).mockResolvedValue({});
    const mode = await publishReview(fakeOctokit(createReview), target, "summary", inline, [finding]);

    expect(mode).toBe("body-only");
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
