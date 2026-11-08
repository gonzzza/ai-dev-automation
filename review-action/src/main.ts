import * as core from "@actions/core";
import * as github from "@actions/github";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_EXCLUDE, selectFiles } from "./diff.js";
import { publishReview, supersedePreviousReviews } from "./publish.js";
import { anchorFindings, renderSummary } from "./render.js";
import { EFFORTS, reviewDiff, type Effort } from "./review.js";
import { bySeverityDesc, parseFailOn, shouldFail } from "./schema.js";

async function run(): Promise<void> {
  const apiKey = core.getInput("anthropic-api-key");
  if (!apiKey) {
    // Typical for PRs from forks, which don't receive repository secrets.
    core.warning("anthropic-api-key is empty; skipping AI review.");
    return;
  }
  core.setSecret(apiKey);

  const pr = github.context.payload.pull_request;
  if (!pr) throw new Error("This action only runs on pull_request events.");

  const effort = core.getInput("effort") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  const failOn = parseFailOn(core.getInput("fail-on"));
  const maxChars = Number(core.getInput("max-diff-chars"));
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("max-diff-chars must be a positive integer");
  const exclude = [...DEFAULT_EXCLUDE, ...core.getMultilineInput("exclude").map((s) => s.trim()).filter(Boolean)];

  const octokit = github.getOctokit(core.getInput("github-token", { required: true }));
  const { owner, repo } = github.context.repo;

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const { included, skipped } = selectFiles(files, { exclude, maxChars });
  core.info(`Reviewing ${included.length} file(s), skipping ${skipped.length}.`);
  if (included.length === 0) {
    core.info("Nothing to review.");
    core.setOutput("findings", "0");
    core.setOutput("highest-severity", "none");
    return;
  }

  const result = await reviewDiff(
    new Anthropic({ apiKey }),
    { title: String(pr.title ?? ""), body: typeof pr.body === "string" ? pr.body : null },
    included,
    { model: core.getInput("model"), effort },
  );
  const { findings } = result.review;
  const { inline, anchored, unanchored } = anchorFindings(findings, included);
  const summary = renderSummary(result.review, unanchored, skipped, { ...result, reviewedFiles: included.length });

  const target = { owner, repo, pullNumber: pr.number, commitId: String(pr.head.sha) };
  const { mode, reviewId } = await publishReview(octokit, target, summary, inline, anchored);
  core.info(`Posted review: ${findings.length} finding(s), ${inline.length} inline (${mode}).`);

  try {
    const superseded = await supersedePreviousReviews(octokit, target, reviewId);
    if (superseded) core.info(`Marked ${superseded} earlier AI review(s) as outdated.`);
  } catch (error) {
    // Cosmetic cleanup: never fail the check over it.
    core.warning(`Could not mark earlier AI reviews as outdated: ${error instanceof Error ? error.message : String(error)}`);
  }

  core.setOutput("findings", String(findings.length));
  core.setOutput("highest-severity", [...findings].sort(bySeverityDesc)[0]?.severity ?? "none");

  if (shouldFail(findings, failOn)) {
    core.setFailed(`Found issues at or above severity "${failOn}".`);
  }
}

run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
