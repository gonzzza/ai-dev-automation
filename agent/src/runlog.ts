import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
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

export interface RunTotals {
  costUsd: number;
  turns: number;
}

/** Cost and turns summed over every agent.end event, so run.end carries them even when the run fails. */
export function totalsOf(events: Iterable<RunEvent>): RunTotals {
  const totals = { costUsd: 0, turns: 0 };
  for (const e of events) {
    if (e.type !== "agent.end") continue;
    totals.costUsd += typeof e.costUsd === "number" ? e.costUsd : 0;
    totals.turns += typeof e.turns === "number" ? e.turns : 0;
  }
  return totals;
}

/**
 * Appends one JSON object per line to `<dir>/<runId>.jsonl`. Every string is redacted before it is
 * serialized, so the log can be uploaded and kept like any audit record. Writes are synchronous: a
 * run that crashes still leaves everything up to the crash on disk. Logging never fails the run: a
 * write error is reported once on stderr and the run carries on.
 */
export class JsonlRunLog implements RunLog {
  readonly path: string;
  private failed = false;
  private ready = false;
  private readonly agentEnds: RunEvent[] = [];

  constructor(
    readonly runId: string,
    private readonly dir: string,
    private readonly secrets: string[],
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.path = join(dir, `${runId}.jsonl`);
  }

  /** Totals so far, for run.end. Kept in memory, so they survive a log that can't be written. */
  totals(): RunTotals {
    return totalsOf(this.agentEnds);
  }

  event(event: RunEvent): void {
    if (event.type === "agent.end") this.agentEnds.push(event);
    try {
      if (!this.ready) {
        // Created on first use, inside the guard, so an unusable --log-dir can't fail the run. Owner-only
        // modes: the transcript can hold sensitive code that redaction doesn't recognize, and the
        // default location is a shared temp directory. (Windows ignores the modes.)
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        // mkdirSync keeps an existing directory as it is, and the default path is predictable, so
        // someone else on a shared machine could have created it first. Refuse one owned by another
        // user; tighten our own to 700 (a plain `mkdir` leaves 755). POSIX-only: Windows reports
        // neither owner nor POSIX modes.
        if (process.platform !== "win32") {
          const stat = statSync(this.dir);
          if (stat.uid !== process.getuid?.()) throw new Error(`${this.dir} is owned by another user; choose another --log-dir.`);
          if ((stat.mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
        }
        this.ready = true;
      }
      // Redact values before serializing: once escaped as JSON, a secret with a newline or a quote
      // (a PEM key, say) no longer matches its raw form.
      const line = JSON.stringify({ ts: this.clock().toISOString(), runId: this.runId, ...event }, (_key, value: unknown) => {
        if (value instanceof Error) return { name: value.name, message: redactSecrets(value.message, this.secrets) };
        return typeof value === "string" ? redactSecrets(value, this.secrets) : value;
      });
      appendFileSync(this.path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      if (!this.failed) console.error(`⚠️ Could not write the audit log ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
      this.failed = true;
    }
  }
}

/**
 * Runs `fn` between a `run.start` and a `run.end` event. `run.end` is always written: with the
 * summary `fn` returns on success, or with the error and its category on failure, which is rethrown.
 * Those two events are what metrics are built from: outcome, cost, turns and duration per run.
 */
export async function withRunLog<T extends Record<string, unknown>>(
  log: RunLog & { totals?(): RunTotals },
  start: Record<string, unknown>,
  fn: () => Promise<T>,
  clock: () => number = Date.now,
): Promise<T> {
  const began = clock();
  log.event({ type: "run.start", ...start });
  try {
    const summary = await fn();
    log.event({ type: "run.end", ok: true, durationMs: clock() - began, ...log.totals?.(), ...summary });
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Cost and turns too: the most expensive failures (a budget overrun, checks failing after a full
    // run) are exactly the ones a cost dashboard must not miss.
    log.event({ type: "run.end", ok: false, durationMs: clock() - began, ...log.totals?.(), category: classifyFailure(message), error: message });
    throw error;
  }
}

export type FailureCategory =
  | "config"
  | "bad-input"
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
    [/^(Set ANTHROPIC_API_KEY|Invalid --|--\S+ )/, "config"],
    [/^Findings (are not valid JSON|do not match)|: (spec must|spec is missing|file name must)|^ENOENT: /, "bad-input"],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? "other";
}
