import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CanUseTool, HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { isSecretFile } from "./secrets.js";

export const CHECKS_TOOL = "mcp__repo__run_checks";

/**
 * The SDK tool the agent calls to return its final report when `outputFormat` is a JSON schema.
 * It only carries data: the harness validates the report against the schema and scans the PR body
 * for secrets. Denying it leaves the result without `structured_output`, so the run fails.
 */
export const REPORT_TOOL = "StructuredOutput";

/** Built-in tools the agent may see at all. No Bash, web or subagent tools. */
export const AGENT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);

export interface PolicyOptions {
  repoRoot: string;
  /** Repo-relative directories the agent may write to, e.g. ["demo-app"]. */
  writableDirs: string[];
}

/**
 * The real location of `path`, with symlinks resolved, so a link inside the repo that points
 * outside it is seen as outside. A path that doesn't exist yet (a new file) resolves through
 * its nearest existing ancestor.
 */
function realLocation(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...rest);
}

/** Repo-relative, forward-slash path, or null if `target` is outside the repo, symlinks included. */
export function repoRelative(repoRoot: string, target: string): string | null {
  const rel = relative(realLocation(resolve(repoRoot)), realLocation(resolve(repoRoot, target)));
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

/**
 * Files that define how the checks run: package scripts, dependencies, compiler, test and lint config.
 * Changing them could turn the harness's own `npm run check` into a no-op, or make the
 * agent-run tests run arbitrary scripts, so they stay off limits even inside the scope.
 */
const PROTECTED_CONFIG = /^(package(-lock)?\.json|\.npmrc|\.git(attributes|ignore)|tsconfig.*\.json|(vitest|vite|eslint)\.config\.[cm]?[jt]s|vitest\.(workspace|projects)\.([cm]?[jt]s|json)|\.eslintrc.*)$/;

export function isProtectedConfig(path: string): boolean {
  return PROTECTED_CONFIG.test(path.split("/").pop() ?? "");
}

export function isWritable(path: string, writableDirs: string[]): boolean {
  const segments = path.split("/");
  if (segments.includes("node_modules") || segments.includes(".git") || isProtectedConfig(path)) return false;
  return writableDirs.some((dir) => path.startsWith(`${dir.replace(/\/+$/, "")}/`));
}

/** Concrete names of credential files, to test globs against. Keep in step with isSecretFile. */
const SECRET_FILE_EXAMPLES = [".env", ".env.local", ".env.production", ".npmrc", "CLAUDE.local.md", "server.pem", "server.key", "cert.p12", "cert.pfx"];

/**
 * The file-name part of a glob as a regex, with ripgrep's semantics: `*` and `?` match dotfiles too,
 * `{a,b}` is alternation and `[...]` a class. Conservative: anything unparseable counts as matching.
 */
function globSegmentRegExp(segment: string): RegExp | null {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (c === "{") source += "(?:";
    else if (c === "}") source += ")";
    else if (c === ",") source += "|";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 1);
      if (end === -1) return null;
      source += `[${segment.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = end;
    } else source += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "i");
  } catch {
    return null;
  }
}

/** Whether a file glob could match any credential file name. */
export function globMatchesSecretFile(glob: string): boolean {
  const regex = globSegmentRegExp(glob.split(/[\\/]/).pop() ?? "");
  return regex === null || SECRET_FILE_EXAMPLES.some((name) => regex.test(name));
}

/** The path a tool call touches, from the inputs of Read/Write/Edit (file_path) and Glob/Grep (path). */
function targetPath(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.path;
  return typeof p === "string" ? p : undefined;
}

/**
 * Decide every tool call: reads inside the repo except secret files (.env, keys), writes only inside
 * `writableDirs`, the checks tool, the report tool, and nothing else. Denials go back to the
 * model as a message, so it can correct course instead of failing the run.
 */
export function decide(toolName: string, input: Record<string, unknown>, { repoRoot, writableDirs }: PolicyOptions): PermissionResult {
  const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

  if (toolName === CHECKS_TOOL || toolName === REPORT_TOOL) return { behavior: "allow", updatedInput: input };

  if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
    const raw = targetPath(input) ?? ".";
    // Glob's pattern and Grep's glob filter are file globs; they must not climb out of the repo.
    const glob = toolName === "Glob" ? input.pattern : toolName === "Grep" ? input.glob : undefined;
    // The tools expand a leading ~ to the home directory, which path.resolve does not: deny it outright.
    for (const value of [raw, glob]) {
      if (typeof value === "string" && (value.startsWith("~") || value.includes("$"))) {
        return deny(`Paths starting with ~ or containing $ are not allowed: ${value}. Use paths inside the repository.`);
      }
    }
    const path = repoRelative(repoRoot, raw);
    if (path === null) return deny(`${raw} is outside the repository.`);
    if (typeof glob === "string" && (isAbsolute(glob) || glob.split(/[\\/]/).includes(".."))) {
      return deny(`File globs must stay inside the repository: ${glob}`);
    }
    if (isSecretFile(path)) return deny(`${path} may hold credentials and is off limits.`);
    // Grep returns contents, and ripgrep's --glob can override ignore rules, so its glob must not be
    // able to match a credential file. (Glob only lists names, so "demo-app/**/*" stays allowed.)
    if (toolName === "Grep" && typeof glob === "string" && globMatchesSecretFile(glob)) {
      return deny(`The glob ${glob} could match files that may hold credentials. Use a narrower glob, such as *.ts.`);
    }
    if (WRITE_TOOLS.has(toolName) && isProtectedConfig(path)) {
      return deny(`${path} configures how the checks run and cannot be changed by the agent. If the spec needs it, say so in your notes.`);
    }
    if (WRITE_TOOLS.has(toolName) && !isWritable(path, writableDirs)) {
      return deny(`Writing ${path} is not allowed. You may only change files under: ${writableDirs.join(", ")}.`);
    }
    return { behavior: "allow", updatedInput: input };
  }

  return deny(`The ${toolName} tool is not available to this agent.`);
}

export function createToolPolicy(options: PolicyOptions): CanUseTool {
  return async (toolName, input) => decide(toolName, input, options);
}

/**
 * The same policy as a PreToolUse hook. canUseTool only runs when Claude Code would otherwise
 * prompt, and it may auto-approve reads inside the working directory without asking, so the
 * hook is what guarantees every call is checked. Allowed calls fall through to the normal flow.
 */
export function createPolicyHook(
  options: PolicyOptions,
  /** Sees every decision, allowed or denied, for the audit log. */
  onDecision?: (tool: string, result: PermissionResult) => void,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const result = decide(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, options);
    onDecision?.(input.tool_name, result);
    if (result.behavior !== "deny") return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: result.message } };
  };
}
