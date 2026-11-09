#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { runAgent, specTask, type AgentConfig } from "./agent.js";
import { parseLimit, scopeDir } from "./args.js";
import { assertSandboxAvailable, DEFAULT_SANDBOX_IMAGE, prepareSandbox, runChecks, type Sandbox } from "./checks.js";
import { exec, run } from "./exec.js";
import { fixTask, loadFixTemplate, parseFindings, runFixCycle, SEVERITIES, specPathForBranch, type Severity } from "./fix.js";
import { Git } from "./git.js";
import { runPipeline } from "./pipeline.js";
import { JsonlRunLog, newRunId, withRunLog } from "./runlog.js";
import { checksEnv, secretValues } from "./secrets.js";
import { parseSpec } from "./spec.js";
import { loadAgentStandards } from "./standards.js";

const USAGE = `Usage: npm run agent -- <spec.md> [options]
       npm run agent -- --fix-pr <number> --findings <file.json> [options]

Options:
  --scope <dir>       Directory the agent may change (repeatable). Default: demo-app
  --base <branch>     Branch to start from and open the PR against. Default: main
  --model <id>        Default: claude-opus-5-5
  --effort <level>    low | medium | high | xhigh | max. Default: high
  --max-turns <n>     Default: 60
  --max-budget <usd>  Stop the agent past this spend. Default: 5
  --dry-run           Run and verify, but don't commit, push or open a PR
  --log-dir <dir>     Where the run's audit log (<run id>.jsonl) goes. Default: <tmp>/spec-agent-runs
  --sandbox <kind>    Where agent-written tests run: none (this machine, credential-free env) or
                      docker (container: no network, no secrets, read-only .git). Default: none
  --sandbox-image <i> Image for --sandbox docker. Default: ${DEFAULT_SANDBOX_IMAGE}

Org standards (given to the agent in its system prompt, in spec and fix runs):
  --standards <dir>            Standards directory. Absent: no standards
  --standards-packs <list>     Comma-separated packs. Default: all
  --standards-ref <label>      Version label (a tag or SHA) for the log and the PR body
  --max-standards-chars <n>    Size budget for the standards. Default: 40000

Fix cycle (run on a checked-out agent/* PR branch):
  --fix-pr <number>      Address the AI review's findings on this PR, commit and push
  --findings <file>      The review action's findings-json output
  --reviewed-sha <sha>   Commit the findings are about; refuse if the branch moved since
  --min-severity <level> Findings below this are left for the human. Default: medium
  --max-cycles <n>       Stop after this many fix commits on the PR. Default: 5
  --agent-app <slug>     Refuse unless this GitHub App opened the PR (the agent's App, in CI)`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scope: { type: "string", multiple: true, default: ["demo-app"] },
      base: { type: "string", default: "main" },
      model: { type: "string", default: "claude-opus-5-5" },
      effort: { type: "string", default: "high" },
      "max-turns": { type: "string", default: "60" },
      "max-budget": { type: "string", default: "5" },
      "dry-run": { type: "boolean", default: false },
      "log-dir": { type: "string", default: join(tmpdir(), "spec-agent-runs") },
      sandbox: { type: "string", default: "none" },
      "sandbox-image": { type: "string", default: DEFAULT_SANDBOX_IMAGE },
      standards: { type: "string" },
      "standards-packs": { type: "string" },
      "standards-ref": { type: "string" },
      "max-standards-chars": { type: "string", default: "40000" },
      "fix-pr": { type: "string" },
      findings: { type: "string" },
      "reviewed-sha": { type: "string" },
      "min-severity": { type: "string", default: "medium" },
      "max-cycles": { type: "string", default: "5" },
      "agent-app": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const fixMode = values["fix-pr"] !== undefined;
  if (values.help || positionals.length !== (fixMode ? 0 : 1)) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  // npm runs workspace scripts from the workspace dir, so resolve against where the user ran it.
  const userCwd = process.env.INIT_CWD ?? process.cwd();
  const repoRoot = await run(exec, "git", ["rev-parse", "--show-toplevel"], userCwd);

  // ANTHROPIC_API_KEY can live in an untracked .env at the repo root. Take only that key: anything
  // else in the file stays out of this process's environment.
  const envFile = resolve(repoRoot, ".env");
  if (!process.env.ANTHROPIC_API_KEY && existsSync(envFile)) {
    const key = parseEnv(await readFile(envFile, "utf8")).ANTHROPIC_API_KEY;
    if (key) process.env.ANTHROPIC_API_KEY = key;
  }
  // One id per run, in the log file name, the commit trailer, the PR body and comments. The log is
  // redacted value by value and lives outside the repo, where the agent's tools can't read it. It
  // starts before anything else can fail, so every failure below ends with a run.end event.
  const secrets = secretValues(process.env);
  const runLog = new JsonlRunLog(newRunId(), resolve(userCwd, values["log-dir"]), secrets);
  const say = (line: string) => {
    console.log(line);
    runLog.event({ type: "log", line });
  };
  // In GitHub Actions, the run page holds the uploaded log, so comments can link to it.
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const runLink = GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined;
  console.log(`Run ${runLog.runId}. Audit log: ${runLog.path}`);

  const start = { mode: fixMode ? "fix" : "spec", args: process.argv.slice(2), node: process.version, ...(runLink ? { ciRun: runLink } : {}) };
  await withRunLog(runLog, start, async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY (environment or .env at the repo root).");
    const effort = values.effort as AgentConfig["effort"];
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Invalid --effort: ${effort}`);
    if (values.sandbox !== "none" && values.sandbox !== "docker") throw new Error(`Invalid --sandbox: ${values.sandbox}`);
    // The container runs as this user on Linux and macOS, so files the tests create are ours.
    const sandbox: Sandbox =
      values.sandbox === "docker" ? { kind: "docker", image: values["sandbox-image"], uid: process.getuid?.(), gid: process.getgid?.() } : { kind: "none" };
    const checksEnvironment = checksEnv(process.env, await mkdtemp(resolve(tmpdir(), "agent-gh-")));
    // With the sandbox, that environment only reaches the docker client, which may need to know
    // where its daemon is. Nothing of it passes into the container.
    const dockerClient = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^DOCKER_(HOST|CONTEXT|CONFIG|CERT_PATH|TLS_VERIFY)$/.test(name)));
    const config: AgentConfig = {
      repoRoot,
      writableDirs: values.scope.map((dir) => scopeDir(repoRoot, userCwd, dir)),
      model: values.model,
      effort,
      maxTurns: parseLimit("--max-turns", values["max-turns"], { integer: true }),
      maxBudgetUsd: parseLimit("--max-budget", values["max-budget"]),
      // run_checks executes code the agent wrote, so it gets no credentials and a logged-out gh.
      checksEnv: sandbox.kind === "docker" ? { ...checksEnvironment, ...dockerClient } : checksEnvironment,
      sandbox,
      runLog,
    };
    // Loaded once, before any git or agent work, so a bad standards directory fails fast. Spec runs
    // and fix runs both get them through config.
    const standards = await loadAgentStandards(
      {
        path: values.standards === undefined || values.standards === "" ? undefined : resolve(userCwd, values.standards),
        packs: (values["standards-packs"] ?? "").split(",").map((p) => p.trim()).filter(Boolean),
        ref: values["standards-ref"],
        maxChars: Number(values["max-standards-chars"]),
      },
      runLog,
    );
    if (standards) {
      config.standards = standards.standards;
      say(`Standards: ${standards.checked.join(", ") || "none"}${standards.dropped.length ? `; dropped: ${standards.dropped.join(", ")}` : ""}`);
    }
    await assertSandboxAvailable(exec, sandbox, config.checksEnv);
    // Dependencies for the container's platform, installed once per lockfile, before the agent runs.
    config.sandbox = await prepareSandbox(exec, repoRoot, sandbox, {
      env: config.checksEnv,
      log: say,
      readLockfile: () => readFile(resolve(repoRoot, "package-lock.json"), "utf8"),
    });

    const git = new Git(exec, repoRoot);
    const readRepoFile = (path: string) =>
      existsSync(resolve(repoRoot, path)) ? readFile(resolve(repoRoot, path), "utf8") : Promise.resolve(undefined);
    const gates = {
      writableDirs: config.writableDirs,
      runChecks: async () => {
        const result = await runChecks(exec, repoRoot, config.checksEnv, config.sandbox);
        runLog.event({ type: "checks.result", by: "harness", ...result });
        return result;
      },
      readFile: readRepoFile,
      isSymlink: (path: string) => lstat(resolve(repoRoot, path)).then((s) => s.isSymbolicLink(), () => false),
      secrets,
      log: say,
    };
    runLog.event({
      type: "run.config",
      head: await git.headSha(),
      model: config.model,
      effort,
      writableDirs: config.writableDirs,
      sandbox: config.sandbox?.kind === "docker" ? { image: config.sandbox.image, depsVolume: config.sandbox.depsVolume } : "none",
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
    });

    if (fixMode) {
      if (!values.findings) throw new Error("--fix-pr needs --findings <file.json>.");
      // A preview that still pushed and commented would be worse than no preview.
      if (values["dry-run"]) throw new Error("--dry-run is not supported with --fix-pr.");
      const minSeverity = values["min-severity"] as Severity;
      if (!SEVERITIES.includes(minSeverity)) throw new Error(`Invalid --min-severity: ${minSeverity}`);
      const pullNumber = parseLimit("--fix-pr", values["fix-pr"]!, { integer: true });
      const maxCycles = parseLimit("--max-cycles", values["max-cycles"], { integer: true });
      const findings = parseFindings(await readFile(resolve(userCwd, values.findings), "utf8"));
      runLog.event({ type: "fix.input", pullNumber, reviewedSha: values["reviewed-sha"], minSeverity, maxCycles, findings });
      const template = await loadFixTemplate();
      const result = await runFixCycle({
        ...gates,
        git,
        pullNumber,
        findings,
        reviewedSha: values["reviewed-sha"],
        agentApp: values["agent-app"],
        minSeverity,
        maxCycles,
        model: config.model,
        runId: runLog.runId,
        runLink,
        runAgent: async (actionable, deferred, branch) =>
          runAgent(
            fixTask(template, { branch, findings: actionable, deferred, writableDirs: config.writableDirs, specBody: await readRepoFile(specPathForBranch(branch)) }),
            config,
            exec,
          ),
      });
      switch (result.status) {
        case "nothing-to-fix":
          console.log("\n✅ Nothing to fix.");
          break;
        case "stale":
          console.log("\n✅ Skipped: the branch moved since the review. The next review decides.");
          break;
        case "stopped":
          console.log(`\n✅ Fix cycle stopped: ${result.reason} ${result.commentUrl}`);
          break;
        case "declined":
          console.log(`\n✅ The agent declined every finding; nothing was committed. ${result.commentUrl}`);
          break;
        case "fixed":
          console.log(`\n✅ Pushed fix cycle ${result.cycle}. ${result.commentUrl}`);
          break;
      }
      const { run: _run, ...summary } = "run" in result ? result : { ...result, run: undefined };
      return summary; // cost and turns come from the log's totals
    }

    const specFile = resolve(userCwd, positionals[0]!);
    const spec = parseSpec(relative(repoRoot, specFile), await readFile(specFile, "utf8"));
    runLog.event({ type: "spec.input", spec: spec.path, base: values.base, dryRun: values["dry-run"], body: spec.body });
    const result = await runPipeline({
      ...gates,
      spec,
      git,
      base: values.base,
      model: config.model,
      dryRun: values["dry-run"],
      runId: runLog.runId,
      standards: standards && { checked: standards.checked, dropped: standards.dropped, ...(standards.ref !== undefined ? { ref: standards.ref } : {}) },
      runAgent: async (s) => runAgent(await specTask(s, config.writableDirs), config, exec),
    });
    if (result.status === "opened") {
      console.log(`\n✅ Opened ${result.url}`);
    } else {
      console.log(`\n✅ Dry run passed on ${result.branch}. Changes are uncommitted. PR body would be:\n\n${result.body}`);
    }
    const { run: _run, ...summary } = result;
    return summary; // cost and turns come from the log's totals
  });
}

main().catch((error: unknown) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
