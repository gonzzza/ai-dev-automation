import { describe, expect, it } from "vitest";
import { parsePorcelainZ } from "../src/git.js";

describe("parsePorcelainZ", () => {
  it("keeps the first character of paths whose status starts with a space", () => {
    expect(parsePorcelainZ(" M demo-app/README.md\0?? demo-app/src/new.ts\0")).toEqual([
      "demo-app/README.md",
      "demo-app/src/new.ts",
    ]);
  });

  it("returns both paths of a rename, since the source is deleted and must pass the scope gate too", () => {
    expect(parsePorcelainZ("R  demo-app/x.yml\0.github/workflows/ci.yml\0 M demo-app/c.ts\0")).toEqual([
      "demo-app/x.yml",
      ".github/workflows/ci.yml",
      "demo-app/c.ts",
    ]);
  });

  it("handles spaces in paths and empty output", () => {
    expect(parsePorcelainZ("?? demo-app/my file.ts\0")).toEqual(["demo-app/my file.ts"]);
    expect(parsePorcelainZ("")).toEqual([]);
  });
});
