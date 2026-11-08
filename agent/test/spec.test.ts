import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec.js";

const VALID = `# Add a rate limiter

## Goal
Limit calls.

## Requirements
- Token bucket.

## Acceptance criteria
- Tests pass.
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
});
