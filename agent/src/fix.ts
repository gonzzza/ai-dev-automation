import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fillTemplate, type AgentRun, type AgentTask } from "./agent.js";
import { scanForSecrets, verifyChanges, type GateDeps } from "./gates.js";
import { RUN_TRAILER, runFooter } from "./pr.js";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
const rank = (s: Severity): number => SEVERITIES.indexOf(s);

/**
 * A finding from the review action's `findings-json` output. It is model output about a diff the
 * agent wrote, so it is validated here and treated like a spec: untrusted input to the fixer.
 */
export const FindingSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  category: z.string(),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  body: z.string(),
  /** The org standard the finding says is broken, e.g. "TS-002". The fixer finds its text in the system prompt. */
  rule: z.string().optional(),
  /** The inline review comment that holds the finding, when there is one: the fix cycle replies on its thread. */
  commentId: z.number().int().positive().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Bounds on what reaches the prompt. Over-long input is trimmed, not rejected, so a big review still gets fixed. */
export const MAX_FINDINGS = 50;
const FIELD_LIMITS = { path: 500, category: 50, rule: 50, title: 300, body: 20_000 } as const;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function parseFindings(json: string): Finding[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Findings are not valid JSON.");
  }
  const result = z.array(FindingSchema).safeParse(data);
  if (!result.success) throw new Error(`Findings do not match the expected shape: ${result.error.message}`);
  // The review action sorts most severe first, so keeping the head keeps what matters.
  return result.data.slice(0, MAX_FINDINGS).map((f) => ({
    ...f,
    path: clip(f.path, FIELD_LIMITS.path),
    category: clip(f.category, FIELD_LIMITS.category),
    ...(f.rule !== undefined ? { rule: clip(f.rule, FIELD_LIMITS.rule) } : {}),
    title: clip(f.title, FIELD_LIMITS.title),
    body: clip(f.body, FIELD_LIMITS.body),
  }));
}

export const FixReportSchema = z.object({
  outcomes: z
    .array(
      z.object({
        finding: z.number().int().describe("The id of the finding, as given in the prompt."),
        outcome: z.enum(["fixed", "declined"]),
        explanation: z.string().describe("One or two sentences: what you changed, or why the finding is wrong or not worth changing."),
      }),
    )
    .describe("One entry per finding, in the order given."),
  summary: z.string().describe("What you changed overall, 1-3 sentences, for the commit message."),
  testing: z.string().describe("Tests you added or changed. Empty if none."),
  checksPassed: z.boolean().describe("Whether the last run_checks call returned PASSED."),
});
export type FixReport = z.infer<typeof FixReportSchema>;

/** Trailers on the agent's fix commits. The PR branch is the only state the cycle keeps between runs. */
export const CYCLE_TRAILER = "Agent-Fix-Cycle";
/** One per finding the cycle worked on, fixed or declined: "<category> <line> <path>". */
export const ADDRESSED_TRAILER = "Agent-Fix-Addressed";

/** Enough of a finding to recognize it in a later review, whose wording and line numbers drift. */
export interface FindingKey {
  category: string;
  line: number;
  path: string;
}

export interface CycleRecord {
  cycle: number;
  /** The findings that cycle worked on. Empty for commits from before this trailer existed. */
  addressed: FindingKey[];
}

/** How far a finding's line may move between reviews and still count as the same finding. */
export const LINE_TOLERANCE = 25;

/**
 * Same file, same category, roughly the same place. Titles are not compared: the reviewer
 * rewords the same issue from one run to the next.
 */
export function sameFinding(key: FindingKey, finding: Finding): boolean {
  return key.path === oneLine(finding.path) && key.category === trailerWord(finding.category) && Math.abs(key.line - finding.line) <= LINE_TOLERANCE;
}

const trailerWord = (text: string) => text.replace(/\s+/g, "-") || "-";

/**
 * Parses `git log --format=%x00%(trailers:key=Agent-Fix-Cycle,key=Agent-Fix-Addressed,unfold)`.
 * Commits without the cycle trailer (the agent's first commit, human merges) are skipped.
 */
export function parseCycleHistory(logOutput: string): CycleRecord[] {
  const records: CycleRecord[] = [];
  for (const commit of logOutput.split("\0")) {
    const cycle = new RegExp(`^${CYCLE_TRAILER}:\\s*(\\d+)\\s*$`, "m").exec(commit)?.[1];
    if (cycle === undefined) continue;
    const addressed = [...commit.matchAll(new RegExp(`^${ADDRESSED_TRAILER}:\\s*(\\S+)\\s+(\\d+)\\s+(.+?)\\s*$`, "gm"))].map(
      ([, category, line, path]) => ({ category: category!, line: Number(line), path: path! }),
    );
    records.push({ cycle: Number(cycle), addressed });
  }
  return records.sort((a, b) => a.cycle - b.cycle);
}

export type FixDecision =
  | { action: "fix"; cycle: number; actionable: Finding[]; deferred: Finding[] }
  | { action: "none"; deferred: Finding[] }
  | { action: "stop"; reason: string; actionable: Finding[]; deferred: Finding[] };

/**
 * Whether to run another fix cycle. Findings below `minSeverity` are left for the human reviewer.
 * The cycle stops at `maxCycles`, and as soon as the review raises a finding an earlier cycle
 * already worked on: the fixer and the reviewer disagree, and a human should settle it rather
 * than let them trade the same issue back and forth. New findings alone keep the cycle going.
 */
export function decideFix(
  history: CycleRecord[],
  findings: Finding[],
  { minSeverity, maxCycles }: { minSeverity: Severity; maxCycles: number },
): FixDecision {
  const actionable = findings.filter((f) => rank(f.severity) >= rank(minSeverity));
  const deferred = findings.filter((f) => rank(f.severity) < rank(minSeverity));
  if (actionable.length === 0) return { action: "none", deferred };

  if (history.length >= maxCycles) {
    return { action: "stop", reason: `Reached the limit of ${maxCycles} fix cycles.`, actionable, deferred };
  }
  for (const record of history) {
    const repeat = actionable.find((f) => record.addressed.some((key) => sameFinding(key, f)));
    if (repeat) {
      return {
        action: "stop",
        reason: `The review raised a finding that fix cycle ${record.cycle} already worked on: ${oneLine(repeat.title)} (${where(repeat)}).`,
        actionable,
        deferred,
      };
    }
  }
  return { action: "fix", cycle: (history.at(-1)?.cycle ?? 0) + 1, actionable, deferred };
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Findings as tagged blocks for the prompt. Escaped, so a finding can't close its tag and add instructions.
 * `idPrefix` keeps context-only findings (D1, D2…) from sharing ids with the ones the agent reports on.
 */
export function renderFindingsForPrompt(findings: Finding[], idPrefix = ""): string {
  return findings
    .map(
      (f, i) =>
        `<finding id="${idPrefix}${i + 1}" severity="${f.severity}" category="${escapeXml(f.category)}" path="${escapeXml(f.path)}" line="${f.line}"${f.rule !== undefined ? ` rule="${escapeXml(f.rule)}"` : ""}>\n` +
        `${escapeXml(f.title)}\n\n${escapeXml(f.body)}\n</finding>`,
    )
    .join("\n\n");
}

export const FIX_PROMPT_FILE = fileURLToPath(new URL("../fix-prompt.md", import.meta.url));

/** The spec an agent branch was built from: agent/<slug> came from specs/<slug>.md. */
export const specPathForBranch = (branch: string): string => `specs/${branch.replace(/^agent\//, "")}.md`;

/**
 * The fix task, from agent/fix-prompt.md. `deferred` are the findings below the threshold: the agent
 * doesn't fix them, but sees them so it doesn't write code or tests that lock in what they describe.
 * `specBody` is undefined if the spec can't be found.
 */
export function fixTask(
  template: string,
  {
    branch,
    findings,
    deferred,
    writableDirs,
    specBody,
  }: { branch: string; findings: Finding[]; deferred: Finding[]; writableDirs: string[]; specBody: string | undefined },
): AgentTask<FixReport> {
  const prompt = fillTemplate(template, {
    branch,
    writableDirs: writableDirs.join(", "),
    specPath: specPathForBranch(branch),
    specBody: specBody ?? "(No spec file found for this branch. Work from the code and the findings.)",
    findings: renderFindingsForPrompt(findings),
    deferred: deferred.length ? renderFindingsForPrompt(deferred, "D") : "(none)",
  });
  return { prompt, schema: FixReportSchema };
}

export async function loadFixTemplate(path: string = FIX_PROMPT_FILE): Promise<string> {
  return readFile(path, "utf8");
}

export function fixCommitMessage(cycle: number, actionable: Finding[], report: FixReport, runId?: string): string {
  const addressed = actionable.map((f) => `${ADDRESSED_TRAILER}: ${trailerWord(f.category)} ${f.line} ${oneLine(f.path)}`);
  const trailers = [`${CYCLE_TRAILER}: ${cycle}`, ...addressed, ...(runId ? [`${RUN_TRAILER}: ${runId}`] : [])];
  return `Address AI review findings (fix cycle ${cycle})\n\n${report.summary}\n\n${trailers.join("\n")}\n`;
}

/** Collapses model text to one line so it can't break the comment's list structure. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const where = (f: Finding) => `\`${oneLine(f.path)}:${f.line}\``;

function deferredSection(deferred: Finding[]): string[] {
  if (deferred.length === 0) return [];
  return ["**Left for human review:**", deferred.map((f) => `- ${f.severity}: ${oneLine(f.title)} (${where(f)})`).join("\n")];
}

export function fixComment(
  {
    cycle,
    maxCycles,
    actionable,
    deferred,
    model,
    runId,
    runLink,
  }: { cycle: number; maxCycles: number; actionable: Finding[]; deferred: Finding[]; model: string; runId?: string; runLink?: string },
  run: AgentRun<FixReport>,
  committed: boolean,
): string {
  const outcomes = actionable.map((f, i) => {
    const o = run.report.outcomes.find((x) => x.finding === i + 1);
    const mark = o?.outcome === "fixed" ? "✅ Fixed" : o?.outcome === "declined" ? "❎ Declined" : "⚠️ Not addressed";
    return `- ${mark} · ${f.severity}: ${oneLine(f.title)} (${where(f)})${o ? `\n  ${oneLine(o.explanation)}` : ""}`;
  });
  const sections = [
    `🤖 **Fix cycle ${cycle} of ${maxCycles}.** The agent worked through the AI review's findings at medium severity or above.`,
    outcomes.join("\n"),
  ];
  if (run.report.testing.trim()) sections.push(`**Testing:** ${oneLine(run.report.testing)}`);
  sections.push(
    committed
      ? "Pushed as one commit; the AI review runs again on it. The harness re-ran `npm run check` before committing."
      : "Nothing was committed, so the cycle ends here. A human should review the declined findings.",
    ...deferredSection(deferred),
    runFooter(model, run, { runId, runLink }).replace("</sub>", " · a human approves the merge</sub>"),
  );
  return sections.join("\n\n");
}

/** A reply on one finding's review thread. `explanation` is model output; the rest is the harness's. */
export interface ThreadReply {
  commentId: number;
  outcome: "fixed" | "declined";
  explanation: string;
}

/**
 * Replies for the findings that have an inline thread. A "fixed" outcome only gets a reply when
 * there is a commit to point at; the agent saying so is not enough. Unaddressed findings get none:
 * the summary comment lists them.
 */
export function threadReplies(actionable: Finding[], report: FixReport, committed: boolean): ThreadReply[] {
  return actionable.flatMap((f, i) => {
    const o = report.outcomes.find((x) => x.finding === i + 1);
    if (f.commentId === undefined || !o || (o.outcome === "fixed" && !committed)) return [];
    return [{ commentId: f.commentId, outcome: o.outcome, explanation: oneLine(o.explanation) }];
  });
}

/** GitHub links a full commit SHA in a comment to the commit. */
export function threadReplyBody(reply: ThreadReply, cycle: number, sha: string | undefined): string {
  const head =
    reply.outcome === "fixed" && sha ? `✅ **Fixed in ${sha}** (fix cycle ${cycle}).` : `❎ **Declined** in fix cycle ${cycle}; left for a human reviewer.`;
  return `🤖 ${head}\n\n${reply.explanation}`;
}

export function stopComment(reason: string, actionable: Finding[], deferred: Finding[]): string {
  return [
    `🤖 **Fix cycle stopped.** ${reason} Handing over to a human reviewer.`,
    "**Still open:**",
    actionable.map((f) => `- ${f.severity}: ${oneLine(f.title)} (${where(f)})`).join("\n"),
    ...deferredSection(deferred),
  ].join("\n\n");
}

export interface PullRequestInfo {
  state: string;
  /** As `gh pr view` reports it: a GitHub App's bot is `app/<slug>` with `is_bot` set. */
  author: { login: string; is_bot?: boolean };
  isCrossRepository: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
}

export interface FixGitOps {
  currentBranch(): Promise<string>;
  changedFiles(): Promise<string[]>;
  headSha(): Promise<string>;
  fingerprint(): Promise<string>;
  commit(files: string[], message: string): Promise<void>;
  push(branch: string): Promise<unknown>;
  pullRequest(number: number): Promise<PullRequestInfo>;
  /** Raw `git log` output of the trailers on commits in `range`, for parseCycleHistory. */
  cycleTrailers(range: string): Promise<string>;
  commentOnPullRequest(number: number, body: string): Promise<string>;
  replyToReviewComment(number: number, commentId: number, body: string): Promise<void>;
  /** Resolves the review thread that starts with `commentId`. */
  resolveReviewThread(number: number, commentId: number): Promise<void>;
}

export interface FixDeps extends GateDeps {
  git: FixGitOps;
  pullNumber: number;
  findings: Finding[];
  /** The commit the findings are about. The fix is refused if the branch has moved since. */
  reviewedSha?: string;
  /** The slug of the agent's GitHub App. When set, the fix is refused unless that App opened the PR. */
  agentApp?: string;
  minSeverity: Severity;
  maxCycles: number;
  model: string;
  /** Goes into the commit trailer and the PR comment; `runLink` points at the CI run that holds the log. */
  runId?: string;
  runLink?: string;
  /** Runs the agent on the findings, with the deferred ones as context, on `branch` (whose name gives the spec). */
  runAgent(findings: Finding[], deferred: Finding[], branch: string): Promise<AgentRun<FixReport>>;
}

export type FixResult =
  | { status: "nothing-to-fix" }
  | { status: "stale" }
  | { status: "stopped"; reason: string; commentUrl: string }
  | { status: "declined"; commentUrl: string; run: AgentRun<FixReport> }
  | { status: "fixed"; cycle: number; commentUrl: string; run: AgentRun<FixReport> };

/**
 * Whether a GitHub App's bot opened the PR. A user can't be named `app/<slug>`, and `is_bot` rules
 * out a person who registered the App's slug as a username.
 */
export function openedByApp(author: PullRequestInfo["author"], appSlug: string): boolean {
  return author.is_bot === true && author.login === `app/${appSlug}`;
}

/**
 * One fix cycle on an open agent PR: findings → agent → the same gates as a new PR → one commit →
 * push → summary comment. The push makes the review run again, which may start the next cycle.
 */
export async function runFixCycle(deps: FixDeps): Promise<FixResult> {
  const { git, pullNumber, log } = deps;

  // Preflight: only the agent's own PRs from this repo, checked out at exactly the reviewed commit.
  const pr = await git.pullRequest(pullNumber);
  if (pr.state !== "OPEN") throw new Error(`PR #${pullNumber} is ${pr.state.toLowerCase()}.`);
  if (pr.isCrossRepository) throw new Error(`PR #${pullNumber} comes from a fork; the fix cycle only runs on branches in this repository.`);
  const branch = pr.headRefName;
  if (!branch.startsWith("agent/")) throw new Error(`PR #${pullNumber} is not an agent PR (branch ${branch}); the fix cycle only touches agent/* branches.`);
  // Anyone who can push can name a branch agent/*. Only the App can open a PR as the App.
  if (deps.agentApp !== undefined && !openedByApp(pr.author, deps.agentApp)) {
    throw new Error(`PR #${pullNumber} was opened by ${pr.author.login}, not the agent's App (${deps.agentApp}); the fix cycle only touches the agent's own PRs.`);
  }
  const current = await git.currentBranch();
  if (current !== branch) throw new Error(`Check out ${branch} first (currently on ${current}).`);
  const dirty = await git.changedFiles();
  if (dirty.length) throw new Error(`Working tree is not clean:\n${dirty.map((f) => `  ${f}`).join("\n")}`);
  const head = await git.headSha();
  if (head !== pr.headRefOid) throw new Error(`Local ${branch} is at ${head}, but the PR is at ${pr.headRefOid}. Pull first.`);
  // Not an error: someone pushed after the review, and the review of that push decides the next cycle.
  if (deps.reviewedSha && deps.reviewedSha !== head) {
    log(`The findings are about ${deps.reviewedSha}, but ${branch} has moved to ${head}. Skipping; the review of the new commit decides.`);
    return { status: "stale" };
  }

  const history = parseCycleHistory(await git.cycleTrailers(`origin/${pr.baseRefName}..HEAD`));
  const decision = decideFix(history, deps.findings, deps);
  if (decision.action === "none") {
    log(`No findings at ${deps.minSeverity} or above. Nothing to fix.`);
    return { status: "nothing-to-fix" };
  }
  if (decision.action === "stop") {
    log(decision.reason);
    const body = stopComment(decision.reason, decision.actionable, decision.deferred);
    await scanForSecrets(deps, branch, [["the PR comment", body]], []);
    return { status: "stopped", reason: decision.reason, commentUrl: await git.commentOnPullRequest(pullNumber, body) };
  }

  const { cycle, actionable, deferred } = decision;
  log(`Fix cycle ${cycle} of ${deps.maxCycles} on ${branch}: ${actionable.length} finding(s), ${deferred.length} left for the human.`);
  const gitStateBefore = await git.fingerprint();
  const run = await deps.runAgent(actionable, deferred, branch);
  log(`Agent finished in ${run.turns} turns, $${run.costUsd.toFixed(2)}.`);
  // Before any other git command: the agent's run_checks calls ran its code, which could have
  // planted git config that a later command in this credentialed process would pick up.
  if ((await git.fingerprint()) !== gitStateBefore) {
    throw new Error(`The git state (HEAD, branch, .git/config or hooks) changed during the run. Nothing was committed; inspect ${branch}.`);
  }
  const context = { cycle, maxCycles: deps.maxCycles, actionable, deferred, model: deps.model, runId: deps.runId, runLink: deps.runLink };

  // No changes is a valid outcome, whether the agent declined every finding or found the code already
  // handles them: say why on the PR and end the cycle without a commit.
  if ((await git.changedFiles()).length === 0) {
    const body = fixComment(context, run, false);
    const replies = threadReplies(actionable, run.report, false);
    await scanForSecrets(deps, branch, [["the PR comment", body], ...replyTexts(replies)], []);
    const commentUrl = await git.commentOnPullRequest(pullNumber, body);
    await postThreadReplies(deps, replies, cycle, undefined);
    return { status: "declined", commentUrl, run };
  }

  const files = await verifyChanges(deps, branch, gitStateBefore);
  const message = fixCommitMessage(cycle, actionable, run.report, deps.runId);
  const body = fixComment(context, run, true);
  const replies = threadReplies(actionable, run.report, true);
  await scanForSecrets(deps, branch, [["the commit message", message], ["the PR comment", body], ...replyTexts(replies)], files);

  await git.commit(files, message);
  const sha = await git.headSha();
  await git.push(branch);
  const commentUrl = await git.commentOnPullRequest(pullNumber, body);
  // After the push, so every reply points at a commit that exists on GitHub.
  await postThreadReplies(deps, replies, cycle, sha);
  return { status: "fixed", cycle, commentUrl, run };
}

const replyTexts = (replies: ThreadReply[]): [string, string][] =>
  replies.map((r) => [`the reply to review comment ${r.commentId}`, r.explanation]);

/**
 * Replies on each finding's thread and resolves the fixed ones. Best-effort: the commit is pushed
 * and the summary comment covers every finding, so a failed reply is logged, not thrown.
 */
async function postThreadReplies(deps: FixDeps, replies: ThreadReply[], cycle: number, sha: string | undefined): Promise<void> {
  for (const reply of replies) {
    try {
      await deps.git.replyToReviewComment(deps.pullNumber, reply.commentId, threadReplyBody(reply, cycle, sha));
      if (reply.outcome === "fixed") await deps.git.resolveReviewThread(deps.pullNumber, reply.commentId);
    } catch (error) {
      deps.log(`Warning: could not reply on review comment ${reply.commentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
