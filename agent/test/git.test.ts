import { describe, expect, it } from "vitest";
import { fingerprintConfig, parsePorcelainZ } from "../src/git.js";

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

describe("fingerprintConfig", () => {
  const list = (...entries: string[]) => entries.map((entry) => `${entry}\0`).join("");

  it("drops only VS Code's merge-base keys and keeps every other entry in order", () => {
    const input = list(
      "core.bare\nfalse",
      "branch.main.vscode-merge-base\norigin/main",
      "branch.main.remote\norigin",
      "branch.agent/x.vscode-merge-base\norigin/main",
      "core.hookspath\n/tmp/planted",
    );
    expect(fingerprintConfig(input)).toBe(["core.bare\nfalse", "branch.main.remote\norigin", "core.hookspath\n/tmp/planted"].join("\0"));
  });

  it("does not drop keys that only contain the inert name", () => {
    const input = list("core.vscode-merge-base\nx", "branch.main.vscode-merge-base.extra\nx");
    expect(fingerprintConfig(input)).toBe(["core.vscode-merge-base\nx", "branch.main.vscode-merge-base.extra\nx"].join("\0"));
  });
});
