import type Anthropic from "@anthropic-ai/sdk";
import { loadStandards, selectStandards, type Standard } from "standards";
import { DEFAULT_EXCLUDE, selectFiles } from "./diff.js";
import { inlineCommentIds, publishReview, supersedePreviousReviews, type Octokit } from "./publish.js";
import { anchorFindings, renderSummary, type StandardsSummary } from "./render.js";
import { EFFORTS, reviewDiff, type Effort } from "./review.js";
import { bySeverityDesc, parseFailOn, shouldFail, type Finding } from "./schema.js";

/** The parts of @actions/core this action uses. */
export interface ActionIO {
  getInput(name: string): string;
  getMultilineInput(name: string): string[];
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  setSecret(secret: string): void;
  info(message: string): void;
  warning(message: string): void;
}

export interface PullRequestPayload {
  number: number;
  title?: unknown;
  body?: unknown;
  /** Total files in the PR, which can exceed what the files API lists (3,000). */
  changed_files?: number;
  head: { sha: string };
}

export interface RunDeps {
  io: ActionIO;
  repo: { owner: string; repo: string };
  pullRequest: PullRequestPayload | undefined;
  createOctokit(token: string): Pick<Octokit, "rest" | "graphql" | "paginate">;
  createAnthropic(apiKey: string): Pick<Anthropic, "beta">;
}

/** Caps for `findings-json`. Consumers often pass it through an env var, and Linux caps one at 128 KB. */
export const FINDINGS_JSON_MAX_BYTES = 64_000;
export const FINDING_BODY_MAX_CHARS = 4_000;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * The findings for automation downstream, such as the agent's fix cycle: most severe first, long
 * bodies truncated, and lower-severity findings dropped once the JSON would pass the size cap.
 * A finding posted as an inline comment carries that comment's `commentId`, so a fixer can reply
 * on its thread. The inline comments always carry everything. Model output: consumers must validate it.
 */
export function findingsJson(findings: Finding[], commentIds: ReadonlyMap<Finding, number> = new Map()): string {
  const kept: Finding[] = [];
  let size = 2; // "[]"
  for (const finding of [...findings].sort(bySeverityDesc)) {
    // Every field is clipped, so one finding always fits and the output is never empty while
    // highest-severity reports something.
    const entry = {
      ...finding,
      path: clip(finding.path, 500),
      title: clip(finding.title, 300),
      body: clip(finding.body, FINDING_BODY_MAX_CHARS),
      ...(commentIds.has(finding) ? { commentId: commentIds.get(finding)! } : {}),
    };
    const entrySize = Buffer.byteLength(JSON.stringify(entry)) + 1; // UTF-8 bytes, + the comma
    if (size + entrySize > FINDINGS_JSON_MAX_BYTES) break;
    kept.push(entry);
    size += entrySize;
  }
  return JSON.stringify(kept);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface StandardsConfig {
  standards: Standard[];
  maxChars: number;
  ref: string;
}

/**
 * Read the standards inputs and load the standards. Undefined when `standards-path` is empty, which
 * turns the feature off. Throws on a bad input, a missing directory or pack, or an invalid standard.
 */
export async function readStandardsConfig(io: Pick<ActionIO, "getInput" | "info">): Promise<StandardsConfig | undefined> {
  const path = io.getInput("standards-path").trim();
  if (!path) return undefined;
  const maxChars = Number(io.getInput("max-standards-chars"));
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("max-standards-chars must be a positive integer");
  const packs = io
    .getInput("standards-packs")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const standards = await loadStandards(path, packs.length ? packs : undefined);
  io.info(`Loaded ${standards.length} standard(s) from ${path}.`);
  return { standards, maxChars, ref: io.getInput("standards-ref").trim() };
}

/** Validate inputs, review the PR, post the result. Throws on configuration or API errors. */
export async function run({ io, repo: { owner, repo }, pullRequest: pr, createOctokit, createAnthropic }: RunDeps): Promise<void> {
  const apiKey = io.getInput("anthropic-api-key");
  if (!apiKey) {
    // Typical for PRs from forks, which don't receive repository secrets.
    io.warning("anthropic-api-key is empty; skipping AI review.");
    return;
  }
  io.setSecret(apiKey);

  if (!pr) throw new Error("This action only runs on pull_request events.");

  const effort = io.getInput("effort") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  const failOn = parseFailOn(io.getInput("fail-on"));
  const maxChars = Number(io.getInput("max-diff-chars"));
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("max-diff-chars must be a positive integer");
  const exclude = [...DEFAULT_EXCLUDE, ...io.getMultilineInput("exclude").map((s) => s.trim()).filter(Boolean)];
  const standardsConfig = await readStandardsConfig(io);

  const octokit = createOctokit(io.getInput("github-token"));
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
  const { included, skipped } = selectFiles(files, { exclude, maxChars });
  const unlisted = (pr.changed_files ?? 0) - files.length;
  if (unlisted > 0) {
    skipped.push({ path: `${unlisted} more file(s)`, reason: `not listed: GitHub's API returns at most ${files.length} files per PR` });
  }
  io.info(`Reviewing ${included.length} file(s), skipping ${skipped.length}.`);
  if (included.length === 0) {
    io.info("Nothing to review.");
    io.setOutput("findings", "0");
    io.setOutput("highest-severity", "none");
    io.setOutput("findings-json", "[]");
    return;
  }

  let standards: Standard[] = [];
  let standardsSummary: StandardsSummary | undefined;
  if (standardsConfig) {
    const { selected, dropped } = selectStandards(standardsConfig.standards, {
      use: "review",
      paths: included.map((f) => f.path),
      maxChars: standardsConfig.maxChars,
    });
    standards = selected;
    const ids = (list: Standard[]) => list.map((s) => s.id);
    io.info(`Checking ${selected.length} standard(s): ${ids(selected).join(", ") || "none apply"}.`);
    if (dropped.length) {
      io.warning(`Not checking ${ids(dropped).join(", ")}: over the max-standards-chars budget (${standardsConfig.maxChars}).`);
    }
    standardsSummary = { checked: ids(selected), dropped: ids(dropped), ...(standardsConfig.ref ? { ref: standardsConfig.ref } : {}) };
  }

  const result = await reviewDiff(
    createAnthropic(apiKey),
    { title: String(pr.title ?? ""), body: typeof pr.body === "string" ? pr.body : null },
    included,
    { model: io.getInput("model"), effort, standards },
  );
  const { findings } = result.review;
  const { inline, anchored, unanchored } = anchorFindings(findings, included);
  const summary = renderSummary(result.review, unanchored, skipped, {
    ...result,
    reviewedFiles: included.length,
    standards: standardsSummary,
  });

  const target = { owner, repo, pullNumber: pr.number, commitId: pr.head.sha };
  const published = await publishReview(octokit, target, summary, inline, anchored);
  io.info(`Posted review: ${findings.length} finding(s), ${inline.length} inline (${published.mode}).`);

  // For the fix cycle's replies. Optional: without ids the findings still work, just without threads.
  const commentIds = new Map<Finding, number>();
  if (published.mode === "inline") {
    try {
      const ids = await inlineCommentIds(octokit, target, published.reviewId, inline);
      anchored.forEach((finding, i) => {
        const id = ids[i];
        if (id !== undefined) commentIds.set(finding, id);
      });
    } catch (error) {
      io.warning(`Could not read back the inline comment ids: ${errorMessage(error)}`);
    }
  }

  try {
    const superseded = await supersedePreviousReviews(octokit, target, published);
    if (superseded) io.info(`Marked ${superseded} earlier AI review(s) as outdated.`);
  } catch (error) {
    // Cosmetic cleanup: never fail the check over it.
    io.warning(`Could not mark earlier AI reviews as outdated: ${errorMessage(error)}`);
  }

  io.setOutput("findings", String(findings.length));
  io.setOutput("highest-severity", [...findings].sort(bySeverityDesc)[0]?.severity ?? "none");
  io.setOutput("findings-json", findingsJson(findings, commentIds));

  if (shouldFail(findings, failOn)) {
    io.setFailed(`Found issues at or above severity "${failOn}".`);
  }
}
