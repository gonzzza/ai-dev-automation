import type { getOctokit } from "@actions/github";
import { renderFindingListItem, REVIEW_MARKER, type InlineComment } from "./render.js";
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
    const { data } = await octokit.rest.pulls.createReview({ ...base, body: summary, comments: inline });
    return { mode: "inline", reviewId: data.id, author: data.user?.login ?? null };
  } catch (error) {
    if ((error as { status?: number }).status !== 422 || inline.length === 0) throw error;
    const { data } = await octokit.rest.pulls.createReview({
      ...base,
      body: `${summary}\n\n### Inline findings\n\n${anchored.map(renderFindingListItem).join("\n")}`,
    });
    return { mode: "body-only", reviewId: data.id, author: data.user?.login ?? null };
  }
}

const MINIMIZE = `mutation($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId }
}`;

/**
 * Keep one live AI review per PR: earlier ones by the same author get their body replaced and
 * their inline comments collapsed as outdated. Runs after the new review is
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
      await octokit.graphql(MINIMIZE, { id: comment.node_id });
    }
  }
  return stale.length;
}
