import { describe, expect, it } from "vitest";
import { checkSpecs, parseSpec } from "../src/spec.js";

const VALID = `# Add a rate limiter

## Goal
Limit calls.

## Requirements
- Token bucket.

## Acceptance criteria
- AC1: A new limiter is full.
- AC2: Refill is continuous,
  including fractional tokens.

## Out of scope
- Distributed limits.
`;

describe("parseSpec", () => {
  it("reads the title and slug and normalizes the path", () => {
    const spec = parseSpec("specs\\001-rate-limiter.md", VALID);
    expect(spec).toMatchObject({ path: "specs/001-rate-limiter.md", slug: "001-rate-limiter", title: "Add a rate limiter" });
    expect(spec.body).toBe(VALID);
  });

  it("requires a title", () => {
    expect(() => parseSpec("specs/a.md", VALID.replace("# Add a rate limiter", ""))).toThrow(/# Title/);
  });

  it("requires goal, requirements and acceptance criteria", () => {
    expect(() => parseSpec("specs/a.md", VALID.replace("## Acceptance criteria", "## Done when"))).toThrow(
      /missing section\(s\): Acceptance criteria/,
    );
  });

  it("requires a kebab-case file name, since it becomes the branch name", () => {
    expect(() => parseSpec("specs/My Spec.md", VALID)).toThrow(/kebab-case/);
  });

  describe("acceptance criteria", () => {
    it("returns each criterion with its ID and wrapped lines joined, stopping at the next section", () => {
      expect(parseSpec("specs/a.md", VALID).criteria).toEqual([
        { id: "AC1", text: "A new limiter is full." },
        { id: "AC2", text: "Refill is continuous, including fractional tokens." },
      ]);
    });

    it("joins nested bullets into their criterion, but not prose after a blank line", () => {
      const body = VALID.replace("- AC2", "  - for every option\n\nIndented after a gap:\n  ignored\n- AC2");
      expect(parseSpec("specs/a.md", body).criteria[0]).toEqual({ id: "AC1", text: "A new limiter is full. - for every option" });
    });

    it("ignores bullets inside fenced code blocks", () => {
      const body = VALID.replace("- AC2", "```ts\n- not a criterion\n```\n- AC2");
      expect(parseSpec("specs/a.md", body).criteria).toEqual([
        { id: "AC1", text: "A new limiter is full." },
        { id: "AC2", text: "Refill is continuous, including fractional tokens." },
      ]);
    });

    it("reads CRLF files and * bullets", () => {
      const crlf = VALID.replace("- AC2", "* AC2").replace(/\n/g, "\r\n");
      expect(parseSpec("specs/a.md", crlf).criteria.map((c) => c.id)).toEqual(["AC1", "AC2"]);
    });

    it("allows prose and nested bullets between criteria", () => {
      const body = VALID.replace("- AC2", "Edge cases:\n  - nested detail\n- AC2");
      expect(parseSpec("specs/a.md", body).criteria.map((c) => c.id)).toEqual(["AC1", "AC2"]);
    });

    it("rejects a criterion without an ID, suggesting the next one", () => {
      expect(() => parseSpec("specs/a.md", VALID.replace("- AC2: ", "- "))).toThrow(/needs an ID, e.g. "- AC2: \.\.\."/);
    });

    it("rejects malformed IDs", () => {
      expect(() => parseSpec("specs/a.md", VALID.replace("AC2:", "AC0:"))).toThrow(/needs an ID/);
      expect(() => parseSpec("specs/a.md", VALID.replace("AC2:", "AC2 -"))).toThrow(/needs an ID/);
      expect(() => parseSpec("specs/a.md", VALID.replace("AC2: Refill is continuous,", "AC2:"))).toThrow(/needs an ID/);
    });

    it("rejects duplicate IDs", () => {
      expect(() => parseSpec("specs/a.md", VALID.replace("AC2", "AC1"))).toThrow(/duplicate acceptance criterion ID AC1/);
    });

    it("rejects an empty section", () => {
      const body = VALID.replace(/- AC1[\s\S]*?(?=\n## Out)/, "TBD\n");
      expect(() => parseSpec("specs/a.md", body)).toThrow(/at least one/);
    });
  });
});

describe("checkSpecs", () => {
  it("accepts valid, uniquely numbered specs", () => {
    expect(checkSpecs([{ path: "specs/001-a.md", body: VALID }, { path: "specs/002-b.md", body: VALID }])).toEqual([]);
  });

  it("reports every problem across files, not just the first", () => {
    const errors = checkSpecs([
      { path: "specs/001-a.md", body: VALID },
      { path: "specs/001-b.md", body: VALID },
      { path: "specs/add-cache.md", body: VALID },
      { path: "specs/003-c.md", body: "no title" },
    ]);
    expect(errors).toEqual([
      "specs/001-b.md: number 001 is already used by specs/001-a.md",
      "specs/add-cache.md: file name must start with a number, e.g. 002-add-cache.md",
      expect.stringMatching(/^specs\/003-c\.md: .*# Title/),
    ]);
  });
});
