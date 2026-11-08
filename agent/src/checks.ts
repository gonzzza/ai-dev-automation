import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { tail, type Exec } from "./exec.js";

export interface CheckResult {
  passed: boolean;
  output: string;
}

/**
 * Lint, typecheck and test the whole repo: the same gate CI applies. This runs code the agent
 * wrote (tests are code), so pass `env` without credentials; see checksEnv().
 */
export async function runChecks(exec: Exec, repoRoot: string, env?: NodeJS.ProcessEnv): Promise<CheckResult> {
  const result = await exec("npm", ["run", "check"], { cwd: repoRoot, env });
  return { passed: result.code === 0, output: tail(`${result.stdout}\n${result.stderr}`.trim(), 20_000) };
}

/**
 * In-process MCP server exposing one tool, run_checks. The agent has no shell, so this fixed
 * command is the only thing it can start, though the tests it runs are code the agent wrote.
 */
export function createChecksServer(exec: Exec, repoRoot: string, env?: NodeJS.ProcessEnv) {
  return createSdkMcpServer({
    name: "repo",
    version: "1.0.0",
    tools: [
      tool(
        "run_checks",
        "Run the repository's full quality gate (ESLint, TypeScript typecheck, Vitest in every workspace). " +
          "Returns PASSED or FAILED with the output tail. Call it after making changes, and again after each fix, until it passes.",
        {},
        async () => {
          const { passed, output } = await runChecks(exec, repoRoot, env);
          return { content: [{ type: "text", text: `${passed ? "PASSED" : "FAILED"}\n\n${output}` }] };
        },
      ),
    ],
  });
}
