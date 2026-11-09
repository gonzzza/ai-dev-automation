import { posix } from "node:path";

/** One acceptance criterion. The ID lets tests and reviews point back at it, e.g. it("AC3: ..."). */
export interface Criterion {
  id: string;
  text: string;
}

export interface Spec {
  /** Repo-relative path, used in links and the PR body. */
  path: string;
  /** File name without extension, e.g. "001-rate-limiter". Used for the branch name. */
  slug: string;
  title: string;
  body: string;
  criteria: Criterion[];
}

/** Sections every spec must have, so the agent always gets a goal and a definition of done. */
export const REQUIRED_SECTIONS = ["Goal", "Requirements", "Acceptance criteria"];

/** A top-level bullet: "- text" or "* text" with no indentation. Indented lines continue the bullet above. */
const TOP_LEVEL_BULLET = /^[-*]\s+(.*)$/;
const CRITERION = /^(AC[1-9]\d*):\s*(\S.*)$/;

export function parseSpec(rawPath: string, body: string): Spec {
  // Normalize first: on Linux, basename() does not split on backslashes.
  const path = rawPath.replace(/\\/g, "/");
  // Headings, sections and criteria are all read from the text outside code blocks, so an example
  // spec or a "# comment" in a snippet can't be mistaken for the real structure.
  const lines = blankCodeBlocks(body.split(/\r?\n/));
  const text = lines.join("\n");
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!title) throw new Error(`${path}: spec must start with a "# Title" heading`);

  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
  const missing = REQUIRED_SECTIONS.filter((s) => !headings.includes(s.toLowerCase()));
  if (missing.length) throw new Error(`${path}: spec is missing section(s): ${missing.join(", ")}`);

  const slug = posix.basename(path).replace(/\.md$/i, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`${path}: file name must be lowercase kebab-case, e.g. 002-add-cache.md`);
  }

  return { path, slug, title, body, criteria: parseCriteria(path, section(lines, "Acceptance criteria")) };
}

/** Opening or closing line of a fenced code block: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Replaces every line of a fenced code block, fences included, with a blank line, keeping line
 * positions. A block closes only on a bare fence of the same character at least as long as the
 * opener, and an unclosed block runs to the end of the file, as in CommonMark.
 */
function blankCodeBlocks(lines: string[]): string[] {
  let opener: string | undefined;
  return lines.map((line) => {
    const fence = FENCE.exec(line)?.[1];
    if (opener === undefined) {
      if (!fence) return line;
      opener = fence;
      return "";
    }
    if (fence && fence[0] === opener[0] && fence.length >= opener.length && line.trim() === fence) opener = undefined;
    return "";
  });
}

/** The lines under a "## name" heading, up to the next "# " or "## " heading. Expects code blocks blanked. */
function section(lines: string[], name: string): string[] {
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === name.toLowerCase());
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##?\s+/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Every top-level bullet is one criterion and must start with a unique ID: "- AC1: ...".
 * Indented lines right below a bullet continue it and are joined into its text. Prose between
 * bullets is allowed and ignored (code blocks arrive as blank lines); a criterion without an ID
 * is not, since nothing could reference it.
 */
function parseCriteria(path: string, lines: string[]): Criterion[] {
  const criteria: Criterion[] = [];
  // The criterion still collecting continuation lines; a blank line or prose ends it.
  let open: Criterion | undefined;
  for (const line of lines) {
    const bullet = TOP_LEVEL_BULLET.exec(line);
    if (!bullet) {
      if (open && /^\s+\S/.test(line)) open.text += ` ${line.trim()}`;
      else open = undefined;
      continue;
    }
    const match = CRITERION.exec(bullet[1]!.trim());
    if (!match) throw new Error(`${path}: acceptance criterion needs an ID, e.g. "- AC${criteria.length + 1}: ...": ${line.trim()}`);
    const [, id, text] = match;
    if (criteria.some((c) => c.id === id)) throw new Error(`${path}: duplicate acceptance criterion ID ${id}`);
    open = { id: id!, text: text!.trim() };
    criteria.push(open);
  }
  if (!criteria.length) throw new Error(`${path}: acceptance criteria must list at least one "- AC1: ..." bullet`);
  return criteria;
}

/**
 * Validates every spec in a folder at once: each must parse, and no two may share a number prefix,
 * since the number orders the specs and keeps branch names unique.
 */
export function checkSpecs(files: { path: string; body: string }[]): string[] {
  const errors: string[] = [];
  const byNumber = new Map<string, string>();
  for (const file of files) {
    try {
      const { slug, path } = parseSpec(file.path, file.body);
      const number = /^(\d+)-/.exec(slug)?.[1];
      if (!number) {
        errors.push(`${path}: file name must start with a number, e.g. 002-add-cache.md`);
        continue;
      }
      const other = byNumber.get(number);
      if (other) errors.push(`${path}: number ${number} is already used by ${other}`);
      else byNumber.set(number, path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
