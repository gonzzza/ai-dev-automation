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
3. **Verification.** The harness doesn't take the agent's word for it. It confirms every changed file is inside `--scope`, runs `npm run check` itself, then scans the changed files and the PR body for credentials. If any gate fails, nothing is committed and the branch is kept for inspection.
4. **PR.** Commit, push and `gh pr create`. CI and the AI review run on it. A human approves and merges.

## Guardrails

The agent's tools are limited in code, so the limits don't depend on the model following its instructions:

- **No shell.** It has only `Read`, `Write`, `Edit`, `Glob` and `Grep`. To run lint, typecheck and tests it calls `run_checks`, a tool served by an in-process MCP server that runs one fixed command.
- **Permission policy** ([`src/policy.ts`](src/policy.ts)). Every tool call goes through `canUseTool`:
  - Reads are allowed only inside the repo, and never in files that may hold credentials (`.env*` other than `.env.example`, `CLAUDE.local.md`, `.npmrc`, key files).
  - Writes are allowed only inside `--scope`, and never in `node_modules` or `.git`.
  - Every other call is denied. The reason goes back to the model so it can correct course.
- **No credentials in the checks.** `run_checks` gets an environment without the API key, tokens or passwords, and `gh` is logged out.
- **Secret scan.** Before committing, the harness scans every changed file and the PR body. It blocks the commit if it finds a credential value from its environment or a known key format.
- **No git access.** The agent cannot commit, push or touch other branches. The harness does all of that after verification.
- **Budgets.** `--max-turns` and `--max-budget` stop a runaway loop. Invalid values are rejected, so a typo can't turn a cap off.
- **Reproducible context.** It loads project settings (`CLAUDE.md`) only, not user or local settings.

**What this does not cover.** `run_checks` runs the tests, and the agent writes the tests, so through them the agent can run arbitrary code on your machine:
- That code gets no credentials from the environment and finds `gh` logged out.
- It still has your user's file system and network access.

The defenses above are layered, but they are not a sandbox. For specs you don't trust, run the agent in a disposable container or a CI job that has only the secrets it needs.

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
