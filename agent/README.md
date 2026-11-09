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
| `--log-dir <dir>` | `<tmp>/spec-agent-runs` | Where the run's [audit log](#audit-log-and-monitoring) goes. |
| `--sandbox <kind>` | `none` | Where agent-written tests run: `none` (this machine, with a credential-free environment) or `docker` (an isolated container; see [the sandbox](#the-checks-sandbox)). CI uses `docker`. |
| `--sandbox-image <image>` | `node:24-bookworm` | Image for `--sandbox docker`. Keep it on the Node version in `.nvmrc`. |
| `--standards <dir>` | none | [Org standards](#org-standards) directory. Absent means no standards. |
| `--standards-packs <list>` | all | Comma-separated packs to load from `--standards`. |
| `--standards-ref <label>` | none | Version label of the standards (a tag or SHA), for the audit log and the PR body. |
| `--max-standards-chars <n>` | `40000` | Size budget for the standards. The least severe ones that don't fit are dropped and listed. |

## How it works

```
spec.md ─▶ preflight ─▶ branch agent/<spec> ─▶ agent loop ─▶ npm run check ─▶ gates ─────────────▶ commit, push, gh pr create
           clean tree,                         read, plan,    run again by     .git untouched,       PR body: summary, plan,
           on base                             edit, test     the harness      scope, no secrets     testing, notes, cost
```

1. **Preflight.** It must start on the base branch with a clean tree, so the PR contains only the agent's work. The branch must not exist locally or on `origin`.
2. **Agent loop.** Claude gets the spec, the repo's `CLAUDE.md` for conventions, and a fixed toolset. It plans, implements, writes tests and iterates until the checks pass. It returns a structured report (plan, summary, testing, notes) that becomes the PR description.
3. **Verification.** The harness doesn't take the agent's word for it:
   1. It runs `npm run check` itself. This is a fast local filter. Code that ran during the session could still tamper with gitignored files such as `node_modules`. The authoritative check is CI on the PR, which starts from a clean checkout and a fresh `npm ci`.
   2. It confirms that the branch, `HEAD`, git config and hooks are unchanged.
   3. It confirms that every changed file is inside `--scope` and none is a protected config file.
   4. It scans the changed files and the PR body for credentials.

   If any of these fails, nothing is committed and the branch is kept for inspection.
4. **PR.** Commit, push and `gh pr create`. CI and the AI review run on it. A human approves and merges.

## Org standards

The [AI review](../review-action) checks PRs against the org engineering standards (see [`standards/`](../standards) and spec 002). With `--standards <dir>`, the agent gets the same standards up front, in spec runs and fix runs, so the code it writes already follows the rules the review enforces instead of spending a fix cycle on them.

```sh
npm run agent -- specs/004-x.md --standards ../org-standards --standards-packs typescript,testing --standards-ref v1.2.0
```

- **Which standards.** Every standard marked `use: agent` in the selected packs, most severe first. `applies_to` isn't used to filter, since the agent can't know up front which files it will create; each standard is shown with its globs (or `all files`) and the agent applies it to the files they match, code and tests alike. If the standards are over `--max-standards-chars`, the least severe ones are dropped.
- **Trusted operator input, in the system prompt.** The standards come from whoever runs the agent, not from the spec or the PR, so they are appended to the system prompt. The spec body and the review findings stay in the user prompt as untrusted input.
- **They win over a conflicting spec or finding.** The agent is told to follow the standard and explain the conflict in its `notes`, which end up in the PR body or the fix-cycle comment for the human.
- **Recorded.** The CLI prints the ids it loaded and any it dropped. The audit log gets a `standards.loaded` event with the path, ref, packs, and the checked and dropped ids. The PR body gets a `## Standards` section with the same ids and the ref.
- A missing directory, an unknown pack or an invalid standard file stops the run before any git or agent work.
- The review stays the check: the agent is not verified against the standards by the harness.

## Fix cycle

After the AI review runs on an agent PR, the agent can address the findings itself, up to a limit, before a human looks. In this repo the [AI review workflow](../.github/workflows/ai-review.yml) runs this automatically; you can also run it by hand:

```sh
git switch agent/001-rate-limiter && git pull
npm run agent -- --fix-pr 5 --findings findings.json   # findings.json: the review's findings-json output
```

```
AI review ─▶ any finding ≥ medium? ──no──▶ done: the human reviews, low findings included
                    │ yes
                    ▼
             cycle limit, or a finding raised again? ──yes──▶ stop: comment "handing over to a human"
                    │ no
                    ▼
             agent fixes or declines each finding ─▶ same gates as a new PR ─▶ commit, push, comment,
                    │                                                     reply on each finding's thread
                    │
                    └──▶ the push triggers the AI review again
```

- **Only real findings get fixed.** Findings below `--min-severity` (default `medium`) are left for the human and listed in the comment. The agent checks each remaining finding against the code. It fixes the real ones with a test and declines the wrong ones with a reason, since the reviewer is a model too.
- **Deferred findings are context, not ignored.** The agent sees the lower-severity findings too, with instructions not to fix them and not to write code or tests that lock in what they describe. Without that, the first real run on [PR #5](https://github.com/gonzzza/ai-dev-automation/pull/5) added a test that treated a low-rated bug as intended behavior.
- **Bounded.** The cycle stops after `--max-cycles` fix commits (default 5). It also stops as soon as the review raises a finding that an earlier cycle already worked on, matched by file, category and a line within 25 of the original. That means the fixer and the reviewer disagree, and a human should settle it rather than let them trade the issue back and forth. New findings alone keep the cycle going. The match is a heuristic that can err both ways. A genuinely new finding close to a fixed one stops the cycle early, which costs a human look. A fix that moves code far enough can hide a real repeat, and the cycle cap bounds that. Each stop posts a comment that hands the PR to a human.
- **Each finding gets an answer on its own thread.** The review action's `findings-json` carries the id of each inline comment. After the push, the agent replies on that thread: `Fixed in <commit>` with what it changed, and resolves the thread, or `Declined` with its reason, leaving the thread open for the human. Findings that only appear in the review summary have no thread and are covered by the cycle's summary comment. Replies are best-effort: a failed one is logged, and the summary comment still lists every outcome. Threads with replies aren't collapsed when the next review supersedes the old one.
- **State lives on the PR branch.** Each fix commit carries an `Agent-Fix-Cycle` trailer and one `Agent-Fix-Addressed` trailer per finding it worked on. The next run reads them back. No database or run-to-run memory is involved, and the history is visible in `git log`.
- **Severity is approximate.** The reviewer is a model, and it can rate the same issue differently from one run to the next. On PR #5 the clock bug was rated medium, then low, then medium again. The threshold decides which findings get an automated attempt; it doesn't decide what is safe to merge. The human approval does that, with every finding still on the PR. Keeping ratings stable, for example by giving the reviewer its previous findings, is a possible next step.
- **Same guardrails.** Fix mode only touches open `agent/*` PRs from this repository, and in CI only those the agent's App opened. It refuses to run if the branch moved since the reviewed commit (`--reviewed-sha`). It has the same tools, permission policy, scope and secret gates, and harness re-check as a new PR, and the findings are escaped and treated as untrusted input like a spec. The prompt is [`fix-prompt.md`](fix-prompt.md).
- **It never merges.** The last step is always a human approval.

**Setup in CI.** The fix job acts as the agent's GitHub App (see [the README](../README.md#run-the-loop-in-ci-as-a-bot)): `AGENT_APP_CLIENT_ID` and `AGENT_APP_PRIVATE_KEY` mint a one-hour token for this repository, and the App's bot authors the push, the comment and the thread replies. The workflow's own `GITHUB_TOKEN` wouldn't do: a push made with it doesn't trigger workflows, so the fix would never be reviewed.

**Only the App's own PRs.** An `agent/*` branch name isn't proof: anyone with push access can create one. The fix job therefore checks that the App's bot opened the PR, and the harness checks again with `--agent-app <slug>` before it touches anything. It compares `gh`'s author against `app/<slug>` with the bot flag set, so a person who registers the App's name as a username doesn't pass.

## Audit log and monitoring

Every run writes an audit log, and every change it makes can be traced back to that log.

**Traceability.** Each run gets an id such as `20261109T073012Z-3f9a1c`, printed at the start. The id appears in:
- the commit, as an `Agent-Run` trailer;
- the PR body footer and the fix-cycle comments, which in CI also link to the Actions run that holds the log;
- the log's file name.

From any line on `main`, `git log` leads to the run that wrote it, and from there to its transcript.

**The log** is `<run id>.jsonl` in `--log-dir` (default: a `spec-agent-runs` folder in the system temp directory), one JSON object per line:

| Event | Contains |
|-------|----------|
| `run.start` | Mode, command-line arguments, Node version, and the CI run link when in Actions. Written first, before anything can fail. |
| `run.config` | The commit it started from, model, effort, writable directories, turn and budget limits |
| `standards.loaded` | With `--standards`: the directory, ref, packs, and the ids given to the agent (`checked`) and dropped for size |
| `spec.input` / `fix.input` | The spec (path, base branch, body), or the PR number, reviewed commit, threshold, cycle limit and findings |
| `agent.start` | The full prompt sent to the model |
| `sdk.message` | Every message of the session: the model's turns, tool calls and tool results. This is the transcript. |
| `policy.decision` | Every tool call the permission policy saw, allowed or denied, with the reason for each denial |
| `checks.result` | The harness's own re-run of `npm run check` |
| `agent.end` | The SDK's result: outcome, cost, turns, duration |
| `log` | The progress lines printed to the console |
| `run.end` | Always written, even on failure. `ok`, duration and the outcome, or the error and a `category`: `config`, `bad-input`, `preflight`, `agent-stopped`, `bad-report`, `checks-failed`, `git-state-changed`, `out-of-scope`, `secret-found` or `no-changes` |

- **Redaction.** Every line is redacted before it's written: credential values from the environment, and anything matching a known key format, become `[REDACTED]`.
- **Location.** The log lives outside the repository, so the agent's own tools can't reach it. It's created owner-only (`0700` directory, `0600` file).
- **It is a record, not tamper-proof evidence.** Tests the agent writes run as the same OS user as the harness, so test code could find the log and edit or truncate it, including the denials it records. With `--sandbox docker`, as in CI, the tests run in a container that can't see the log, which closes that gap. Without it, the log is a record and not tamper-proof evidence. For an audit trail that must hold up even then, send events to an external store as they happen; the OpenTelemetry export below does that for Claude Code's own events.
- **Crash safety.** Lines are appended as they happen, so a crashed run still leaves everything up to the crash.
- **In CI**, the fix job uploads the log as an artifact (`agent-run-<run id>-<attempt>`, kept for 30 days) even when the run fails.

**Metrics** come straight from the log. For example, cost and outcome per run, and the most common failure categories:

```sh
jq -c 'select(.type == "run.end") | {runId, ok, category, costUsd, turns, durationMs}' runs/*.jsonl
jq -r 'select(.type == "run.end" and .ok == false) | .category' runs/*.jsonl | sort | uniq -c
jq -c 'select(.type == "policy.decision" and .behavior == "deny") | {runId, tool, reason}' runs/*.jsonl  # worth an alert
```

In a team setup, ship these files to the log platform you already use (Datadog, CloudWatch, Loki) and build the dashboard from `run.end` and `policy.decision`. Alert on denials, failure spikes and cost.

**OpenTelemetry.** The agent runs Claude Code underneath, which can export [OpenTelemetry metrics and events](https://code.claude.com/docs/en/monitoring-usage). Examples are `claude_code.cost.usage`, `claude_code.token.usage`, `claude_code.api_request` and `claude_code.tool_result`. The agent passes its environment to the session, so setting the variables enables it:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4317
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
```

Claude Code's docs list `sdk-ts` as a session entrypoint, which suggests Agent SDK sessions are instrumented. They don't state it outright, though, so confirm that data reaches your collector before you depend on it. Prompt and tool contents stay out of the telemetry unless you opt in, and the run log above already covers them. The variables don't reach `run_checks`, whose environment is an allowlist, so agent-written tests never see the collector's credentials.

**Cost figures are estimates.** They are the SDK's numbers, computed from token usage at list prices. For billing, use the Anthropic Console or usage API.

## Guardrails

The agent's tools are limited in code, so the limits don't depend on the model following its instructions:

- **No shell.** It has only `Read`, `Write`, `Edit`, `Glob` and `Grep`. To run lint, typecheck and tests it calls `run_checks`, a tool served by an in-process MCP server that runs one fixed command.
- **Permission policy** ([`src/policy.ts`](src/policy.ts)). It runs as a `PreToolUse` hook, which sees every tool call. (`canUseTool` alone isn't enough, because Claude Code can approve reads inside the working directory without calling it.) The rules:
  - Reads are allowed only inside the repo. Symlinks are resolved first, and paths starting with `~` or containing `$` are denied, since the tools would expand them.
  - No path may name a file that can hold credentials: `.env*` other than `.env.example`, `CLAUDE.local.md`, `.npmrc`, key files. A Grep glob is matched against those names with ripgrep's wildcard rules, so `.e*` or `*` are denied too. A Grep across a whole directory with no glob relies on ripgrep skipping gitignored files, and the secret scan below is the backstop for that case.
  - Writes are allowed only inside `--scope`, and never in `node_modules`, `.git`, or the files that define how the checks run (`package.json`, `tsconfig*.json`, Vitest and ESLint config). Changes to those files can't reach the PR, so the PR's CI runs the project's real checks. Nor in `.github/`, even when `--scope` covers it: the workflows there run the agent and hold its credentials.
  - The SDK's `StructuredOutput` tool is allowed, since it only returns the final report, which the harness validates against the schema.
  - Every other call is denied. The reason goes back to the model so it can correct course.
- **A sandbox for the checks** (`--sandbox docker`, used in CI). Agent-written code runs only in a throwaway container. See [the checks sandbox](#the-checks-sandbox).
- **A minimal environment for the checks.** `run_checks` gets only an allowlist of variables that npm, Node and the OS need, such as `PATH`, `HOME` and `TEMP`. The API key, tokens and anything like `DATABASE_URL` are left out, and `gh` is logged out. Git there ignores your global and system config, credential helpers and SSH, so test code can't push with your credentials. From `.env`, the CLI reads only `ANTHROPIC_API_KEY`, never the rest of the file.
- **Safer git after the run.** Every harness git command runs with hooks and fsmonitor disabled. The harness also refuses to continue if the checked-out branch or commit, the repo's git config (worktrees included) or its hooks changed during the run. That check also covers `.git/info/exclude` and index entries marked assume-unchanged or skip-worktree. A commit, an ignore rule or an index flag set by test code would otherwise hide files from the scope gate. `.gitattributes` and `.gitignore` are protected for the same reason. This closes the in-repo ways planted code could run during the commit and push. The config is compared as git parses it, ignoring only `branch.<name>.vscode-merge-base`, which VS Code's Git extension writes when it notices the new branch. Every other key, and any change git can't parse, still fails the run.
- **No symlinks.** A changed file that is a symlink fails the run. Git would commit the link's target path, which the secret scan doesn't read, and the link could point outside the repo.
- **Secret scan.** Before committing, the harness scans every changed file and the PR body. It blocks the commit if it finds a credential value from its environment or a known key format.
- **No git access.** The agent cannot commit, push or touch other branches. The harness does all of that after verification.
- **Budgets.** `--max-turns` and `--max-budget` stop a runaway loop. Invalid values are rejected, so a typo can't turn a cap off.
- **Reproducible context.** It loads project settings (`CLAUDE.md`) only, not user or local settings.

### What this does not cover

The agent writes the tests, and `run_checks` runs them, so the agent can run arbitrary code on your machine. That code:
- runs with a minimal environment that holds no credentials, finds `gh` logged out, and can't use git with your credentials;
- still has your user's file system and network access, so it can read files on disk, including a `.env` in the repo and `node_modules`.

The gates catch changes to the repo before anything is committed, and anything else the agent changes in the repo shows up in the PR diff. Outside the repo, they can't stop that code from:
- reading a file and sending it over the network;
- changing your user-level configuration, such as `~/.gitconfig`, gh's config or your shell profile, which later commands, the harness's own included, would pick up.

Protecting all of that is a job for an operating-system boundary, not for checks inside the process.

**`--sandbox docker` is that boundary for the checks.** Use it wherever secrets live; the fix cycle in CI does. Without it, the defenses above are layered but not a sandbox. Run on your machine only specs you trust, with the key in an environment variable rather than in `.env`.

### The checks sandbox

With `--sandbox docker`, `run_checks` and the harness's own re-check run `npm run check` in a throwaway container, so code the model wrote never runs where the secrets are:

```
runner: ANTHROPIC_API_KEY, the agent App's token, the agent, the audit log
  └─ run_checks ─▶ docker run --network=none, repo mounted, .git and node_modules read-only, no secrets
                     └─ npm run check   ← agent-written tests run here
```

| Inside the container | |
|---|---|
| Network | None (`--network=none`). Test code can't send anything anywhere or download anything. |
| Environment | Only `HOME`, `CI` and npm settings, set by the harness. Nothing from the harness process, so no API key or token. |
| Files | The repo only. `.git` is read-only, so test code can't plant hooks or config. `node_modules` is read-only too, and it is the container's own copy, not the host's. The audit log and everything else on the host are out of reach. |
| Privileges | No Linux capabilities, no privilege escalation, at most 512 processes and 4 GB of memory, and the host's uid/gid so created files aren't root's. |

**Dependencies.** The container can't reuse the host's `node_modules`. Packages such as rolldown and esbuild ship a native binary per OS, so a Windows or macOS install fails in the Linux container. Before the agent starts, the harness therefore runs `npm ci` from the committed lockfile in a container of its own. That container has network access to download packages, but no secrets, and the repo is read-only. It writes into a Docker volume named after the lockfile and image (`ai-dev-automation-deps-<hash>`). The checks mount that volume read-only. The install happens once per lockfile; later runs reuse the volume in about a second. Old volumes can be removed with `docker volume prune --filter label=ai-dev-automation.deps`.

If Docker isn't available, or the install fails, `--sandbox docker` stops before the agent runs instead of falling back to running the tests unsandboxed. It works on Linux, macOS and Windows hosts, wherever Docker runs Linux containers.

What it doesn't cover:

- **The repo's own files are writable.** They have to be, for the tests to run. Changes to tracked files show up in the diff and go through the gates. Untracked, gitignored files, such as the workspaces' `.vite` caches, are not committed.
- **Dependencies must all be in the root `node_modules`.** npm sometimes nests packages in a workspace's own `node_modules` when versions conflict. The sandbox replaces only the root folder, so in that case the install stops with a message naming the folders, rather than letting the tests use the host's copies.
- **No project `.npmrc`.** The install step uses the public npm registry with no credentials, so a project that needs a private registry or other npm settings fails at the install step, before the agent starts.
- **The install step has network access.** It runs before any agent-written code exists, with only the lockfile and `package.json` files, and installs exactly what the lockfile pins. That's the same trust as CI's own `npm ci`.
- **The agent process still holds the API key and, in CI, the push token**, because it calls the API and pushes. Moving the push into a separate job that only holds the token would keep the token out of the agent's job entirely.

## Prompt in Markdown, guardrails in code

The agent's instructions are in [`prompt.md`](prompt.md) and, for the fix cycle, [`fix-prompt.md`](fix-prompt.md). Both are plain Markdown with `{{placeholders}}` such as `{{specBody}}`. To change how the agent works, edit the prose; no TypeScript change is needed. A typo in a placeholder fails the tests instead of producing a broken prompt.

The rules that must hold no matter what the model does are in TypeScript: the permission policy, the single `run_checks` tool, the schema-validated report, the turn and budget limits, and the git and PR steps. This is the reason the agent is an [Agent SDK](https://code.claude.com/docs/en/agent-sdk) program, not just a Markdown subagent for Claude Code. A Markdown agent asks the model to stay in scope and to run only the checks. It usually needs a shell to do that, and its output is free text. This agent runs unattended, and its input is a spec that may not be trusted, so those rules are enforced in code and unit tested.

## Development

```sh
npm test -w agent
```

Tests cover:
- the spec parser;
- the permission policy;
- the secret handling;
- the pipeline gates;
- the org standards: loading from fixtures, the system prompt they produce, and the PR body section;
- the fix cycle: findings parsing, the cycle limit and progress rules, and its gates;
- the audit log: redaction, run ids and trailers, and failure categories checked against the errors the real gates throw.

They use fake git and fake agent runs, so they run offline at no cost.
