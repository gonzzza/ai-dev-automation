import { isAbsolute, relative, resolve } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { isSecretFile } from "./secrets.js";

export const CHECKS_TOOL = "mcp__repo__run_checks";

/** Built-in tools the agent may see at all. No Bash, web or subagent tools. */
export const AGENT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);

export interface PolicyOptions {
  repoRoot: string;
  /** Repo-relative directories the agent may write to, e.g. ["demo-app"]. */
  writableDirs: string[];
}

/** Repo-relative, forward-slash path, or null if `target` is outside the repo. */
export function repoRelative(repoRoot: string, target: string): string | null {
  const rel = relative(repoRoot, resolve(repoRoot, target));
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

export function isWritable(path: string, writableDirs: string[]): boolean {
  const segments = path.split("/");
  if (segments.includes("node_modules") || segments.includes(".git")) return false;
  return writableDirs.some((dir) => path.startsWith(`${dir.replace(/\/+$/, "")}/`));
}

/** The path a tool call touches, from the inputs of Read/Write/Edit (file_path) and Glob/Grep (path). */
function targetPath(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.path;
  return typeof p === "string" ? p : undefined;
}

/**
 * Decide every tool call: reads inside the repo except secret files (.env, keys), writes only inside
 * `writableDirs`, the checks tool, and nothing else. Denials go back to the
 * model as a message, so it can correct course instead of failing the run.
 */
export function decide(toolName: string, input: Record<string, unknown>, { repoRoot, writableDirs }: PolicyOptions): PermissionResult {
  const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

  if (toolName === CHECKS_TOOL) return { behavior: "allow", updatedInput: input };

  if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
    const raw = targetPath(input) ?? ".";
    const path = repoRelative(repoRoot, raw);
    if (path === null) return deny(`${raw} is outside the repository.`);
    // Glob's pattern and Grep's glob filter are file globs; they must not climb out of the repo.
    const glob = toolName === "Glob" ? input.pattern : toolName === "Grep" ? input.glob : undefined;
    if (typeof glob === "string" && (isAbsolute(glob) || glob.split(/[\\/]/).includes(".."))) {
      return deny(`File globs must stay inside the repository: ${glob}`);
    }
    if (isSecretFile(path)) return deny(`${path} may hold credentials and is off limits.`);
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
