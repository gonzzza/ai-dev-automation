import type { AgentRun } from "./agent.js";
import type { CheckResult } from "./checks.js";
import { branchName, commitMessage, prBody, prTitle } from "./pr.js";
import { isWritable } from "./policy.js";
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
}

export interface PipelineDeps {
  spec: Spec;
  git: GitOps;
  base: string;
  writableDirs: string[];
  model: string;
  dryRun: boolean;
  runAgent(spec: Spec): Promise<AgentRun>;
  runChecks(): Promise<CheckResult>;
  log(line: string): void;
}

export type PipelineResult =
  | { status: "opened"; url: string; run: AgentRun }
  | { status: "dry-run"; branch: string; files: string[]; body: string; run: AgentRun };

/**
 * spec → branch → agent → independent verification → commit → push → PR.
 * Every gate throws with a clear message and leaves the branch for a human to inspect.
 */
export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { spec, git, base, writableDirs, log } = deps;
  const branch = branchName(spec);

  // Preflight: start from a clean base so the PR contains only the agent's work.
  const current = await git.currentBranch();
  if (current !== base) throw new Error(`Check out ${base} first (currently on ${current}).`);
  const dirty = await git.changedFiles();
  if (dirty.length) throw new Error(`Working tree is not clean:\n${dirty.map((f) => `  ${f}`).join("\n")}`);
  if (await git.branchExists(branch)) throw new Error(`Branch ${branch} already exists. Delete it or rename the spec.`);

  await git.createBranch(branch);
  log(`Created ${branch}. Running the agent on ${spec.path}...`);

  const run = await deps.runAgent(spec);
  log(`Agent finished in ${run.turns} turns, $${run.costUsd.toFixed(2)}.`);

  // Gate 1: the agent changed something, and only inside its scope.
  const files = await git.changedFiles();
  if (files.length === 0) throw new Error("The agent made no changes.");
  const outside = files.filter((f) => !isWritable(f, writableDirs));
  if (outside.length) throw new Error(`The agent changed files outside ${writableDirs.join(", ")}:\n${outside.join("\n")}`);

  // Gate 2: don't trust the agent's own report; run the checks again.
  log("Verifying with npm run check...");
  const checks = await deps.runChecks();
  if (!checks.passed) throw new Error(`Checks failed after the agent finished. Branch ${branch} kept for inspection.\n\n${checks.output}`);

  const body = prBody({ spec, run, files, model: deps.model, base, repoUrl: await git.repoUrl() });
  if (deps.dryRun) return { status: "dry-run", branch, files, body, run };

  await git.commit(files, commitMessage(spec, run));
  await git.push(branch);
  const url = await git.openPullRequest(prTitle(spec), body, base, branch);
  return { status: "opened", url, run };
}
