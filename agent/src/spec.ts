import { posix } from "node:path";

export interface Spec {
  /** Repo-relative path, used in links and the PR body. */
  path: string;
  /** File name without extension, e.g. "001-rate-limiter". Used for the branch name. */
  slug: string;
  title: string;
  body: string;
}

/** Sections every spec must have, so the agent always gets a goal and a definition of done. */
export const REQUIRED_SECTIONS = ["Goal", "Requirements", "Acceptance criteria"];

export function parseSpec(rawPath: string, body: string): Spec {
  // Normalize first: on Linux, basename() does not split on backslashes.
  const path = rawPath.replace(/\\/g, "/");
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (!title) throw new Error(`${path}: spec must start with a "# Title" heading`);

  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
  const missing = REQUIRED_SECTIONS.filter((s) => !headings.includes(s.toLowerCase()));
  if (missing.length) throw new Error(`${path}: spec is missing section(s): ${missing.join(", ")}`);

  const slug = posix.basename(path).replace(/\.md$/i, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`${path}: file name must be lowercase kebab-case, e.g. 002-add-cache.md`);
  }

  return { path, slug, title, body };
}
