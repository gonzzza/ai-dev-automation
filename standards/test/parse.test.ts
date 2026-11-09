import { describe, expect, it } from "vitest";
import { parseStandard, StandardsError } from "../src/index.js";

const PATH = "org-standards/typescript/ts-002.md";

const doc = (frontmatter: string[], body = "The rule.") => ["---", ...frontmatter, "---", body].join("\n");

const VALID = ["id: TS-002", "title: Inject clocks and timers", "severity: medium"];

/** Parse and return the thrown error, failing the test if nothing was thrown. */
function parseError(text: string): StandardsError {
  try {
    parseStandard(PATH, "typescript", text);
  } catch (error) {
    expect(error).toBeInstanceOf(StandardsError);
    return error as StandardsError;
  }
  throw new Error("expected parseStandard to throw");
}

describe("parseStandard", () => {
  it("AC1: returns every field of a valid file, with quoted and bare strings", () => {
    const text = doc(
      [
        "id: TS-002",
        'title: "Inject clocks: and timers"',
        "",
        "severity: medium",
        'applies_to: ["**/src/**/*.ts", lib/*.js]',
        "use: [review]",
      ],
      "\nCode that reads the time takes `now` as an option.\n\n```ts\nconst x = 1;\n```\n",
    );
    expect(parseStandard(PATH, "typescript", text)).toEqual({
      id: "TS-002",
      title: "Inject clocks: and timers",
      severity: "medium",
      appliesTo: ["**/src/**/*.ts", "lib/*.js"],
      use: ["review"],
      pack: "typescript",
      path: PATH,
      body: "Code that reads the time takes `now` as an option.\n\n```ts\nconst x = 1;\n```",
    });
  });

  it("AC1: defaults use to [agent, review] and applies_to to []", () => {
    const standard = parseStandard(PATH, "typescript", doc(VALID));
    expect(standard.use).toEqual(["agent", "review"]);
    expect(standard.appliesTo).toEqual([]);
    expect(standard.body).toBe("The rule.");
  });

  it("AC1: accepts quoted ids and severities, CRLF line endings and an empty applies_to", () => {
    const text = doc(['id: "TS-002"', "title: Inject clocks", 'severity: "high"', "applies_to: []"]).replace(/\n/g, "\r\n");
    expect(parseStandard(PATH, "typescript", text)).toMatchObject({ id: "TS-002", severity: "high", appliesTo: [], body: "The rule." });
  });

  it("AC1: unescapes quoted strings", () => {
    const text = doc(["id: TS-002", 'title: "Say \\"now\\" \\\\ later"', "severity: low"]);
    expect(parseStandard(PATH, "typescript", text).title).toBe('Say "now" \\ later');
  });

  it("AC2: uses the message format path:line: problem", () => {
    const error = parseError(doc(["id: TS-002", "title: Inject clocks", "severity: urgent"]));
    expect(error.message).toBe(`${PATH}:4: severity must be one of low, medium, high, critical; got "urgent"`);
  });

  it.each([
    ["missing id", ["title: t", "severity: low"], 1, /id is required/],
    ["missing title", ["id: TS-1", "severity: low"], 1, /title is required/],
    ["missing severity", ["id: TS-1", "title: t"], 1, /severity is required/],
    ["unknown key", [...VALID, "owner: platform"], 5, /unknown key "owner"/],
    ["invalid id", ["id: ts-2", "title: t", "severity: low"], 2, /id must match/],
    ["id without number", ["id: TS-", "title: t", "severity: low"], 2, /id must match/],
    ["invalid severity", ["id: TS-1", "title: t", "severity: urgent"], 4, /severity must be one of/],
    ["invalid use value", [...VALID, "use: [agent, lint]"], 5, /use entries must be one of agent, review; got "lint"/],
    ["empty use list", [...VALID, "use: []"], 5, /use must list at least one/],
    ["use as a string", [...VALID, "use: review"], 5, /use must be an inline list/],
    ["id as a list", ["id: [TS-1]", "title: t", "severity: low"], 2, /id must be a string/],
    ["empty title", ["id: TS-1", 'title: ""', "severity: low"], 3, /title must not be empty/],
    ["block list", [...VALID, "applies_to:", '  - "src/**"'], 5, /block lists/],
    ["block list item", [...VALID, '- "src/**"'], 5, /block lists are not supported/],
    ["nested map", [...VALID, "applies_to:", "  src: yes"], 5, /nested maps/],
    ["indented line", [...VALID, "  use: [agent]"], 5, /indented lines are not supported/],
    ["inline map", [...VALID, "use: {agent: true}"], 5, /must be an inline list|nested maps/],
    ["map value", ["id: TS-1", "title: {a: b}", "severity: low"], 3, /nested maps are not supported/],
    ["multi-line string", ["id: TS-1", "title: |", "severity: low"], 3, /multi-line strings/],
    ["unclosed quote", ["id: TS-1", 'title: "open', "severity: low"], 3, /unclosed quoted string/],
    ["comment line", [...VALID, "# owner: platform"], 5, /comments are not supported/],
    ["trailing comment", ["id: TS-1 # first", "title: t", "severity: low"], 2, /comments are not supported/],
    ["unclosed list", [...VALID, 'applies_to: ["src/**"'], 5, /unclosed list/],
    ["nested list", [...VALID, "applies_to: [[a]]"], 5, /nested lists/],
    ["missing comma", [...VALID, 'applies_to: ["a" "b"]'], 5, /expected a comma/],
    ["bare alias-like glob", [...VALID, "applies_to: [**/src/**]"], 5, /use a bare or double-quoted string/],
    ["single-quoted string", ["id: TS-1", "title: 'quoted'", "severity: low"], 3, /use a bare or double-quoted string/],
    ["no space after colon", ["id:TS-1", "title: t", "severity: low"], 2, /expected a space/],
    ["duplicate key", [...VALID, "severity: high"], 5, /duplicate key "severity"/],
    ["not key: value", [...VALID, "just text"], 5, /expected "key: value"/],
  ])("AC2: rejects %s with path:line", (_name, frontmatter, line, message) => {
    const error = parseError(doc(frontmatter));
    expect(error.message.startsWith(`${PATH}:${line}: `)).toBe(true);
    expect(error.message).toMatch(message);
  });

  it.each([
    ["missing frontmatter", "# Inject clocks\n\nNo frontmatter here.", /missing frontmatter/],
    ["empty file", "", /missing frontmatter/],
    ["unclosed frontmatter", "---\nid: TS-1\ntitle: t\nseverity: low\nbody without a closing fence", /unclosed frontmatter/],
  ])("AC2: rejects %s with path:line", (_name, text, message) => {
    const error = parseError(text);
    expect(error.message.startsWith(`${PATH}:1: `)).toBe(true);
    expect(error.message).toMatch(message);
  });
});
