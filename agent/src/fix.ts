import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fillTemplate, type AgentRun, type AgentTask } from "./agent.js";
import { scanForSecrets, verifyChanges, type GateDeps } from "./gates.js";

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
});
export type Finding = z.infer<typeof FindingSchema>;

/** Bounds on what reaches the prompt. Over-long input is trimmed, not rejected, so a big review still gets fixed. */
export const MAX_FINDINGS = 50;
const FIELD_LIMITS = { path: 500, category: 50, title: 300, body: 20_000 } as const;
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
export const FINDINGS_TRAILER = "Agent-Fix-Findings";

export interface CycleRecord {
  cycle: number;
  /** Findings at or above the threshold that triggered that cycle. */
  findings: number;
}

/**
 * Parses `git log --format=%x00%(trailers:key=Agent-Fix-Cycle,key=Agent-Fix-Findings,unfold)`.
 * Commits without the cycle trailer (the agent's first commit, human merges) are skipped.
 */
export function parseCycleHistory(logOutput: string): CycleRecord[] {
  const records: CycleRecord[] = [];
  for (const commit of logOutput.split("\0")) {
    const value = (key: string) => new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m").exec(commit)?.[1];
    const cycle = value(CYCLE_TRAILER);
    if (cycle !== undefined) records.push({ cycle: Number(cycle), findings: Number(value(FINDINGS_TRAILER) ?? 0) });
  }
  return records.sort((a, b) => a.cycle - b.cycle);
}

export type FixDecision =
  | { action: "fix"; cycle: number; actionable: Finding[]; deferred: Finding[] }
  | { action: "none"; deferred: Finding[] }
  | { action: "stop"; reason: string; actionable: Finding[]; deferred: Finding[] };

/**
 * Whether to run another fix cycle. Findings below `minSeverity` are left for the human reviewer.
 * The cycle stops at `maxCycles`, and also when a cycle didn't reduce the number of actionable
 * findings, so the fixer and the reviewer can't trade the same issue back and forth.
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
  const last = history.at(-1);
  if (last && actionable.length >= last.findings) {
    return {
      action: "stop",
      reason:
        `No progress: fix cycle ${last.cycle} addressed ${last.findings} finding(s) at ${minSeverity} or above, ` +
        `and the review still reports ${actionable.length}.`,
      actionable,
      deferred,
    };
  }
  return { action: "fix", cycle: (last?.cycle ?? 0) + 1, actionable, deferred };
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Findings as tagged blocks for the prompt. Escaped, so a finding can't close its tag and add instructions. */
export function renderFindingsForPrompt(findings: Finding[]): string {
  return findings
    .map(
      (f, i) =>
        `<finding id="${i + 1}" severity="${f.severity}" category="${escapeXml(f.category)}" path="${escapeXml(f.path)}" line="${f.line}">\n` +
        `${escapeXml(f.title)}\n\n${escapeXml(f.body)}\n</finding>`,
    )
    .join("\n\n");
}

export const FIX_PROMPT_FILE = fileURLToPath(new URL("../fix-prompt.md", import.meta.url));

/** The spec an agent branch was built from: agent/<slug> came from specs/<slug>.md. */
export const specPathForBranch = (branch: string): string => `specs/${branch.replace(/^agent\//, "")}.md`;

/** The fix task, from agent/fix-prompt.md. `specBody` is undefined if the spec can't be found. */
export function fixTask(
  template: string,
  { branch, findings, writableDirs, specBody }: { branch: string; findings: Finding[]; writableDirs: string[]; specBody: string | undefined },
): AgentTask<FixReport> {
  const prompt = fillTemplate(template, {
    branch,
    writableDirs: writableDirs.join(", "),
    specPath: specPathForBranch(branch),
    specBody: specBody ?? "(No spec file found for this branch. Work from the code and the findings.)",
    findings: renderFindingsForPrompt(findings),
  });
  return { prompt, schema: FixReportSchema };
}

export async function loadFixTemplate(path: string = FIX_PROMPT_FILE): Promise<string> {
  return readFile(path, "utf8");
}

export function fixCommitMessage(cycle: number, actionable: number, report: FixReport): string {
  return `Address AI review findings (fix cycle ${cycle})\n\n${report.summary}\n\n${CYCLE_TRAILER}: ${cycle}\n${FINDINGS_TRAILER}: ${actionable}\n`;
}

/** Collapses model text to one line so it can't break the comment's list structure. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const where = (f: Finding) => `\`${oneLine(f.path)}:${f.line}\``;

function deferredSection(deferred: Finding[]): string[] {
  if (deferred.length === 0) return [];
  return ["**Left for human review:**", deferred.map((f) => `- ${f.severity}: ${oneLine(f.title)} (${where(f)})`).join("\n")];
}

export function fixComment(
  { cycle, maxCycles, actionable, deferred, model }: { cycle: number; maxCycles: number; actionable: Finding[]; deferred: Finding[]; model: string },
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
    `<sub>${model} · ${run.turns} turns · ${Math.round(run.durationMs / 1000)}s · $${run.costUsd.toFixed(2)} · a human approves the merge</sub>`,
  );
  return sections.join("\n\n");
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
}

export interface FixDeps extends GateDeps {
  git: FixGitOps;
  pullNumber: number;
  findings: Finding[];
  /** The commit the findings are about. The fix is refused if the branch has moved since. */
  reviewedSha?: string;
  minSeverity: Severity;
  maxCycles: number;
  model: string;
  /** Runs the agent on the findings, on `branch` (whose name gives the spec it was built from). */
  runAgent(findings: Finding[], branch: string): Promise<AgentRun<FixReport>>;
}

export type FixResult =
  | { status: "nothing-to-fix" }
  | { status: "stale" }
  | { status: "stopped"; reason: string; commentUrl: string }
  | { status: "declined"; commentUrl: string; run: AgentRun<FixReport> }
  | { status: "fixed"; cycle: number; commentUrl: string; run: AgentRun<FixReport> };

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
  const run = await deps.runAgent(actionable, branch);
  log(`Agent finished in ${run.turns} turns, $${run.costUsd.toFixed(2)}.`);
  // Before any other git command: the agent's run_checks calls ran its code, which could have
  // planted git config that a later command in this credentialed process would pick up.
  if ((await git.fingerprint()) !== gitStateBefore) {
    throw new Error(`The git state (HEAD, branch, .git/config or hooks) changed during the run. Nothing was committed; inspect ${branch}.`);
  }
  const context = { cycle, maxCycles: deps.maxCycles, actionable, deferred, model: deps.model };

  // No changes is a valid outcome, whether the agent declined every finding or found the code already
  // handles them: say why on the PR and end the cycle without a commit.
  if ((await git.changedFiles()).length === 0) {
    const body = fixComment(context, run, false);
    await scanForSecrets(deps, branch, [["the PR comment", body]], []);
    return { status: "declined", commentUrl: await git.commentOnPullRequest(pullNumber, body), run };
  }

  const files = await verifyChanges(deps, branch, gitStateBefore);
  const message = fixCommitMessage(cycle, actionable.length, run.report);
  const body = fixComment(context, run, true);
  await scanForSecrets(deps, branch, [["the commit message", message], ["the PR comment", body]], files);

  await git.commit(files, message);
  await git.push(branch);
  return { status: "fixed", cycle, commentUrl: await git.commentOnPullRequest(pullNumber, body), run };
}
