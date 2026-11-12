import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { checkSpecs, parseSpec, readSpecFiles } from "../src/spec.js";

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

    it("keeps reading criteria after a code block with a # comment in it", () => {
      const body = VALID.replace("- AC2", "```sh\n# start the server\n## not a heading either\n```\n- AC2");
      expect(parseSpec("specs/a.md", body).criteria.map((c) => c.id)).toEqual(["AC1", "AC2"]);
    });

    it("finds the real section after an example spec in a code block", () => {
      const example = "```markdown\n## Acceptance criteria\n- AC1: from the example\n```\n";
      const body = VALID.replace("- Token bucket.\n", `- Token bucket.\n${example}`);
      expect(parseSpec("specs/a.md", body).criteria).toEqual([
        { id: "AC1", text: "A new limiter is full." },
        { id: "AC2", text: "Refill is continuous, including fractional tokens." },
      ]);
    });

    it("doesn't count headings in code blocks as the spec's own sections", () => {
      const body = VALID.replace("## Acceptance criteria\n", "```\n## Acceptance criteria\n```\n");
      expect(() => parseSpec("specs/a.md", body)).toThrow(/missing section\(s\): Acceptance criteria/);
    });

    it("closes a code block only on a matching fence", () => {
      // A ``` line inside a ~~~ block is content; the block ends at ~~~, so AC2 is still found.
      const body = VALID.replace("- AC2", "~~~\n```\n## Out of scope\n~~~\n- AC2");
      expect(parseSpec("specs/a.md", body).criteria.map((c) => c.id)).toEqual(["AC1", "AC2"]);
    });

    it("treats an unclosed code block as running to the end of the file", () => {
      const body = VALID.replace("- AC2", "```\n- AC2");
      expect(parseSpec("specs/a.md", body).criteria.map((c) => c.id)).toEqual(["AC1"]);
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

describe("depends_on frontmatter", () => {
  const withFrontmatter = (lines: string) => `---\n${lines}\n---\n${VALID}`;

  it("AC1: gives [] without frontmatter and for depends_on: []", () => {
    expect(parseSpec("specs/001-a.md", VALID).dependsOn).toEqual([]);
    expect(parseSpec("specs/001-a.md", withFrontmatter("depends_on: []")).dependsOn).toEqual([]);
  });

  it("AC1: reads numbers in order, leading zeros allowed", () => {
    expect(parseSpec("specs/004-a.md", withFrontmatter("depends_on: [001, 3]")).dependsOn).toEqual([1, 3]);
    expect(parseSpec("specs/004-a.md", withFrontmatter("depends_on: [3, 1]")).dependsOn).toEqual([3, 1]);
  });

  it("AC1: parses the title, sections and criteria the same with a frontmatter block, and keeps it in body", () => {
    const body = withFrontmatter("depends_on: [1]");
    const { dependsOn: _a, body: plainBody, ...plain } = parseSpec("specs/002-a.md", VALID);
    const { dependsOn, body: fmBody, ...withBlock } = parseSpec("specs/002-a.md", body);
    expect(withBlock).toEqual(plain);
    expect(dependsOn).toEqual([1]);
    expect(plainBody).toBe(VALID);
    expect(fmBody).toBe(body);
  });

  it("AC1: doesn't read a heading inside the frontmatter as the title", () => {
    const body = `---\ndepends_on: [1]\n---\n${VALID}`.replace("depends_on: [1]", "depends_on: [1]\n# not the title");
    expect(() => parseSpec("specs/002-a.md", body)).toThrow(/specs\/002-a\.md:3: expected "key: value"/);
  });

  it.each([
    ["an unclosed block", `---\ndepends_on: [1]\n${VALID}`, /not closed/],
    ["an unknown key", withFrontmatter("needs: [1]"), /unknown frontmatter key "needs"/],
    ["a duplicate key", withFrontmatter("depends_on: [1]\ndepends_on: [2]"), /duplicate frontmatter key "depends_on"/],
    ["a block list", withFrontmatter("depends_on:\n  - 1"), /block lists are not supported/],
    ["0", withFrontmatter("depends_on: [0]"), /positive integers, got "0"/],
    ["-1", withFrontmatter("depends_on: [-1]"), /positive integers, got "-1"/],
    ["1.5", withFrontmatter("depends_on: [1.5]"), /positive integers, got "1.5"/],
    ["abc", withFrontmatter("depends_on: [abc]"), /positive integers, got "abc"/],
    ["a number listed twice", withFrontmatter("depends_on: [1, 001]"), /lists 1 twice/],
    ["a value that isn't an inline list", withFrontmatter("depends_on: 1"), /inline list/],
  ])("AC1: throws naming the path for %s", (_name, body, message) => {
    expect(() => parseSpec("specs/009-x.md", body)).toThrow(message);
    expect(() => parseSpec("specs/009-x.md", body)).toThrow(/^specs\/009-x\.md/);
  });
});

describe("checkSpecs dependencies", () => {
  const spec = (path: string, deps?: string) => ({ path, body: deps === undefined ? VALID : `---\ndepends_on: [${deps}]\n---\n${VALID}` });

  it("AC2: accepts a valid dependency graph", () => {
    expect(checkSpecs([spec("specs/001-a.md"), spec("specs/002-b.md", "1"), spec("specs/003-c.md", "1, 2")])).toEqual([]);
  });

  it("AC2: reports a missing number and a self-dependency", () => {
    expect(checkSpecs([spec("specs/001-a.md", "9"), spec("specs/002-b.md", "2")])).toEqual([
      "specs/001-a.md: depends on 009, but no spec has that number",
      "specs/002-b.md: depends on itself",
    ]);
  });

  it("AC2: reports a three-spec cycle once, from its lowest number", () => {
    const errors = checkSpecs([spec("specs/007-c.md", "5"), spec("specs/005-a.md", "6"), spec("specs/006-b.md", "7"), spec("specs/001-x.md")]);
    expect(errors).toEqual(["dependency cycle: 005 → 006 → 007 → 005"]);
  });

  it("AC2: reports each cycle once when two share a spec", () => {
    const errors = checkSpecs([spec("specs/001-a.md", "2, 3"), spec("specs/002-b.md", "1"), spec("specs/003-c.md", "1")]);
    expect(errors).toEqual(["dependency cycle: 001 → 002 → 001", "dependency cycle: 001 → 003 → 001"]);
  });

  it("AC2: passes on the specs in specs/", async () => {
    const files = await readSpecFiles(fileURLToPath(new URL("../../specs/", import.meta.url)));
    expect(files.length).toBeGreaterThan(0);
    expect(checkSpecs(files)).toEqual([]);
  });
});
