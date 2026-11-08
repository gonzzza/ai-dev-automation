# Spec-driven agent

Turns a markdown spec into a pull request. It creates a branch, has Claude implement the spec with tests, independently verifies the result, then commits, pushes and opens a PR for human review. The [AI review action](../review-action) then reviews that PR like any other.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), the same agent loop and tools as Claude Code.

## Usage

```sh
# once: an API key in the environment, or in an untracked .env at the repo root
# (convenient for trusted specs; see "What this does not cover" below)
export ANTHROPIC_API_KEY=sk-ant-...

git switch main && git pull
npm run agent -- specs/001-rate-limiter.md            # opens a PR
npm run agent -- specs/001-rate-limiter.md --dry-run  # verify only, leave changes uncommitted
```

Requires `git` and an authenticated [`gh`](https://cli.github.com/).

| Option | Default | |
|--------|---------|---|
| `--scope <dir>` | `demo-app` | Directory the agent may change. Repeatable. |
| `--base <branch>` | `main` | Branch to start from and target. |
| `--model <id>` | `claude-opus-5-5` | |
| `--effort <level>` | `high` | `low` to `max`. |
| `--max-turns <n>` | `60` | Hard stop on agent turns. |
| `--max-budget <usd>` | `5` | Hard stop on spend. |
| `--dry-run` | off | Run and verify, but don't commit, push or open a PR. |

## How it works

```
spec.md ─▶ preflight ─▶ branch agent/<spec> ─▶ agent loop ─▶ npm run check ─▶ gates ─────────────▶ commit, push, gh pr create
           clean tree,                         read, plan,    run again by     .git untouched,       PR body: summary, plan,
           on base                             edit, test     the harness      scope, no secrets     testing, notes, cost
```

1. **Preflight.** It must start on the base branch with a clean tree, so the PR contains only the agent's work. The branch must not exist locally or on `origin`.
2. **Agent loop.** Claude gets the spec, the repo's `CLAUDE.md` for conventions, and a fixed toolset. It plans, implements, writes tests and iterates until the checks pass. It returns a structured report (plan, summary, testing, notes) that becomes the PR description.
3. **Verification.** The harness doesn't take the agent's word for it:
   1. It runs `npm run check` itself.
   2. It confirms that `.git/config` and `.git/hooks` are unchanged.
   3. It confirms that every changed file is inside `--scope` and none is a protected config file.
   4. It scans the changed files and the PR body for credentials.

   If any of these fails, nothing is committed and the branch is kept for inspection.
4. **PR.** Commit, push and `gh pr create`. CI and the AI review run on it. A human approves and merges.

## Guardrails

The agent's tools are limited in code, so the limits don't depend on the model following its instructions:

- **No shell.** It has only `Read`, `Write`, `Edit`, `Glob` and `Grep`. To run lint, typecheck and tests it calls `run_checks`, a tool served by an in-process MCP server that runs one fixed command.
- **Permission policy** ([`src/policy.ts`](src/policy.ts)). It runs as a `PreToolUse` hook, which sees every tool call. (`canUseTool` alone isn't enough, because Claude Code can approve reads inside the working directory without calling it.) The rules:
  - Reads are allowed only inside the repo.
  - No path or glob may name a file that can hold credentials: `.env*` other than `.env.example`, `CLAUDE.local.md`, `.npmrc`, key files.
  - Writes are allowed only inside `--scope`, and never in `node_modules`, `.git`, or the files that define how the checks run (`package.json`, `tsconfig*.json`, Vitest and ESLint config). This stops the agent from turning the harness's own check into a no-op.
  - Every other call is denied. The reason goes back to the model so it can correct course.
- **No credentials in the checks' environment.** `run_checks` gets an environment without the API key, tokens or passwords, and `gh` is logged out.
- **Safe git after the run.** Every harness git command runs with hooks and fsmonitor disabled. The harness also refuses to continue if `.git/config` or `.git/hooks` changed during the run, so nothing planted there runs with your credentials.
- **Secret scan.** Before committing, the harness scans every changed file and the PR body. It blocks the commit if it finds a credential value from its environment or a known key format.
- **No git access.** The agent cannot commit, push or touch other branches. The harness does all of that after verification.
- **Budgets.** `--max-turns` and `--max-budget` stop a runaway loop. Invalid values are rejected, so a typo can't turn a cap off.
- **Reproducible context.** It loads project settings (`CLAUDE.md`) only, not user or local settings.

### What this does not cover

The agent writes the tests, and `run_checks` runs them, so the agent can run arbitrary code on your machine. That code:
- has no credentials in its environment, and finds `gh` logged out;
- still has your user's file system and network access, so it can read files on disk, including a `.env` in the repo and `node_modules`.

The gates make sure anything it does is caught before a commit, or shows up in the PR diff. They can't stop code from reading a file and sending it over the network.

The defenses are layered, but they are not a sandbox. Run on your machine only specs you trust, with the key in an environment variable rather than in `.env`. For anything else, run the agent in a disposable container or a CI job that has only the secrets it needs.

## Prompt in Markdown, guardrails in code

The agent's instructions are in [`prompt.md`](prompt.md), a plain Markdown file with `{{writableDirs}}`, `{{specPath}}` and `{{specBody}}` placeholders. To change how the agent works, edit the prose; no TypeScript change is needed. A typo in a placeholder fails the tests instead of producing a broken prompt.

The rules that must hold no matter what the model does are in TypeScript: the permission policy, the single `run_checks` tool, the schema-validated report, the turn and budget limits, and the git and PR steps. This is the reason the agent is an [Agent SDK](https://code.claude.com/docs/en/agent-sdk) program, not just a Markdown subagent for Claude Code. A Markdown agent asks the model to stay in scope and to run only the checks. It usually needs a shell to do that, and its output is free text. This agent runs unattended, and its input is a spec that may not be trusted, so those rules are enforced in code and unit tested.

## Development

```sh
npm test -w agent
```

Tests cover:
- the spec parser;
- the permission policy;
- the secret handling;
- the pipeline gates.

They use fake git and fake agent runs, so they run offline at no cost.
