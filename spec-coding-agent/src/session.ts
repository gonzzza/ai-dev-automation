import { execFile } from "node:child_process";
import type { AgentRun, AgentTask } from "./agent.js";
import { AGENT_REPORT_JSON_SCHEMA } from "./agent.js";
import type { RunLog } from "./runlog.js";

// A session run writes the code with headless Claude Code (`claude -p`) instead of the Agent SDK, so
// it runs on whatever Claude Code is signed in with, a subscription included. Everything around it
// (preflight, claim, checks, scope, git state, secrets, commit, PR) is the same pipeline, in code.

export interface SessionConfig {
  repoRoot: string;
  writableDirs: string[];
  model: string;
  effort: string;
  maxBudgetUsd: number;
  /** Wall-clock limit: print mode has no turn limit. */
  maxMinutes: number;
  /** The CLI's environment. The API key variables are removed before the session starts. */
  env: NodeJS.ProcessEnv;
  runLog?: RunLog;
}

export interface SessionResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Starts `command` with `args`, writes `input` to its stdin, and collects its output. */
export type SessionSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number },
) => Promise<SessionResult>;

/** Files a session may not read, matching the agent's policy. */
const SECRET_READS = ["**/.env", "**/.env.*", "**/CLAUDE.local.md", "**/.npmrc", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx"];

/**
 * The `claude` arguments for a session run. `--permission-mode dontAsk` denies every tool call the
 * allowlist doesn't cover instead of prompting. Never `--bare`: it reads only ANTHROPIC_API_KEY,
 * never the signed-in subscription.
 */
export function sessionArgs(config: Pick<SessionConfig, "writableDirs" | "model" | "effort" | "maxBudgetUsd">): string[] {
  const allowed = ["Read", "Glob", "Grep", "Bash(npm run check)", ...config.writableDirs.flatMap((dir) => [`Edit(./${dir}/**)`, `Write(./${dir}/**)`])];
  const denied = [...SECRET_READS.map((glob) => `Read(${glob})`), "Bash(git *)", "Bash(gh *)", "WebFetch", "WebSearch"];
  return [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(AGENT_REPORT_JSON_SCHEMA),
    "--permission-mode", "dontAsk",
    "--setting-sources", "project",
    "--no-session-persistence",
    "--model", config.model,
    "--effort", config.effort,
    "--max-budget-usd", String(config.maxBudgetUsd),
    "--allowedTools", ...allowed,
    "--disallowedTools", ...denied,
  ];
}

/**
 * The session's environment: the CLI's own, minus the API key variables. Claude Code prefers an API
 * key it finds over the signed-in subscription, so leaving either in would bill the run to the API.
 */
export function sessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
}

interface ResultMessage {
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  result?: string;
  structured_output?: unknown;
}

/** Runs the task as a headless Claude Code session in the repo root and returns its validated report. */
export async function runSession<Report>(task: AgentTask<Report>, config: SessionConfig, spawn: SessionSpawn = spawnSession): Promise<AgentRun<Report>> {
  const args = sessionArgs(config);
  config.runLog?.event({ type: "session.start", command: ["claude", ...args], prompt: task.prompt });
  const timeoutMs = config.maxMinutes * 60_000;
  const result = await spawn("claude", args, { cwd: config.repoRoot, env: sessionEnv(config.env), input: task.prompt, timeoutMs });
  if (result.timedOut) {
    config.runLog?.event({ type: "session.end", timedOut: true, code: result.code });
    throw new Error(`Agent stopped without finishing: timed out after ${config.maxMinutes} minutes.`);
  }
  let message: ResultMessage;
  try {
    message = JSON.parse(result.stdout) as ResultMessage;
  } catch {
    config.runLog?.event({ type: "session.end", code: result.code, stderr: result.stderr });
    throw new Error(`Agent stopped without finishing: claude exited ${result.code} without a JSON result.\n${(result.stderr || result.stdout).trim().slice(-2_000)}`);
  }
  config.runLog?.event({ type: "session.end", code: result.code, result: message });
  // Same shape as an agent run's result, so the totals in run.end include it.
  config.runLog?.event({ type: "agent.end", subtype: message.subtype, costUsd: message.total_cost_usd ?? 0, turns: message.num_turns ?? 0, durationMs: message.duration_ms ?? 0 });
  if (message.subtype !== "success" || message.is_error) {
    const reason = message.subtype === "success" ? message.result : (message.subtype ?? `exit ${result.code}`);
    throw new Error(`Agent stopped without finishing: ${reason}.`);
  }
  const report = task.schema.safeParse(message.structured_output);
  if (!report.success) throw new Error(`Agent report did not match the schema: ${report.error.message}`);
  return { report: report.data, costUsd: message.total_cost_usd ?? 0, turns: message.num_turns ?? 0, durationMs: message.duration_ms ?? 0 };
}

/** The default spawn: no shell (claude is a native binary), the prompt on stdin, killed on timeout. */
export const spawnSession: SessionSpawn = (command, args, { cwd, env, input, timeoutMs }) =>
  new Promise((resolve) => {
    const child = execFile(command, args, { cwd, env, timeout: timeoutMs, killSignal: "SIGTERM", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && "killed" in error && error.killed);
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut });
    });
    // A child that exits before reading the whole prompt (not signed in, a bad flag, not installed)
    // breaks the pipe. That write error is expected, and the execFile callback reports the real
    // failure; unhandled, it would crash the harness before run.end is logged.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
