# Spec-driven agent

Turns a markdown spec into a pull request. It creates a branch, has Claude implement the spec with tests, independently verifies the result, then commits, pushes and opens a PR for human review. The [AI review action](../review-action) then reviews that PR like any other.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), the same agent loop and tools as Claude Code.

## Usage

```sh
# once: an API key in the environment or in an untracked .env at the repo root
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

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
spec.md ─▶ preflight ─▶ branch agent/<spec> ─▶ agent loop ─▶ scope check ─▶ npm run check ─▶ commit, push, gh pr create
           clean tree,                         read, plan,    only files      run by the       PR body: summary, plan,
           on base                             edit, test     in --scope      harness, not     testing, notes, cost
                                                                              the agent
```

1. **Preflight.** It must start on the base branch with a clean tree, so the PR contains only the agent's work.
2. **Agent loop.** Claude gets the spec, the repo's `CLAUDE.md` for conventions, and a fixed toolset. It plans, implements, writes tests and iterates until the checks pass. It returns a structured report (plan, summary, testing, notes) that becomes the PR description.
3. **Verification.** The harness doesn't take the agent's word for it. It confirms every changed file is inside `--scope`, then runs `npm run check` itself. If either gate fails, no PR is opened and the branch is kept for inspection.
4. **PR.** Commit, push and `gh pr create`. CI and the AI review run on it. A human approves and merges.

## Guardrails

The agent is sandboxed by tool design, not by trust:

- **No shell.** It has only `Read`, `Write`, `Edit`, `Glob` and `Grep`. To run lint, typecheck and tests it calls `run_checks`, a tool served by an in-process MCP server that runs one fixed command.
- **Permission policy** ([`src/policy.ts`](src/policy.ts)). Every tool call goes through `canUseTool`: reads only inside the repo, writes only inside `--scope` (never `node_modules` or `.git`), everything else denied. Denials go back to the model with the reason, so it can correct course.
- **No git access.** The agent cannot commit, push or touch other branches; the harness does that after verification.
- **Budgets.** `--max-turns` and `--max-budget` stop a runaway loop.
- **Reproducible context.** It loads project settings (`CLAUDE.md`) only, not user or local settings.

## Development

```sh
npm test -w agent
```

Tests cover the spec parser, the permission policy and the pipeline gates, with fake git and agent runs, so they are offline and free.
