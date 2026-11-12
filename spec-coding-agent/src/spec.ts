import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

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
  /** Numbers of the specs this one builds on, from its `depends_on` frontmatter, in the order written. */
  dependsOn: number[];
}

/** Sections every spec must have, so the agent always gets a goal and a definition of done. */
export const REQUIRED_SECTIONS = ["Goal", "Requirements", "Acceptance criteria"];

/** A top-level bullet: "- text" or "* text" with no indentation. Indented lines continue the bullet above. */
const TOP_LEVEL_BULLET = /^[-*]\s+(.*)$/;
const CRITERION = /^(AC[1-9]\d*):\s*(\S.*)$/;

export function parseSpec(rawPath: string, body: string): Spec {
  // Normalize first: on Linux, basename() does not split on backslashes.
  const path = rawPath.replace(/\\/g, "/");
  // The frontmatter is read first and blanked like a code block, so its lines can't be taken for
  // structure. Headings, sections and criteria are all read from the text outside code blocks, so an
  // example spec or a "# comment" in a snippet can't be mistaken for the real structure.
  const frontmatter = parseFrontmatter(path, body.split(/\r?\n/));
  const lines = blankCodeBlocks(frontmatter.lines);
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

  return { path, slug, title, body, criteria: parseCriteria(path, section(lines, "Acceptance criteria")), dependsOn: frontmatter.dependsOn };
}

const FRONTMATTER_FENCE = /^---\s*$/;
const FRONTMATTER_KEYS = ["depends_on"];

/**
 * Reads the optional frontmatter block at the top of a spec: a `---` line, `key: value` lines, then
 * a closing `---` line. The only key is `depends_on`, an inline list of positive spec numbers.
 * Returns the numbers and the lines with the block blanked, keeping line positions. Deliberately
 * smaller and stricter than the standards parser: anything it doesn't recognize is an error.
 */
function parseFrontmatter(path: string, lines: string[]): { dependsOn: number[]; lines: string[] } {
  if (!FRONTMATTER_FENCE.test(lines[0] ?? "")) return { dependsOn: [], lines };
  const end = lines.findIndex((line, i) => i > 0 && FRONTMATTER_FENCE.test(line));
  if (end === -1) throw new Error(`${path}: frontmatter block is not closed with a "---" line`);

  const block = lines.slice(1, end);
  // Checked first, so `depends_on:` followed by `- 1` lines is named for what it is.
  const listLine = block.findIndex((line) => /^\s*-(\s|$)/.test(line));
  if (listLine !== -1) throw new Error(`${path}:${listLine + 2}: block lists are not supported; write depends_on: [1, 3]`);

  const seen = new Set<string>();
  let dependsOn: number[] = [];
  for (const [i, line] of block.entries()) {
    const where = `${path}:${i + 2}`;
    if (line.trim() === "") continue;
    const match = /^([A-Za-z_][\w-]*):(.*)$/.exec(line.trim());
    if (!match) throw new Error(`${where}: expected "key: value", got "${line.trim()}"`);
    const key = match[1]!;
    if (!FRONTMATTER_KEYS.includes(key)) throw new Error(`${where}: unknown frontmatter key "${key}"; the only key is depends_on`);
    if (seen.has(key)) throw new Error(`${where}: duplicate frontmatter key "${key}"`);
    seen.add(key);
    dependsOn = parseDependsOn(where, match[2]!.trim());
  }
  return { dependsOn, lines: lines.map((line, i) => (i <= end ? "" : line)) };
}

/** An inline list of positive decimal integers, leading zeros allowed: "[001, 3]" gives [1, 3]. */
function parseDependsOn(where: string, value: string): number[] {
  const list = /^\[(.*)\]$/.exec(value)?.[1];
  if (list === undefined) throw new Error(`${where}: depends_on must be an inline list like [1, 3], got "${value}"`);
  if (list.trim() === "") return [];
  const numbers: number[] = [];
  for (const raw of list.split(",").map((item) => item.trim())) {
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n <= 0) throw new Error(`${where}: depends_on items must be positive integers, got "${raw}"`);
    if (numbers.includes(n)) throw new Error(`${where}: depends_on lists ${n} twice`);
    numbers.push(n);
  }
  return numbers;
}

/** A spec number as it appears in file names and messages: padded to three digits. */
export function padSpecNumber(n: number): string {
  return String(n).padStart(3, "0");
}

/** The number a spec's file name starts with, e.g. 1 for "001-rate-limiter", or undefined. */
export function specNumber(slug: string): number | undefined {
  const digits = /^(\d+)-/.exec(slug)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/** Opening or closing line of a fenced code block: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The fenced-code-block state after one line. */
export interface FenceStep {
  /** Whether the line belongs to a code block, its opening and closing fences included. */
  inBlock: boolean;
  /** The opening fence of the block still open after the line, or undefined outside one. */
  opener: string | undefined;
}

/**
 * Advances the fenced-code-block state over one line. `opener` is the opening fence of the block
 * the line starts in, or undefined. A block opens on three or more backticks or tildes, closes only
 * on a bare fence of the same character at least as long as the opener, and an unclosed block runs
 * to the end of the file, as in CommonMark. The one fence parser, shared by the spec parser and the
 * PR template code.
 */
export function stepFence(opener: string | undefined, line: string): FenceStep {
  const fence = FENCE.exec(line)?.[1];
  if (opener === undefined) return { inBlock: fence !== undefined, opener: fence };
  const closes = fence !== undefined && fence[0] === opener[0] && fence.length >= opener.length && line.trim() === fence;
  return { inBlock: true, opener: closes ? undefined : opener };
}

/** Replaces every line of a fenced code block, fences included, with a blank line, keeping line positions. */
export function blankCodeBlocks(lines: string[]): string[] {
  let opener: string | undefined;
  return lines.map((line) => {
    const step = stepFence(opener, line);
    opener = step.opener;
    return step.inBlock ? "" : line;
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
 * Validates every spec in a folder at once: each must parse, no two may share a number prefix (the
 * number orders the specs and keeps branch names unique), and the `depends_on` graph may only point
 * at existing specs, with no self-dependencies and no cycles.
 */
export function checkSpecs(files: { path: string; body: string }[]): string[] {
  const errors: string[] = [];
  const byNumber = new Map<string, string>();
  const graph = new Map<number, Spec>();
  for (const file of files) {
    try {
      const spec = parseSpec(file.path, file.body);
      const { slug, path } = spec;
      const number = /^(\d+)-/.exec(slug)?.[1];
      if (!number) {
        errors.push(`${path}: file name must start with a number, e.g. 002-add-cache.md`);
        continue;
      }
      const other = byNumber.get(number);
      if (other) errors.push(`${path}: number ${number} is already used by ${other}`);
      else byNumber.set(number, path);
      if (!graph.has(Number(number))) graph.set(Number(number), spec);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [number, spec] of graph) {
    for (const dep of spec.dependsOn) {
      if (dep === number) errors.push(`${spec.path}: depends on itself`);
      else if (!graph.has(dep)) errors.push(`${spec.path}: depends on ${padSpecNumber(dep)}, but no spec has that number`);
    }
  }
  for (const cycle of dependencyCycles(graph)) {
    errors.push(`dependency cycle: ${[...cycle, cycle[0]!].map(padSpecNumber).join(" → ")}`);
  }
  return errors;
}

/**
 * Every elementary cycle in the dependency graph, once each, starting from its lowest number and
 * following `depends_on` edges. Self-dependencies and edges to missing specs are reported on their
 * own and skipped here. A plain search from each start node that only visits higher numbers, so each
 * cycle is found from its lowest node only: exponential in the worst case, fine for a specs folder.
 */
function dependencyCycles(graph: ReadonlyMap<number, Spec>): number[][] {
  const cycles: number[][] = [];
  const next = (n: number) => graph.get(n)!.dependsOn.filter((d) => d !== n && graph.has(d));
  for (const start of [...graph.keys()].sort((a, b) => a - b)) {
    const walk = (path: number[]): void => {
      for (const dep of next(path.at(-1)!)) {
        if (dep === start) cycles.push(path);
        else if (dep > start && !path.includes(dep)) walk([...path, dep]);
      }
    };
    walk([start]);
  }
  return cycles;
}

/** Reads every spec file in a directory, README.md excepted, sorted by name, with `specs/<name>` paths. */
export async function readSpecFiles(dir: string): Promise<{ path: string; body: string }[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md").sort();
  return Promise.all(names.map(async (name) => ({ path: `specs/${name}`, body: await readFile(join(dir, name), "utf8") })));
}
