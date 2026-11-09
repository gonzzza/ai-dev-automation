import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const INPUTS = ["standards-path", "standards-packs", "standards-ref", "max-standards-chars"];

describe("docs", () => {
  it("AC8: action.yml declares the standards inputs, with max-standards-chars defaulting to 40000", () => {
    const action = read("action.yml");
    for (const input of INPUTS) expect(action).toContain(`\n  ${input}:\n`);
    expect(action).toMatch(/max-standards-chars:\n.*\n\s+default: "40000"/);
  });

  it("AC8: the README documents the inputs, the file format and where to check standards out from", () => {
    const readme = read("README.md");
    for (const input of INPUTS) expect(readme).toContain(`| \`${input}\` |`);
    for (const key of ["id", "title", "severity", "applies_to", "use"]) expect(readme).toContain(`| \`${key}\` |`);
    expect(readme).toContain("never the PR head");
    expect(readme).toContain("github.event.pull_request.base.sha");
  });
});
