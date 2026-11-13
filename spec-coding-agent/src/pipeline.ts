import type { AgentRun } from "./agent.js";
import { scanForSecrets, verifyChanges, type GateDeps } from "./gates.js";
import { branchName, commitMessage, prBody, prTitle, type PrStandards } from "./pr.js";
import type { Spec } from "./spec.js";
import { parsePrTemplate, PR_TEMPLATE_PATH, type PrTemplate } from "./template.js";

/** The git operations the pipeline needs; implemented by Git, faked in tests. */
export interface GitOps {
  currentBranch(): Promise<string>;
  changedFiles(): Promise<string[]>;
  branchExists(name: string): Promise<boolean>;
  /** Exact match on origin alone. Throws when origin can't be read. */
  branchExistsOnOrigin(name: string): Promise<boolean>;
  createBranch(name: string): Promise<unknown>;
  /** Creates the branch on origin at its current commit, or fails if origin already has it. */
  claimBranch(name: string): Promise<unknown>;
  headSha(): Promise<string>;
  /** Whether HEAD is origin/<base> or an ancestor of it. */
  headOnBase(base: string): Promise<boolean>;
  commit(files: string[], message: string): Promise<void>;
  push(branch: string): Promise<unknown>;
  openPullRequest(title: string, body: string, base: string, head: string): Promise<string>;
  repoUrl(): Promise<string | undefined>;
  /** Contents of .git/config and .git/hooks, to detect tampering during the run. */
  fingerprint(): Promise<string>;
}

export interface PipelineDeps extends GateDeps {
  spec: Spec;
  git: GitOps;
  base: string;
  model: string;
  dryRun: boolean;
  /** Goes into the commit trailer and the PR body, to trace the PR back to its audit log. */
  runId?: string;
  /** The org standards the agent was given, listed in the PR body. */
  standards?: PrStandards;
  /** Runs the agent on the spec. `template` is the repo's PR template, whose sections the report fills. */
  runAgent(spec: Spec, template?: PrTemplate): Promise<AgentRun>;
}

/** Another run created the spec's branch on origin between this run's preflight and its claim. */
export class ClaimLostError extends Error {
  constructor(specPath: string, branch: string) {
    super(`Another run already claimed ${specPath}: ${branch} exists on origin.`);
    this.name = "ClaimLostError";
  }
}

/** The CLI's exit code: 3 for a lost claim, which a local wave cleans up after, 1 for any other failure. */
export function exitCodeFor(error: unknown): number {
  return error instanceof ClaimLostError ? 3 : 1;
}

export type PipelineResult =
  | { status: "opened"; url: string; run: AgentRun }
  | { status: "dry-run"; branch: string; files: string[]; body: string; run: AgentRun };

/**
 * spec → branch → agent → independent verification → commit → push → PR.
 * Every gate throws with a clear message and leaves the branch for a human to inspect.
 */
export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { spec, git, base, log } = deps;
  const branch = branchName(spec);

  // Preflight: start from a clean base so the PR contains only the agent's work. A worktree can't
  // check out a branch the main checkout has, so a detached HEAD on origin/<base> counts too. An
  // ancestor is fine: a fetch anywhere in the repository moves origin/<base> for every worktree.
  const current = await git.currentBranch();
  if (current === "HEAD") {
    if (!(await git.headOnBase(base))) {
      throw new Error(`Check out ${base}, or detach on origin/${base}, first (currently detached at ${(await git.headSha()).slice(0, 7)}).`);
    }
  } else if (current !== base) {
    throw new Error(`Check out ${base} first (currently on ${current}).`);
  }
  const dirty = await git.changedFiles();
  if (dirty.length) throw new Error(`Working tree is not clean:\n${dirty.map((f) => `  ${f}`).join("\n")}`);
  if (await git.branchExists(branch)) throw new Error(`Branch ${branch} already exists. Delete it or rename the spec.`);

  // Read from the clean base checkout, and the agent can't write under .github/, so a PR is never
  // held to a template it changed. A missing file is no template; any other read error aborts the
  // run here, before any API spend.
  const template = parsePrTemplate((await deps.readFile(PR_TEMPLATE_PATH)) ?? "");
  log(template ? `PR template: ${template.sections.map((s) => s.heading).join(", ")}.` : `No PR template at ${PR_TEMPLATE_PATH}.`);

  await git.createBranch(branch);
  // Claimed on origin before any API spend, so two coordinators (local or CI) never both implement it.
  if (!deps.dryRun) await claim(git, spec, branch);
  log(`Created ${branch}. Running the agent on ${spec.path}...`);

  // Commits, branch switches, hooks and config are invisible to git status, and agent-written tests could make them.
  const gitStateBefore = await git.fingerprint();

  const run = await deps.runAgent(spec, template);
  log(`Agent finished in ${run.turns} turns, $${run.costUsd.toFixed(2)}.`);

  const files = await verifyChanges(deps, branch, gitStateBefore);
  const body = prBody({ spec, run, files, model: deps.model, base, repoUrl: await git.repoUrl(), runId: deps.runId, standards: deps.standards, template });

  await scanForSecrets(deps, branch, [["the PR body", body]], files);
  if (deps.dryRun) return { status: "dry-run", branch, files, body, run };

  await git.commit(files, commitMessage(spec, run, deps.runId));
  await git.push(branch);
  const url = await git.openPullRequest(prTitle(spec), body, base, branch);
  return { status: "opened", url, run };
}

/**
 * Pushes the branch at the base commit. The branch didn't exist at preflight, so finding it on
 * origin after a failed push means another run created it seconds ago: a lost race. Any other
 * failure (credentials, network, a hook, origin unreadable) is rethrown as it is.
 */
async function claim(git: GitOps, spec: Spec, branch: string): Promise<void> {
  try {
    await git.claimBranch(branch);
  } catch (error) {
    if (await git.branchExistsOnOrigin(branch).catch(() => false)) throw new ClaimLostError(spec.path, branch);
    throw error;
  }
}
