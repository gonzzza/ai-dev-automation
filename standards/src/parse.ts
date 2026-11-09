import { StandardsError } from "./error.js";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const USES = ["agent", "review"] as const;
export type StandardUse = (typeof USES)[number];

export interface Standard {
  /** e.g. `TS-002`. Unique across every loaded file. */
  id: string;
  title: string;
  severity: Severity;
  /** Globs matched against repo-relative paths. Empty means every file. */
  appliesTo: string[];
  use: StandardUse[];
  /** The pack (subdirectory) the standard was loaded from. */
  pack: string;
  /** The file it was parsed from. */
  path: string;
  /** The markdown after the frontmatter, trimmed. */
  body: string;
}

const KEYS = ["id", "title", "severity", "applies_to", "use"] as const;
type Key = (typeof KEYS)[number];
const REQUIRED: readonly Key[] = ["id", "title", "severity"];
const ID_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const FENCE = "---";

type Value = string | string[];
type Fail = (message: string) => never;

const quote = (value: string) => JSON.stringify(value);
const isKey = (key: string): key is Key => (KEYS as readonly string[]).includes(key);

/**
 * Parse one standard: a frontmatter block between two `---` lines, then a markdown body.
 * The frontmatter is a strict YAML subset: `key: value` lines whose values are bare strings,
 * double-quoted strings or inline lists. Throws `StandardsError` naming `path:line` on any problem.
 */
export function parseStandard(path: string, pack: string, text: string): Standard {
  const failAt = (line: number, message: string): never => {
    throw new StandardsError(`${path}:${line}: ${message}`);
  };
  const BOM = String.fromCharCode(0xfeff);
  const lines = (text.startsWith(BOM) ? text.slice(1) : text).split(/\r?\n/);
  if (lines[0]?.trimEnd() !== FENCE) failAt(1, "missing frontmatter: the file must start with a --- line");
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === FENCE);
  if (end === -1) failAt(1, "unclosed frontmatter: no closing --- line");

  const entries = new Map<Key, { value: Value; line: number }>();
  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    const line = i + 1;
    const { key, value } = parseLine(raw, (message) => failAt(line, message));
    if (entries.has(key)) failAt(line, `duplicate key ${quote(key)}`);
    entries.set(key, { value, line });
  }

  for (const key of REQUIRED) {
    if (!entries.has(key)) failAt(1, `${key} is required`);
  }
  const string = (key: Key): { value: string; line: number } => {
    const entry = entries.get(key)!;
    if (typeof entry.value !== "string") return failAt(entry.line, `${key} must be a string, not a list`);
    return { value: entry.value, line: entry.line };
  };
  const list = (key: Key): { value: string[]; line: number } | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (!Array.isArray(entry.value)) return failAt(entry.line, `${key} must be an inline list, like ["a", "b"]`);
    return { value: entry.value, line: entry.line };
  };

  const id = string("id");
  if (!ID_PATTERN.test(id.value)) failAt(id.line, `id must match ${ID_PATTERN.source}; got ${quote(id.value)}`);

  const title = string("title");
  if (title.value.trim() === "") failAt(title.line, "title must not be empty");

  const severity = string("severity");
  if (!(SEVERITIES as readonly string[]).includes(severity.value)) {
    failAt(severity.line, `severity must be one of ${SEVERITIES.join(", ")}; got ${quote(severity.value)}`);
  }

  const appliesTo = list("applies_to");
  if (appliesTo?.value.some((glob) => glob.trim() === "")) failAt(appliesTo.line, "applies_to must not contain empty globs");

  const use = list("use");
  if (use) {
    if (use.value.length === 0) failAt(use.line, `use must list at least one of ${USES.join(", ")}`);
    const bad = use.value.find((u) => !(USES as readonly string[]).includes(u));
    if (bad !== undefined) failAt(use.line, `use entries must be one of ${USES.join(", ")}; got ${quote(bad)}`);
  }

  return {
    id: id.value,
    title: title.value.trim(),
    severity: severity.value as Severity,
    appliesTo: appliesTo?.value ?? [],
    use: use ? [...new Set(use.value as StandardUse[])] : [...USES],
    pack,
    path,
    body: lines.slice(end + 1).join("\n").trim(),
  };
}

function parseLine(raw: string, fail: Fail): { key: Key; value: Value } {
  if (/^\s/.test(raw)) return fail("indented lines are not supported (no nested maps, block lists or multi-line strings)");
  if (raw.startsWith("#")) return fail("comments are not supported");
  if (raw.startsWith("-")) return fail('block lists are not supported; use an inline list, like ["a", "b"]');

  const match = /^([^:\s]+):(.*)$/.exec(raw);
  if (!match) return fail('expected "key: value"');
  const key = match[1]!;
  const rest = match[2]!;
  if (!isKey(key)) return fail(`unknown key ${quote(key)}; expected one of ${KEYS.join(", ")}`);
  if (rest.trim() === "") {
    return fail(`${key} has no value (block lists, nested maps and multi-line strings are not supported)`);
  }
  if (!/^[ \t]/.test(rest)) return fail(`expected a space after "${key}:"`);
  return { key, value: parseValue(rest.trim(), fail) };
}

function parseValue(text: string, fail: Fail): Value {
  if (text.startsWith("[")) return parseList(text, fail);
  if (text.startsWith('"')) {
    const { value, end } = readQuoted(text, 0, fail);
    if (text.slice(end).trim() !== "") return fail("unexpected text after the closing quote");
    return value;
  }
  if (text.startsWith("{")) return fail("nested maps are not supported");
  if (/^[|>]/.test(text)) return fail("multi-line strings are not supported");
  return checkBare(text, fail);
}

function parseList(text: string, fail: Fail): string[] {
  if (!text.endsWith("]")) return fail('unclosed list; lists must be inline, like ["a", "b"]');
  const inner = text.slice(1, -1);
  const items: string[] = [];
  let i = 0;
  const skipSpaces = () => {
    while (inner[i] === " " || inner[i] === "\t") i++;
  };

  skipSpaces();
  if (i === inner.length) return items;
  for (;;) {
    skipSpaces();
    if (inner[i] === '"') {
      const quoted = readQuoted(inner, i, fail);
      items.push(quoted.value);
      i = quoted.end;
    } else {
      let j = i;
      while (j < inner.length && inner[j] !== ",") j++;
      const item = inner.slice(i, j).trim();
      if (item === "") return fail("empty list item");
      if (/[[\]{}]/.test(item)) return fail(`nested lists and maps are not supported; got ${quote(item)}`);
      items.push(checkBare(item, fail));
      i = j;
    }
    skipSpaces();
    if (i === inner.length) return items;
    if (inner[i] !== ",") return fail("expected a comma between list items");
    i++;
  }
}

/** A double-quoted string starting at `start`, with `\"` and `\\` escapes. `end` is the index after the closing quote. */
function readQuoted(text: string, start: number, fail: Fail): { value: string; end: number } {
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') return { value, end: i + 1 };
    if (char === "\\") {
      const next = text[i + 1];
      if (next !== '"' && next !== "\\") return fail('only \\" and \\\\ escapes are supported in quoted strings');
      value += next;
      i++;
    } else {
      value += char;
    }
  }
  return fail("unclosed quoted string (multi-line strings are not supported)");
}

/** Reject bare strings that YAML would read as something other than the same string. */
function checkBare(text: string, fail: Fail): string {
  if (/^['&*!%@`]/.test(text)) return fail(`unsupported value ${quote(text)}; use a bare or double-quoted string`);
  if (/(^|\s)#/.test(text)) return fail("comments are not supported");
  if (/:(\s|$)/.test(text)) return fail(`a bare string can't contain ": "; quote it: ${quote(text)}`);
  return text;
}
