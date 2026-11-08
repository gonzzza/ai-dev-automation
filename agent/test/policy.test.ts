import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKS_TOOL, decide, isWritable, repoRelative } from "../src/policy.js";

const repoRoot = resolve("/repo");
const options = { repoRoot, writableDirs: ["demo-app"] };
const allowed = (tool: string, input: Record<string, unknown>) => decide(tool, input, options).behavior === "allow";

describe("decide", () => {
  it("allows reads anywhere inside the repo", () => {
    expect(allowed("Read", { file_path: resolve(repoRoot, "CLAUDE.md") })).toBe(true);
    expect(allowed("Grep", { pattern: "retry", path: "review-action/src" })).toBe(true);
    expect(allowed("Glob", { pattern: "demo-app/**/*.ts" })).toBe(true);
  });

  it("denies reading or writing files that may hold credentials", () => {
    expect(allowed("Read", { file_path: resolve(repoRoot, ".env") })).toBe(false);
    expect(allowed("Read", { file_path: "demo-app/.env.local" })).toBe(false);
    expect(allowed("Grep", { pattern: "KEY", path: ".env" })).toBe(false);
    expect(allowed("Read", { file_path: "CLAUDE.local.md" })).toBe(false);
    expect(allowed("Write", { file_path: "demo-app/.env" })).toBe(false);
    expect(allowed("Read", { file_path: ".env.example" })).toBe(true);
  });

  it("allows writes only inside the writable dirs", () => {
    expect(allowed("Write", { file_path: resolve(repoRoot, "demo-app/src/limiter.ts") })).toBe(true);
    expect(allowed("Edit", { file_path: "demo-app/README.md" })).toBe(true);
    expect(allowed("Edit", { file_path: resolve(repoRoot, "review-action/src/main.ts") })).toBe(false);
    expect(allowed("Write", { file_path: resolve(repoRoot, ".github/workflows/ci.yml") })).toBe(false);
    expect(allowed("Write", { file_path: resolve(repoRoot, "demo-app-evil/x.ts") })).toBe(false);
  });

  it("denies anything outside the repo, including via ..", () => {
    expect(allowed("Read", { file_path: resolve(repoRoot, "../secrets.txt") })).toBe(false);
    expect(allowed("Write", { file_path: "demo-app/../../etc/passwd" })).toBe(false);
    expect(allowed("Glob", { pattern: "../**/*.env" })).toBe(false);
    expect(allowed("Glob", { pattern: "/etc/*" })).toBe(false);
    expect(allowed("Grep", { pattern: "key", glob: "../**" })).toBe(false);
  });

  it("allows the checks tool and denies every other tool", () => {
    expect(allowed(CHECKS_TOOL, {})).toBe(true);
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Task", "mcp__other__run"]) {
      const result = decide(tool, {}, options);
      expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("not available") });
    }
  });

  it("explains denials so the agent can correct course", () => {
    const result = decide("Write", { file_path: "README.md" }, options);
    expect(result).toEqual({
      behavior: "deny",
      message: "Writing README.md is not allowed. You may only change files under: demo-app.",
    });
  });
});

describe("isWritable", () => {
  it("never allows node_modules or .git, even inside a writable dir", () => {
    expect(isWritable("demo-app/node_modules/x/index.js", ["demo-app"])).toBe(false);
    expect(isWritable("demo-app/.git/config", ["demo-app"])).toBe(false);
    expect(isWritable("demo-app/src/a.ts", ["demo-app/"])).toBe(true);
  });
});

describe("repoRelative", () => {
  it("normalizes to forward slashes and rejects escapes", () => {
    expect(repoRelative(repoRoot, resolve(repoRoot, "demo-app", "src"))).toBe("demo-app/src");
    expect(repoRelative(repoRoot, repoRoot)).toBe(".");
    expect(repoRelative(repoRoot, resolve(repoRoot, ".."))).toBeNull();
  });
});
