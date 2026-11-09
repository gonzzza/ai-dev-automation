import type { getOctokit } from "@actions/github";
import { fitBody, renderFindingListItem, REVIEW_MARKER, type InlineComment } from "./render.js";
import type { Finding } from "./schema.js";

export type Octokit = ReturnType<typeof getOctokit>;
type Client = Pick<Octokit, "rest" | "graphql" | "paginate">;

export interface PublishTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
}

export interface PublishedReview {
  mode: "inline" | "body-only";
  reviewId: number;
  /** Login that authored the review (the token's identity: a bot, PAT user or machine user). */
  author: string | null;
}

/** Body that replaces an older AI review. Deliberately does not contain REVIEW_MARKER. */
export const SUPERSEDED_BODY =
  "<!-- ai-dev-automation:review-superseded -->\n\n_🤖 This AI review is outdated. See the latest one below._";

/**
 * Post one PR review with inline comments. If GitHub rejects the inline
 * comments (422, e.g. a line is no longer part of the diff), post again with
 * those findings folded into the review body so nothing is lost.
 */
export async function publishReview(
  octokit: Pick<Octokit, "rest">,
  target: PublishTarget,
  summary: string,
  inline: InlineComment[],
  anchored: Finding[],
): Promise<PublishedReview> {
  const base = {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    commit_id: target.commitId,
    event: "COMMENT" as const,
  };
  try {
    const { data } = await octokit.rest.pulls.createReview({
      ...base,
      body: fitBody(summary),
      comments: inline.map((c) => ({ ...c, body: fitBody(c.body) })),
    });
    return { mode: "inline", reviewId: data.id, author: data.user?.login ?? null };
  } catch (error) {
    // Bodies are size-capped above, so a 422 here means GitHub could not anchor an inline comment.
    if ((error as { status?: number }).status !== 422 || inline.length === 0) throw error;
    const { data } = await octokit.rest.pulls.createReview({
      ...base,
      body: fitBody(`${summary}\n\n### Inline findings\n\n${anchored.map(renderFindingListItem).join("\n")}`),
    });
    return { mode: "body-only", reviewId: data.id, author: data.user?.login ?? null };
  }
}

/**
 * The ids of the inline comments a review created, in the order of `inline` (undefined where none
 * matched). createReview doesn't return them, so they are read back and matched on path, line and
 * body; identical comments are matched in order.
 */
export async function inlineCommentIds(
  octokit: Pick<Octokit, "rest" | "paginate">,
  target: PublishTarget,
  reviewId: number,
  inline: InlineComment[],
): Promise<(number | undefined)[]> {
  const { owner, repo, pullNumber } = target;
  const posted = await octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
    owner,
    repo,
    pull_number: pullNumber,
    review_id: reviewId,
    per_page: 100,
  });
  const unclaimed = [...posted];
  return inline.map((c) => {
    const body = fitBody(c.body);
    const i = unclaimed.findIndex((p) => p.path === c.path && (p.line ?? p.original_line) === c.line && p.body === body);
    return i === -1 ? undefined : unclaimed.splice(i, 1)[0]!.id;
  });
}

const MINIMIZE = `mutation($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId }
}`;

/**
 * Keep one live AI review per PR: earlier ones by the same author get their body replaced and
 * their unanswered inline comments collapsed as outdated. Runs after the new review is
 * posted, so a failed run never leaves the PR without a review.
 * Returns the number of reviews superseded.
 */
export async function supersedePreviousReviews(
  octokit: Client,
  target: PublishTarget,
  latest: Pick<PublishedReview, "reviewId" | "author">,
): Promise<number> {
  const { owner, repo, pullNumber } = target;
  // Only touch reviews posted by the same identity: never another app's or a human's.
  if (!latest.author) return 0;
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber, per_page: 100 });
  const stale = reviews.filter(
    (r) => r.id !== latest.reviewId && r.user?.login === latest.author && r.body.includes(REVIEW_MARKER),
  );

  if (stale.length === 0) return 0;

  // A thread someone replied to (such as the fix cycle's "Fixed in <sha>") stays visible: the
  // conversation is the record of how the finding was settled.
  const all = await octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: pullNumber, per_page: 100 });
  const answered = new Set(all.map((c) => c.in_reply_to_id).filter((id) => id !== undefined));

  for (const review of stale) {
    await octokit.rest.pulls.updateReview({ owner, repo, pull_number: pullNumber, review_id: review.id, body: SUPERSEDED_BODY });
    const comments = await octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
      owner,
      repo,
      pull_number: pullNumber,
      review_id: review.id,
      per_page: 100,
    });
    for (const comment of comments) {
      if (answered.has(comment.id)) continue;
      await octokit.graphql(MINIMIZE, { id: comment.node_id });
    }
  }
  return stale.length;
}
