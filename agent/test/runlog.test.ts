import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFindings } from "../src/fix.js";
import { parseLimit } from "../src/args.js";
import { parseSpec } from "../src/spec.js";
import { classifyFailure, JsonlRunLog, newRunId, totalsOf, withRunLog, type RunEvent, type RunLog } from "../src/runlog.js";

describe("newRunId", () => {
  it("is sortable by time and unique per run", () => {
    expect(newRunId(new Date("2026-11-09T07:30:12.345Z"), () => "3f9a1c")).toBe("20261109T073012Z-3f9a1c");
    expect(newRunId()).not.toBe(newRunId());
  });
});

describe("JsonlRunLog", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends one redacted JSON object per line, tagged with time and run id", () => {
    dir = mkdtempSync(join(tmpdir(), "runlog-test-"));
    const log = new JsonlRunLog("run-1", join(dir, "nested"), ["sk-test-value-from-the-env"], () => new Date("2026-11-09T00:00:00Z"));
    log.event({ type: "log", line: "key is sk-test-value-from-the-env" });
    log.event({ type: "sdk.message", message: { text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
    log.event({ type: "run.end", error: new Error("boom") });

    const lines = readFileSync(log.path, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.path).toBe(join(dir, "nested", "run-1.jsonl"));
    expect(lines).toEqual([
      { ts: "2026-11-09T00:00:00.000Z", runId: "run-1", type: "log", line: "key is [REDACTED]" },
      { ts: "2026-11-09T00:00:00.000Z", runId: "run-1", type: "sdk.message", message: { text: "token [REDACTED]" } },
      { ts: "2026-11-09T00:00:00.000Z", runId: "run-1", type: "run.end", error: { name: "Error", message: "boom" } },
    ]);
  });

  it("redacts values before JSON escaping, so secrets with newlines or quotes are caught too", () => {
    dir = mkdtempSync(join(tmpdir(), "runlog-test-"));
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const quoted = 'pa"ss\\word-from-env-123';
    const log = new JsonlRunLog("run-1", dir, [pem, quoted]);
    log.event({ type: "sdk.message", message: { content: [`key: ${pem}`, `pw: ${quoted}`] }, error: new Error(`failed with ${quoted}`) });

    const text = readFileSync(log.path, "utf8");
    expect(text).not.toContain("MIIEpAIBAAKCAQEA");
    expect(text).not.toContain("word-from-env");
    expect(JSON.parse(text)).toMatchObject({ message: { content: ["key: [REDACTED]", "pw: [REDACTED]"] }, error: { message: "failed with [REDACTED]" } });
  });

  it("creates the log on first write, and an unusable log dir doesn't fail the run", () => {
    dir = mkdtempSync(join(tmpdir(), "runlog-test-"));
    writeFileSync(join(dir, "a-file"), "");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const log = new JsonlRunLog("run-1", join(dir, "a-file", "logs"), []); // a dir under a file
      expect(() => log.event({ type: "agent.end", costUsd: 1, turns: 2 })).not.toThrow();
      expect(log.totals()).toEqual({ costUsd: 1, turns: 2 }); // still counted without a file
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("makes the log readable by its owner only", () => {
    dir = mkdtempSync(join(tmpdir(), "runlog-test-"));
    const log = new JsonlRunLog("run-1", join(dir, "logs"), []);
    log.event({ type: "log", line: "x" });
    expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("refuses an existing log dir that others can access, without failing the run", () => {
    dir = mkdtempSync(join(tmpdir(), "runlog-test-"));
    const shared = join(dir, "shared");
    mkdirSync(shared, { mode: 0o777 });
    chmodSync(shared, 0o777); // as if another user had created it first
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const log = new JsonlRunLog("run-1", shared, []);
      log.event({ type: "log", line: "x" });
      expect(existsSync(log.path)).toBe(false);
      expect(warn.mock.calls[0]![0]).toContain("no group or other access");
    } finally {
      warn.mockRestore();
    }
  });

  it("never fails the run when the log can't be written, and warns once", () => {
    dir = mkdtempSync(join(tmpdir(), "runlog-test-"));
    const log = new JsonlRunLog("run-1", dir, []);
    mkdirSync(log.path, { recursive: true }); // a directory where the file should be: every append fails
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => {
        log.event({ type: "log", line: "one" });
        log.event({ type: "log", line: "two" });
      }).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("Could not write the audit log");
    } finally {
      warn.mockRestore();
    }
  });
});

function memoryLog(): RunLog & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { runId: "run-1", events, event: (e) => void events.push(e) };
}

describe("withRunLog", () => {
  const clock = (() => {
    let t = 1_000;
    return () => (t += 500);
  })();

  it("brackets the run with start and end events, ending with the summary", async () => {
    const log = memoryLog();
    await withRunLog(log, { mode: "spec" }, async () => ({ status: "opened" }), clock);
    expect(log.events).toEqual([
      { type: "run.start", mode: "spec" },
      { type: "run.end", ok: true, durationMs: 500, status: "opened" },
    ]);
  });

  it("puts the agent's cost and turns in run.end, also when the run fails after the agent ran", async () => {
    const log = Object.assign(memoryLog(), { totals: () => totalsOf(log.events) });
    const failing = withRunLog(log, {}, async () => {
      log.event({ type: "agent.end", costUsd: 4.98, turns: 60 });
      throw new Error("Checks failed after the agent finished. Branch agent/x kept for inspection.");
    });
    await expect(failing).rejects.toThrow();
    expect(log.events.at(-1)).toMatchObject({ type: "run.end", ok: false, costUsd: 4.98, turns: 60, category: "checks-failed" });
  });

  it("always writes run.end, with a failure category, and rethrows", async () => {
    const log = memoryLog();
    const failing = withRunLog(log, {}, async () => {
      throw new Error("Checks failed after the agent finished. Branch agent/x kept for inspection.");
    });
    await expect(failing).rejects.toThrow("Checks failed");
    expect(log.events.at(-1)).toMatchObject({ type: "run.end", ok: false, category: "checks-failed", error: expect.stringContaining("Checks failed") });
  });
});

describe("classifyFailure", () => {
  it.each([
    ["Agent stopped without finishing: error_max_budget_usd (cost $5.01).", "agent-stopped"],
    ["Agent report did not match the schema: ...", "bad-report"],
    ["Possible secret in the PR body (GitHub token). Nothing was committed; branch agent/x kept for inspection.", "secret-found"],
    ["PR #5 is merged.", "preflight"],
    ["Something unexpected", "other"],
  ])("%s → %s", (message, category) => {
    expect(classifyFailure(message)).toBe(category);
  });
});

describe("classifyFailure on input and configuration errors", () => {
  const errorOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected a throw");
  };

  it("classifies the errors the real parsers throw", () => {
    expect(classifyFailure(errorOf(() => parseLimit("--max-turns", "abc", { integer: true })))).toBe("config");
    expect(classifyFailure("Invalid --effort: extreme")).toBe("config");
    expect(classifyFailure("Set ANTHROPIC_API_KEY (environment or .env at the repo root).")).toBe("config");
    expect(classifyFailure(errorOf(() => parseFindings("not json")))).toBe("bad-input");
    expect(classifyFailure(errorOf(() => parseFindings('[{"severity":"urgent"}]')))).toBe("bad-input");
    expect(classifyFailure(errorOf(() => parseSpec("specs/x.md", "no title")))).toBe("bad-input");
    expect(classifyFailure("ENOENT: no such file or directory, open 'nope.json'")).toBe("bad-input"); // a missing spec or findings file
    expect(classifyFailure(errorOf(() => parseSpec("specs/x.md", "# T\n\n## Goal\nx\n")))).toBe("bad-input");
  });
});
