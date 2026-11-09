import type { AgentRun } from "./agent.js";
import { scanForSecrets, verifyChanges, type GateDeps } from "./gates.js";
import { branchName, commitMessage, prBody, prTitle } from "./pr.js";
import type { Spec } from "./spec.js";

/** The git operations the pipeline needs; implemented by Git, faked in tests. */
export interface GitOps {
  currentBranch(): Promise<string>;
  changedFiles(): Promise<string[]>;
  branchExists(name: string): Promise<boolean>;
  createBranch(name: string): Promise<unknown>;
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
  runAgent(spec: Spec): Promise<AgentRun>;
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

  // Preflight: start from a clean base so the PR contains only the agent's work.
  const current = await git.currentBranch();
  if (current !== base) throw new Error(`Check out ${base} first (currently on ${current}).`);
  const dirty = await git.changedFiles();
  if (dirty.length) throw new Error(`Working tree is not clean:\n${dirty.map((f) => `  ${f}`).join("\n")}`);
  if (await git.branchExists(branch)) throw new Error(`Branch ${branch} already exists. Delete it or rename the spec.`);

  await git.createBranch(branch);
  log(`Created ${branch}. Running the agent on ${spec.path}...`);

  // Commits, branch switches, hooks and config are invisible to git status, and agent-written tests could make them.
  const gitStateBefore = await git.fingerprint();

  const run = await deps.runAgent(spec);
  log(`Agent finished in ${run.turns} turns, $${run.costUsd.toFixed(2)}.`);

  const files = await verifyChanges(deps, branch, gitStateBefore);
  const body = prBody({ spec, run, files, model: deps.model, base, repoUrl: await git.repoUrl(), runId: deps.runId });

  await scanForSecrets(deps, branch, [["the PR body", body]], files);
  if (deps.dryRun) return { status: "dry-run", branch, files, body, run };

  await git.commit(files, commitMessage(spec, run, deps.runId));
  await git.push(branch);
  const url = await git.openPullRequest(prTitle(spec), body, base, branch);
  return { status: "opened", url, run };
}
