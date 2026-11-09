// Plans a release of the review action: the next version and its notes. The Release workflow
// (.github/workflows/release.yml) runs it, then creates the GitHub release and moves the major tag.
//
//   node review-action/scripts/release.ts <patch|minor|major> <notes-file>
//
// Writes the notes to <notes-file> and prints `version=vX.Y.Z` and `major=vX` for $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const BUMPS = ["patch", "minor", "major"] as const;
export type Bump = (typeof BUMPS)[number];

/**
 * What the action's users get: its interface and the bundled code. A change anywhere else (the
 * agent, docs, tests) doesn't change what `uses: …/review-action@v1` runs, so it isn't released.
 * `:(top)` makes the paths relative to the repo root wherever the script runs from.
 */
export const RELEASED_PATHS = [":(top)review-action/action.yml", ":(top)review-action/dist"];

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The highest vX.Y.Z tag, compared numerically. Other tags, like the moving major tag v1, are ignored. */
export function latestVersion(tags: readonly string[]): string | undefined {
  let latest: { tag: string; parts: number[] } | undefined;
  for (const tag of tags) {
    const match = SEMVER_TAG.exec(tag.trim());
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    const newer = !latest || compare(parts, latest.parts) > 0;
    if (newer) latest = { tag: tag.trim(), parts };
  }
  return latest?.tag;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The version after `latest` for this bump; lower parts reset to 0. */
export function nextVersion(latest: string, bump: Bump): string {
  const match = SEMVER_TAG.exec(latest);
  if (!match) throw new Error(`${latest} is not a vX.Y.Z version.`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (bump === "major") return `v${major + 1}.0.0`;
  if (bump === "minor") return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}

/** The moving tag that `@v1`-style references resolve to. */
export const majorTag = (version: string): string => version.split(".")[0]!;

export interface Commit {
  sha: string;
  subject: string;
}

/** Parses `git log --format=%H%x09%s` output. */
export function parseLog(log: string): Commit[] {
  return log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1).trim() };
    });
}

/**
 * The release notes: one line per change, newest first. Squash-merged subjects end in `(#N)`,
 * which GitHub links to the PR; other commits get their short SHA. Throws when there's nothing to
 * release, so a version is never cut for a build that didn't change.
 */
export function releaseNotes(commits: readonly Commit[], opts: { repoUrl: string; previous: string; version: string }): string {
  if (commits.length === 0) {
    throw new Error(`Nothing to release: the action's interface and bundle haven't changed since ${opts.previous}.`);
  }
  const lines = commits.map((c) => (/\(#\d+\)$/.test(c.subject) ? `- ${c.subject}` : `- ${c.subject} (${c.sha.slice(0, 7)})`));
  return [
    "## Changes",
    "",
    ...lines,
    "",
    `**Full diff:** ${opts.repoUrl}/compare/${opts.previous}...${opts.version}`,
    "",
  ].join("\n");
}

function main(args: string[]): void {
  const [bump, notesFile] = args;
  if (!BUMPS.includes(bump as Bump) || !notesFile) {
    throw new Error("Usage: node review-action/scripts/release.ts <patch|minor|major> <notes-file>");
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } = process.env;
  if (!server || !repository) throw new Error("GITHUB_SERVER_URL and GITHUB_REPOSITORY must be set (they are in GitHub Actions).");

  const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { encoding: "utf8" });
  const previous = latestVersion(git("tag", "--list", "v*").split("\n"));
  if (!previous) throw new Error("No vX.Y.Z tag to bump from. Create the first release by hand.");

  const version = nextVersion(previous, bump as Bump);
  const commits = parseLog(git("log", "--format=%H%x09%s", `${previous}..HEAD`, "--", ...RELEASED_PATHS));
  writeFileSync(notesFile, releaseNotes(commits, { repoUrl: `${server}/${repository}`, previous, version }));
  console.log(`version=${version}\nmajor=${majorTag(version)}`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
