import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tail, type Exec } from "./exec.js";

export interface CheckResult {
  passed: boolean;
  output: string;
}

/** The Node image the sandbox runs. Match .nvmrc, so the checks run on the same Node as CI. */
export const DEFAULT_SANDBOX_IMAGE = "node:24-bookworm-slim";

/**
 * Where agent-written code runs. `none`: directly on this machine, with a credential-free
 * environment (checksEnv). `docker`: in a throwaway container with no network, no secrets, no
 * access outside the repo, and a read-only .git. Use `docker` wherever secrets live, such as CI.
 */
export type Sandbox = { kind: "none" } | { kind: "docker"; image: string; uid?: number; gid?: number };

/**
 * The `docker run` arguments for running `command` in the repo, isolated:
 * - `--network=none`: test code can't send anything anywhere, or download anything.
 * - a clean environment: only HOME, CI and npm settings, set here. Nothing from this process.
 * - only the repo is mounted, and its .git read-only, so test code can't plant hooks or config.
 *   (The git-state gate would catch that too; this stops it from happening at all.)
 * - no capabilities, no privilege escalation, and caps on processes and memory.
 * - the host user's uid/gid on Linux, so files the tests create aren't owned by root.
 */
export function sandboxArgs(
  repoRoot: string,
  command: string[],
  { image, uid, gid }: Omit<Extract<Sandbox, { kind: "docker" }>, "kind">,
  name?: string,
): string[] {
  return [
    "run",
    "--rm",
    // A name, so the harness can remove the container itself: killing the docker client on a
    // timeout doesn't stop it. --init forwards signals and reaps children the tests leave behind.
    ...(name ? [`--name=${name}`] : []),
    "--init",
    "--network=none",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--memory=4g",
    ...(uid !== undefined && gid !== undefined ? ["--user", `${uid}:${gid}`] : []),
    "--tmpfs=/tmp",
    "--env=HOME=/tmp",
    "--env=CI=1",
    "--env=npm_config_cache=/tmp/.npm",
    "--env=npm_config_update_notifier=false",
    `--volume=${repoRoot}:/work`,
    `--volume=${join(repoRoot, ".git")}:/work/.git:ro`,
    "--workdir=/work",
    image,
    ...command,
  ];
}

/**
 * Lint, typecheck and test the whole repo: the same gate CI applies. This runs code the agent wrote
 * (tests are code). Without a sandbox, pass `env` without credentials (see checksEnv); with the
 * docker sandbox, `env` is only the docker client's, and nothing of it reaches the container.
 */
export async function runChecks(exec: Exec, repoRoot: string, env?: NodeJS.ProcessEnv, sandbox: Sandbox = { kind: "none" }): Promise<CheckResult> {
  const command = ["npm", "run", "check"];
  if (sandbox.kind === "none") {
    const result = await exec(command[0]!, command.slice(1), { cwd: repoRoot, env });
    return { passed: result.code === 0, output: tail(`${result.stdout}\n${result.stderr}`.trim(), 20_000) };
  }
  const name = `agent-checks-${randomBytes(6).toString("hex")}`;
  try {
    const result = await exec("docker", sandboxArgs(repoRoot, command, sandbox, name), { cwd: repoRoot, env });
    return { passed: result.code === 0, output: tail(`${result.stdout}\n${result.stderr}`.trim(), 20_000) };
  } finally {
    // Always, and before anything inspects the tree: after a timeout the container would otherwise
    // keep running, with the repo mounted, while the gates check and commit it. After a normal exit
    // --rm has already removed it, and this is a harmless no-op.
    await exec("docker", ["rm", "--force", name], { env });
  }
}

/** Fails fast, before the agent runs, if the docker sandbox was asked for but can't be used. */
export async function assertSandboxAvailable(exec: Exec, sandbox: Sandbox, env?: NodeJS.ProcessEnv): Promise<void> {
  if (sandbox.kind !== "docker") return;
  const result = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { env });
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout).trim().split("\n")[0] || "the docker command failed";
    throw new Error(`--sandbox docker: Docker is not available (${reason}). Start Docker, or run with --sandbox none on a machine without secrets.`);
  }
}

/**
 * In-process MCP server exposing one tool, run_checks. The agent has no shell, so this fixed
 * command is the only thing it can start, though the tests it runs are code the agent wrote.
 */
export function createChecksServer(exec: Exec, repoRoot: string, env?: NodeJS.ProcessEnv, sandbox: Sandbox = { kind: "none" }) {
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
          const { passed, output } = await runChecks(exec, repoRoot, env, sandbox);
          return { content: [{ type: "text", text: `${passed ? "PASSED" : "FAILED"}\n\n${output}` }] };
        },
      ),
    ],
  });
}
