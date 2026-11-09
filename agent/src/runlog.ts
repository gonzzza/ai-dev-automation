import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./secrets.js";

/**
 * A sortable, unique id for one agent run, e.g. "20261109T073012Z-3f9a1c". It goes into the log
 * file name, the commit trailer, the PR body and comments, so a merged line traces back to its run.
 */
export function newRunId(now: Date = new Date(), random: () => string = () => randomBytes(3).toString("hex")): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${random()}`;
}

export type RunEvent = { type: string } & Record<string, unknown>;

/** Where the audit events of one run go. The CLI writes a file; tests collect events in memory. */
export interface RunLog {
  readonly runId: string;
  event(event: RunEvent): void;
}

/**
 * Appends one JSON object per line to `<dir>/<runId>.jsonl`. Each line is redacted before it is
 * written, so the log can be uploaded and kept like any audit record. Writes are synchronous: a run
 * that crashes still leaves everything up to the crash on disk.
 */
export class JsonlRunLog implements RunLog {
  readonly path: string;

  constructor(
    readonly runId: string,
    dir: string,
    private readonly secrets: string[],
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${runId}.jsonl`);
  }

  event(event: RunEvent): void {
    const line = JSON.stringify({ ts: this.clock().toISOString(), runId: this.runId, ...event }, jsonSafe);
    appendFileSync(this.path, `${redactSecrets(line, this.secrets)}\n`, "utf8");
  }
}

/** Errors serialize to {} by default; keep their message. */
function jsonSafe(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

/**
 * Runs `fn` between a `run.start` and a `run.end` event. `run.end` is always written: with the
 * summary `fn` returns on success, or with the error and its category on failure, which is rethrown.
 * Those two events are what metrics are built from: outcome, cost, turns and duration per run.
 */
export async function withRunLog<T extends Record<string, unknown>>(
  log: RunLog,
  start: Record<string, unknown>,
  fn: () => Promise<T>,
  clock: () => number = Date.now,
): Promise<T> {
  const began = clock();
  log.event({ type: "run.start", ...start });
  try {
    const summary = await fn();
    log.event({ type: "run.end", ok: true, durationMs: clock() - began, ...summary });
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.event({ type: "run.end", ok: false, durationMs: clock() - began, category: classifyFailure(message), error: message });
    throw error;
  }
}

export type FailureCategory =
  | "preflight"
  | "agent-stopped"
  | "bad-report"
  | "checks-failed"
  | "git-state-changed"
  | "out-of-scope"
  | "secret-found"
  | "no-changes"
  | "other";

/**
 * A coarse category for a failed run, for metrics and alerts. Matches the messages the pipeline's
 * gates throw, so a change to one of those messages should come with a test here.
 */
export function classifyFailure(message: string): FailureCategory {
  const rules: [RegExp, FailureCategory][] = [
    [/^Agent stopped without finishing/, "agent-stopped"],
    [/^Agent report did not match|^Agent session ended without a result/, "bad-report"],
    [/^Checks failed after the agent finished/, "checks-failed"],
    [/^The git state .* changed during the run/, "git-state-changed"],
    [/^The agent changed files outside|^The run created symlinks/, "out-of-scope"],
    [/^Possible secret in/, "secret-found"],
    [/^The agent made no changes/, "no-changes"],
    [/^(Check out |Working tree is not clean|Branch .* already exists|PR #\d+ |Local .* is at )/, "preflight"],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? "other";
}
