import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tail, type Exec } from "./exec.js";

export interface CheckResult {
  passed: boolean;
  output: string;
}

/** The Node image the sandbox runs. Match .nvmrc, so the checks run on the same Node as CI. Not the -slim
 * variant: the agent's own tests create real git repositories, and -slim has no git. */
export const DEFAULT_SANDBOX_IMAGE = "node:24-bookworm";

/**
 * Where agent-written code runs. `none`: directly on this machine, with a credential-free
 * environment (checksEnv). `docker`: in a throwaway container with no network, no secrets, no
 * access outside the repo, and a read-only .git. Use `docker` wherever secrets live, such as CI.
 */
export type Sandbox =
  | { kind: "none" }
  | {
      kind: "docker";
      image: string;
      uid?: number;
      gid?: number;
      /** Docker volume holding node_modules installed for the container's platform; see prepareSandbox. */
      depsVolume?: string;
    };

type DockerSandbox = Omit<Extract<Sandbox, { kind: "docker" }>, "kind">;

/** Written last by the install step, so a half-finished install is never used. */
const INSTALLED_MARKER = ".ai-dev-automation-installed";
export const DEPS_VOLUME_LABEL = "ai-dev-automation.deps";

/**
 * The volume for a lockfile and image. A new lockfile or image gets a new volume, so dependencies
 * are installed once per change and reused after that. Old ones: `docker volume prune --filter label=ai-dev-automation.deps`.
 */
export function depsVolumeName(lockfile: string, image: string): string {
  return `ai-dev-automation-deps-${createHash("sha256").update(image).update("\0").update(lockfile).digest("hex").slice(0, 16)}`;
}

/**
 * The `docker run` arguments for installing dependencies into `volume`, for the container's
 * platform. The host's node_modules can't be reused: native packages (rolldown, esbuild) ship a
 * binary per OS, so a Windows or macOS install fails in the Linux container.
 *
 * This step has network access, to download packages, and nothing else the checks don't have: no
 * secrets, the repo read-only, and only the lockfile and package.json files copied in. It runs
 * before the agent starts, so no agent-written code exists yet; what runs is `npm ci` on the
 * committed lockfile, the same as the CI job's own install. Files are handed to the host user at
 * the end, so the checks, which run as that user, can read them.
 */
export function installArgs(repoRoot: string, volume: string, { image, uid, gid }: DockerSandbox): string[] {
  const owner = uid !== undefined && gid !== undefined ? ` && chown -R ${uid}:${gid} /deps` : "";
  const script = [
    "set -e",
    "mkdir -p /tmp/build && cd /tmp/build",
    "cp /src/package.json /src/package-lock.json .",
    // Workspaces need their package.json too, at the same relative paths.
    `for ws in $(node -p 'require("/src/package.json").workspaces?.join(" ") ?? ""'); do mkdir -p "$ws" && cp "/src/$ws/package.json" "$ws/"; done`,
    "npm ci --no-audit --no-fund",
    "find /deps -mindepth 1 -delete",
    `cp -a node_modules/. /deps/${owner}`,
    `touch /deps/${INSTALLED_MARKER}`,
  ].join("\n");
  return [
    "run",
    "--rm",
    "--cap-drop=ALL",
    "--cap-add=CHOWN",
    "--cap-add=DAC_OVERRIDE",
    "--cap-add=FOWNER",
    "--security-opt=no-new-privileges",
    // exec: packages are built here, and install scripts such as esbuild's run their own binary.
    "--tmpfs=/tmp:exec",
    "--env=HOME=/tmp",
    "--env=npm_config_cache=/tmp/.npm",
    "--env=npm_config_update_notifier=false",
    `--volume=${repoRoot}:/src:ro`,
    `--volume=${volume}:/deps`,
    image,
    "sh",
    "-c",
    script,
  ];
}

/**
 * Makes sure the dependency volume for this lockfile exists and is complete, installing it if not,
 * and returns the sandbox with it attached. Runs before the agent, so a failure stops the run early.
 */
export async function prepareSandbox(
  exec: Exec,
  repoRoot: string,
  sandbox: Sandbox,
  { env, log, readLockfile }: { env?: NodeJS.ProcessEnv; log: (line: string) => void; readLockfile: () => Promise<string> },
): Promise<Sandbox> {
  if (sandbox.kind !== "docker") return sandbox;
  const volume = depsVolumeName(await readLockfile(), sandbox.image);
  const ready = await exec("docker", ["run", "--rm", "--network=none", `--volume=${volume}:/deps:ro`, sandbox.image, "test", "-f", `/deps/${INSTALLED_MARKER}`], { env });
  if (ready.code !== 0) {
    log(`Installing dependencies for the sandbox into Docker volume ${volume} (once per lockfile)...`);
    await exec("docker", ["volume", "create", `--label=${DEPS_VOLUME_LABEL}`, volume], { env });
    const install = await exec("docker", installArgs(repoRoot, volume, sandbox), { env, timeoutMs: 15 * 60_000 });
    if (install.code !== 0) {
      throw new Error(`--sandbox docker: installing dependencies failed:\n${tail(`${install.stdout}\n${install.stderr}`.trim(), 4_000)}`);
    }
  }
  return { ...sandbox, depsVolume: volume };
}

/**
 * The `docker run` arguments for running `command` in the repo, isolated:
 * - `--network=none`: test code can't send anything anywhere, or download anything.
 * - a clean environment: only HOME, CI and npm settings, set here. Nothing from this process.
 * - only the repo is mounted, and its .git read-only, so test code can't plant hooks or config.
 *   (The git-state gate would catch that too; this stops it from happening at all.)
 * - no capabilities, no privilege escalation, and caps on processes and memory.
 * - the host user's uid/gid on Linux, so files the tests create aren't owned by root.
 */
export function sandboxArgs(repoRoot: string, command: string[], { image, uid, gid, depsVolume }: DockerSandbox, name?: string): string[] {
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
    // Dependencies built for the container's platform, read-only: test code can't tamper with the
    // packages later runs use, and the host's own node_modules stays out of reach.
    ...(depsVolume ? [`--volume=${depsVolume}:/work/node_modules:ro`] : []),
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
