#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { runAgent, type AgentConfig } from "./agent.js";
import { parseLimit, scopeDir } from "./args.js";
import { runChecks } from "./checks.js";
import { exec, run } from "./exec.js";
import { Git } from "./git.js";
import { runPipeline } from "./pipeline.js";
import { checksEnv, secretValues } from "./secrets.js";
import { parseSpec } from "./spec.js";

const USAGE = `Usage: npm run agent -- <spec.md> [options]

Options:
  --scope <dir>       Directory the agent may change (repeatable). Default: demo-app
  --base <branch>     Branch to start from and open the PR against. Default: main
  --model <id>        Default: claude-opus-5-5
  --effort <level>    low | medium | high | xhigh | max. Default: high
  --max-turns <n>     Default: 60
  --max-budget <usd>  Stop the agent past this spend. Default: 5
  --dry-run           Run and verify, but don't commit, push or open a PR`;

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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
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
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY (environment or .env at the repo root).");
  const specFile = resolve(userCwd, positionals[0]!);
  const spec = parseSpec(relative(repoRoot, specFile), await readFile(specFile, "utf8"));

  const effort = values.effort as AgentConfig["effort"];
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Invalid --effort: ${effort}`);
  const config: AgentConfig = {
    repoRoot,
    writableDirs: values.scope.map((dir) => scopeDir(repoRoot, userCwd, dir)),
    model: values.model,
    effort,
    maxTurns: parseLimit("--max-turns", values["max-turns"], { integer: true }),
    maxBudgetUsd: parseLimit("--max-budget", values["max-budget"]),
    // run_checks executes code the agent wrote, so it gets no credentials and a logged-out gh.
    checksEnv: checksEnv(process.env, await mkdtemp(resolve(tmpdir(), "agent-gh-"))),
  };

  const result = await runPipeline({
    spec,
    git: new Git(exec, repoRoot),
    base: values.base,
    writableDirs: config.writableDirs,
    model: config.model,
    dryRun: values["dry-run"],
    runAgent: (s) => runAgent(s, config, exec),
    runChecks: () => runChecks(exec, repoRoot, config.checksEnv),
    readFile: (path) => (existsSync(resolve(repoRoot, path)) ? readFile(resolve(repoRoot, path), "utf8") : Promise.resolve(undefined)),
    isSymlink: (path) => lstat(resolve(repoRoot, path)).then((s) => s.isSymbolicLink(), () => false),
    secrets: secretValues(process.env),
    log: console.log,
  });

  if (result.status === "opened") {
    console.log(`\n✅ Opened ${result.url}`);
  } else {
    console.log(`\n✅ Dry run passed on ${result.branch}. Changes are uncommitted. PR body would be:\n\n${result.body}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
