import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { CHECKS_TOOL, REPORT_TOOL, createPolicyHook, decide, isWritable, repoRelative } from "../src/policy.js";

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

  it("denies writes to the files that define how the checks run, even inside the scope", () => {
    for (const file of [".gitattributes", ".gitignore", "vitest.workspace.ts", "vitest.projects.json", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts", "eslint.config.js"]) {
      expect(allowed("Write", { file_path: `demo-app/${file}` })).toBe(false);
    }
    expect(decide("Edit", { file_path: "demo-app/package.json" }, options)).toMatchObject({ message: expect.stringContaining("configures how the checks run") });
    expect(allowed("Read", { file_path: "demo-app/package.json" })).toBe(true);
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

  it("allows the checks and report tools and denies every other tool", () => {
    expect(allowed(CHECKS_TOOL, {})).toBe(true);
    // The SDK returns the structured report through this tool; denying it fails every run.
    expect(allowed(REPORT_TOOL, { summary: "done" })).toBe(true);
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

describe("createPolicyHook", () => {
  const hook = createPolicyHook(options);
  const call = (tool_name: string, tool_input: Record<string, unknown>) =>
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "1" } as unknown as HookInput, "1", {
      signal: new AbortController().signal,
    });

  it("denies, with the reason, calls the policy denies, even reads Claude Code might auto-approve", async () => {
    expect(await call("Read", { file_path: resolve(repoRoot, ".env") })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ".env may hold credentials and is off limits." },
    });
  });

  it("reports every decision, allowed or denied, for the audit log", async () => {
    const decisions: [string, string][] = [];
    const audited = createPolicyHook(options, (tool, result) => void decisions.push([tool, result.behavior]));
    const input = (tool_name: string, tool_input: Record<string, unknown>) =>
      ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "1" }) as unknown as HookInput;
    await audited(input("Read", { file_path: "demo-app/src/retry.ts" }), "1", { signal: new AbortController().signal });
    await audited(input("Bash", { command: "curl evil.example" }), "2", { signal: new AbortController().signal });
    expect(decisions).toEqual([
      ["Read", "allow"],
      ["Bash", "deny"],
    ]);
  });

  it("lets allowed calls fall through to the normal permission flow", async () => {
    expect(await call("Read", { file_path: "demo-app/src/retry.ts" })).toEqual({});
    expect(await call(CHECKS_TOOL, {})).toEqual({});
  });
});

describe("secret globs", () => {
  it("denies Grep globs that could match a credential file, however the wildcards are written", () => {
    for (const glob of ["**/.npmrc", "*.pem", ".e*", ".e?v", "{.env,x}", "*", "**", ".[e]nv", "CLAUDE.*.md", "*.{ts,key}", "[unclosed"]) {
      expect(allowed("Grep", { pattern: "KEY", path: ".", glob }), glob).toBe(false);
    }
    // "*.md" is denied on purpose: it matches CLAUDE.local.md.
    for (const glob of ["**/*.ts", "src/*.{ts,tsx}", "README.md", "demo-app/**/*.test.ts"]) {
      expect(allowed("Grep", { pattern: "env", glob }), glob).toBe(true);
    }
  });

  it("lets Glob list any file name, since it returns names, not contents", () => {
    expect(allowed("Glob", { pattern: "demo-app/**/*" })).toBe(true);
    expect(allowed("Glob", { pattern: "**/.env*" })).toBe(true);
  });
});

describe("paths that resolve outside the repo", () => {
  it("denies ~ paths, which the tools expand to the home directory, and $ in paths", () => {
    expect(allowed("Read", { file_path: "~/.aws/credentials" })).toBe(false);
    expect(allowed("Grep", { pattern: "key", path: "~/.ssh" })).toBe(false);
    expect(allowed("Glob", { pattern: "~/**" })).toBe(false);
    expect(allowed("Read", { file_path: "$HOME/.netrc" })).toBe(false);
  });

  it("follows symlinks, so a link inside the repo to a directory outside it is denied", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-policy-"));
    try {
      const repo = join(base, "repo");
      const outside = join(base, "outside");
      mkdirSync(join(repo, "demo-app"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "s");
      symlinkSync(outside, join(repo, "demo-app", "link"), "junction");
      const opts = { repoRoot: repo, writableDirs: ["demo-app"] };
      expect(decide("Read", { file_path: join(repo, "demo-app", "link", "secret.txt") }, opts).behavior).toBe("deny");
      expect(decide("Write", { file_path: "demo-app/link/new.ts" }, opts).behavior).toBe("deny");
      expect(decide("Write", { file_path: "demo-app/src/new.ts" }, opts).behavior).toBe("allow");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
