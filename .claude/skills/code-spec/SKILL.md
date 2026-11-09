---
name: code-spec
description: Implement a spec from specs/ and open a PR, either in this session (on the subscription) or by running this repo's spec-driven agent (npm run agent, billed to the API). Resolves the spec, checks preconditions, asks who codes it, then follows the agent's own brief, scope and gates either way. Use when the user wants to work on, implement, code, build or run a spec, or run the agent on one (e.g. "work on spec 001", "implement the rate limiter spec").
argument-hint: <spec number, slug or path, e.g. "001">
effort: medium
---

# Code a spec

This repo demonstrates **spec → code → PR → AI review → human approves**. A spec can be coded two ways:

| | **This session** | **The agent** |
|---|---|---|
| Who writes the code | You, here | `npm run agent` (Claude Agent SDK) |
| Cost | The user's subscription | API spend, capped by `--max-budget` (default $5) |
| Branch | `spec/<spec-file-name>` | `agent/<spec-file-name>` |
| Gates (scope, secrets, checks) | Run by you, following step 4b | Enforced by the harness in code |
| Audit log, `Agent-Run` trailer | No | Yes |
| CI fix cycle on review findings | No (it only runs on `agent/*`). You address findings here. | Yes, automatic |

Both modes follow the same brief and rules, so the PR looks the same to a reviewer. The difference is who enforces them. The agent's docs are the source of truth for its behavior: [`agent/README.md`](../../../agent/README.md), [`agent/prompt.md`](../../../agent/prompt.md) and `npm run agent -- --help`. Check them when this file and the code disagree.

Never commit the agent's output by hand, and never push session-written code to an `agent/*` branch. The branch prefix tells reviewers who wrote the code.

The spec: $ARGUMENTS

## 1. Resolve the spec

- Match the argument against `specs/*.md` (skip `specs/README.md`): a number (`1`, `001`), a slug (`rate-limiter`), a title or a path.
- If nothing was given, or the match is ambiguous, list the specs with their titles and ask which one.
- If no spec covers what the user describes, suggest `/write-spec` and stop. Both modes need a written spec.
- Read the spec. Note which directories it touches. That decides the scope in step 3.
- Run `npm run spec:check`. If it fails for this spec, show the error and stop.

## 2. Check the preconditions

These checks only read state. Run them all, then report every problem together, each with the fix you suggest. **Don't fix anything without the user's OK.** Switching branches, stashing and deleting branches can lose work.

| Check | How | Typical fix |
|-------|-----|-------------|
| On the base branch (`<base>`, default `main`) | `git branch --show-current` | Commit or stash the current work, then `git switch <base> && git pull` |
| Base up to date | After `git fetch origin`: `git rev-list --count <base>..origin/<base>` is 0 and `git rev-list --count origin/<base>..<base>` is 0 | Behind: `git pull --ff-only`. Ahead: the local base has unpushed commits, so ask the user. Branching from a stale base makes the PR diff against old code and records the wrong `--standards-ref`. |
| Clean tree | `git status --porcelain` | Commit or stash. Untracked files count as changes. |
| Spec committed on the base | `git fetch origin` then `git cat-file -e origin/<base>:specs/<file>` | Merge the spec's PR first. A spec that exists only on a branch is lost when you switch to `<base>`. |
| Branch names are free | `git branch --list` and `git ls-remote --heads origin` for both `agent/<name>` and `spec/<name>` | Delete the branch, but only after the next check |
| No PR for those branches | `gh pr list --head <branch> --state all` | If a PR exists (open or merged), ask first. It may be the live example the README links to. To rerun: copy the spec under a new number, or close the PR (with a comment saying it is superseded) and then rename or delete its branch. **Renaming a PR's head branch closes the PR**, and it can't be reopened until the name is restored, so never rename to "keep the PR open". |
| `gh` signed in | `gh auth status` | `gh auth login` (the user runs it) |
| Agent mode only: API key available | `[ -n "$ANTHROPIC_API_KEY" ] \|\| grep -q '^ANTHROPIC_API_KEY=.' .env`. Never print the key or the contents of `.env`. | The user adds it to an untracked `.env` at the repo root |
| Agent mode only: Docker, for the sandbox | `docker info` | Start Docker Desktop, or use `--sandbox none` |

`<name>` is the spec's file name without `.md` (`specs/001-rate-limiter.md` gives `agent/001-rate-limiter` or `spec/001-rate-limiter`). A taken name only blocks the mode that uses it.

## 3. Choose who codes it, and the options

If the user already said who codes it ("do it yourself", "with the agent"), don't ask that again. Otherwise ask with AskUserQuestion, in one call:

- **Who codes it.** Options, in this order:
  - *This session (Recommended)*: covered by the subscription, no API spend. You run the gates yourself.
  - *Agent, dry run*: API spend. Implements and verifies, then leaves the changes uncommitted on `agent/<name>`.
  - *Agent, open a PR*: API spend. Implements, verifies, commits, pushes and opens the PR. Recommend this one when the user wants a PR that shows the agent working, for example as the live example.
- **Org standards.** Recommend using them: the AI review checks PRs against the same standards, so following them up front avoids a round of findings. Skip them only if the user doesn't want them.

Settle these yourself and state them:

- **Scope.** The default is `demo-app`. If the spec changes other workspaces (for example `agent/`, `standards/`, `review-action/`), include each one and point it out. The scope limits what may change in both modes.
- **Agent mode:** pass the scope as one `--scope <dir>` per directory. Leave it out only when the scope is exactly `demo-app`, the agent's default. A scope you state but don't pass makes the agent run with its default, and the run then fails the scope gate after spending money. If the base isn't `main`, pass `--base <base>`. Use `--sandbox docker` if `docker info` succeeded, otherwise `--sandbox none`. Keep the default limits (`--max-turns 60`, `--max-budget 5`, `--effort high`) unless the spec is large or a previous run hit a limit. With standards: `--standards org-standards --standards-ref <short SHA of the base>`.

## 4a. Agent mode: run it

Show the exact command and wait for a clear yes. A run spends API money, and a real run pushes a branch and opens a PR.

```sh
npm run agent -- specs/<file>.md [--scope <dir> ...] [--base <base>] [options]
```

Before showing it, check the command against step 3: every directory in the scope has a `--scope`, unless the scope is only `demo-app`.

A run takes several minutes, so start it with `run_in_background` and wait for the completion notification. Don't poll it. While it runs, **don't touch the working tree**: no edits, no branch switches, no git commands that write. The harness compares git state before and after, so any change can fail the run or end up in the PR.

Then go to step 5.

## 4b. Session mode: implement it, then run the gates yourself

You do the agent's job and the harness's job, under the same rules.

**Branch, then snapshot.** `git switch -c spec/<name>` from the up-to-date base. Then, before any other change, save the git state that gate 2 compares against to files in your scratchpad (or another temp directory outside the repo): the output of `ls -la .git/hooks` and of `git config --local --list`. Taking it after the branch exists means config written by branch creation itself (for example with `branch.autoSetupMerge`) doesn't trip the gate. The agent's harness uses the same order.

**Brief.** Follow [`agent/prompt.md`](../../../agent/prompt.md) as your brief, with the scope from step 3 as the writable directories:

1. Read `CLAUDE.md` and the existing code in scope to learn the conventions.
2. Plan the change before editing. Keep the plan: it goes in the PR body.
3. Implement it with Vitest tests that cover every acceptance criterion. Start the name of each test that covers a criterion with its ID (`it("AC3: ...", ...)`). Keep the change focused on the spec.
4. Run `npm run check` until it passes.

**Rules, the same as the agent's:**

- Only create or edit files inside the scope.
- Don't touch protected config: `package.json`, `package-lock.json`, `.npmrc`, `.gitignore`, `.gitattributes`, `tsconfig*.json`, ESLint, Vite or Vitest config, anything under `node_modules/` or `.git/`. The agent can't change these either (see `isProtectedConfig` in `agent/src/policy.ts`). If the spec truly needs one changed (for example a new dependency), stop and ask the user.
- Don't read secret files: `.env` (`.env.example` is fine), `CLAUDE.local.md`, `.npmrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`.
- If the spec is ambiguous, choose the simplest reasonable interpretation and record it for the PR's notes. Don't stop to ask unless you are blocked.
- **With standards:** read the standards in `org-standards/` marked `use: agent` (format: `org-standards/README.md`) and apply each to the files its globs match, code and tests alike. A standard wins over a conflicting spec: follow the standard and explain the conflict in the notes.

**Gates.** When `npm run check` passes, check each of these yourself. If one fails, fix it, or stop and tell the user:

1. **Scope.** Every path in `git status --porcelain` is inside the scope, and none is protected config.
2. **Git state.** No commits were made and no hooks or git config changed during the work: `git log <base>..HEAD` is empty, and running `ls -la .git/hooks` and `git config --local --list` again gives exactly what you saved in the snapshot (compare with `diff`). If there is no snapshot, say so: this gate can't pass without one.
3. **Secrets.** Search the diff, including new files, and the PR body you are about to write, for credential formats: `sk-ant-`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_`, `AKIA` followed by 16 characters, `-----BEGIN ... PRIVATE KEY-----`, and URLs with a password (`scheme://user:pass@`). There should be no hits.

**Confirm, then publish.** Show the user the summary, the plan, the files changed (`git diff --stat`) and any notes, and offer to show the full diff. Commit, push and open the PR only after a clear yes:

- **Commit:** the spec's title as the subject. The body says `Implements specs/<file>.md in a Claude Code session.`, then the summary, then the attribution trailer this session uses.
- **PR:** `gh pr create --base <base> --head spec/<name>`, with the spec's title as the PR title. Use the agent's body layout (`prBody` in `agent/src/pr.ts`) so reviewers see the same sections:

  ```markdown
  > Implemented in a Claude Code session from `specs/<file>.md`. A human reviews and merges.

  ## Summary
  ## Plan            (numbered steps)
  ## Testing         (what the tests cover, by AC ID; then: `npm run check` passed locally. CI verifies again on a clean checkout.)
  ## Notes for the reviewer   (only if there are any)
  ## Standards       (only with standards: the ids applied, and the base SHA)
  ## Files changed   (one `- \`path\`` per file)
  ```

  End the body with the PR attribution line this session uses.

## 5. Report

Give the user:

- **The result:** PR opened, dry run finished, or failed, and at which step.
- **Agent mode:** the run id (for example `20261109T073012Z-3f9a1c`), the audit log path (`<log dir>/<run id>.jsonl`), and the cost and turns, if printed.
- **On a PR:** the URL. The AI review runs in CI on every PR. In agent mode, the fix cycle may then push commits that address its findings. In session mode it doesn't, so offer to handle the findings here under the same rules: check each one against the code, fix the real ones with a test, decline the wrong ones with a reason, and reply on each finding's thread. Don't merge. Merging is the human's job.
- **On an agent dry run:** the branch and the changed files (`git status`, `git diff --stat`). Offer to show the diff. To open a PR next, the dry-run changes have to go and the branch must be deleted. Offer to do that, with confirmation, before a real run: switch back to the base, discard the changes, delete the branch. A real run starts fresh and costs a second run.
- **On an agent failure:** the error, and that the branch is kept for inspection. Suggest the likely fix: a clearer spec (offer `/write-spec` to revise it), a higher limit, or a wider scope. Don't patch the agent's code yourself to make it pass. If the user wants it done anyway, offer session mode on a fresh `spec/<name>` branch.
