import type { getOctokit } from "@actions/github";
import { renderFindingListItem, type InlineComment } from "./render.js";
import type { Finding } from "./schema.js";

export type Octokit = ReturnType<typeof getOctokit>;

export interface PublishTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
}

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
): Promise<"inline" | "body-only"> {
  const base = {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    commit_id: target.commitId,
    event: "COMMENT" as const,
  };
  try {
    await octokit.rest.pulls.createReview({ ...base, body: summary, comments: inline });
    return "inline";
  } catch (error) {
    if ((error as { status?: number }).status !== 422 || inline.length === 0) throw error;
    await octokit.rest.pulls.createReview({
      ...base,
      body: `${summary}\n\n### Inline findings\n\n${anchored.map(renderFindingListItem).join("\n")}`,
    });
    return "body-only";
  }
}
