import type { CheckResult } from "./checks.js";
import { isWritable } from "./policy.js";
import { findSecrets } from "./secrets.js";

/** What the post-run gates need. Shared by the spec pipeline and the fix cycle, so both enforce the same rules. */
export interface GateDeps {
  git: {
    changedFiles(): Promise<string[]>;
    /** Contents of .git/config and .git/hooks, to detect tampering during the run. */
    fingerprint(): Promise<string>;
  };
  writableDirs: string[];
  runChecks(): Promise<CheckResult>;
  /** Reads a repo-relative file for the secret scan; undefined if it was deleted. */
  readFile(path: string): Promise<string | undefined>;
  /** Whether a repo-relative path is a symlink (not followed). */
  isSymlink(path: string): Promise<boolean>;
  /** Credential values from the environment that must never be committed. */
  secrets: string[];
  log(line: string): void;
}

/**
 * Gates 1 to 3, run after the agent finished. Returns the changed files, all inside the scope.
 * Every gate throws with a clear message and leaves the branch for a human to inspect.
 */
export async function verifyChanges(deps: GateDeps, branch: string, gitStateBefore: string): Promise<string[]> {
  const { git, writableDirs, log } = deps;

  // Gate 1: don't trust the agent's own report; run the checks again.
  log("Verifying with npm run check...");
  const checks = await deps.runChecks();
  if (!checks.passed) throw new Error(`Checks failed after the agent finished. Branch ${branch} kept for inspection.\n\n${checks.output}`);

  // The checks run agent-written code too, so everything below inspects the tree after they ran.
  // Gate 2: git state is exactly as it was: same branch and commit, so every change is still visible
  // to the gates below, and same config and hooks, so the commit and push run nothing planted.
  if ((await git.fingerprint()) !== gitStateBefore) {
    throw new Error(
      `The git state (HEAD, branch, .git/config or hooks) changed during the run. Nothing was committed; inspect the repo before using branch ${branch}.`,
    );
  }

  // Gate 3: the agent changed something, and only inside its scope, never the files that define the checks.
  const files = await git.changedFiles();
  if (files.length === 0) throw new Error("The agent made no changes.");
  const outside = files.filter((f) => !isWritable(f, writableDirs));
  if (outside.length) {
    throw new Error(`The agent changed files outside ${writableDirs.join(", ")} or protected config files:\n${outside.join("\n")}`);
  }
  // Git commits a symlink as its target path, which the secret scan would not see, and the
  // link could point outside the repo. Specs here never need one.
  const links = [];
  for (const file of files) if (await deps.isSymlink(file)) links.push(file);
  if (links.length) throw new Error(`The run created symlinks, which are not allowed:\n${links.join("\n")}`);
  return files;
}

/**
 * Gate 4: nothing that looks like a credential gets committed or posted, however it got there.
 * `texts` are what will be posted (PR body, comments), as [where, text] pairs; `files` are scanned too.
 */
export async function scanForSecrets(deps: GateDeps, branch: string, texts: [string, string][], files: string[]): Promise<void> {
  const all = [...texts];
  for (const file of files) {
    const text = await deps.readFile(file);
    if (text !== undefined) all.push([file, text]); // undefined: deleted, nothing to scan
  }
  for (const [where, text] of all) {
    const found = findSecrets(text, deps.secrets);
    if (found.length) {
      throw new Error(`Possible secret in ${where} (${found.join(", ")}). Nothing was committed; branch ${branch} kept for inspection.`);
    }
  }
}
