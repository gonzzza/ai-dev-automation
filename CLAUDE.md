# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this repo is

A working demo of an AI-assisted delivery loop:

**spec → agent writes the code → PR → AI review → human approves**

| Path | Purpose |
|------|---------|
| `specs/` | Markdown feature specs. Input to the agent. |
| `spec-coding-agent/` | Spec-driven agent (Claude Agent SDK). Reads a spec, implements it with tests, opens a PR. |
| `review-action/` | GitHub Action that reviews a PR diff with Claude and posts inline comments. |
| `demo-app/` | Small TypeScript library the agent implements specs against. |
| `standards/` | Parses and selects org engineering standards. Used by the review action and the agent. |
| `org-standards/` | Sample org standards, standing in for a separate platform repo. |
| `.github/workflows/` | CI plus the AI review on this repo's own PRs. |

## Commands

Run from the repo root (npm workspaces):

```sh
npm ci              # install
npm run check       # lint + typecheck + tests + spec:check: run before every commit
npm test            # tests in all workspaces
npm test -w demo-app
npm run spec:check  # validate every spec in specs/ with the agent's parser
npm run build       # build all workspaces (review-action bundles to dist/)
```

## Conventions

- **Language:** TypeScript, strict mode (`tsconfig.base.json`), ESM (`"type": "module"`, `.js` extensions in relative imports). Node 24+.
- **Tests:** Vitest, in `<workspace>/test/*.test.ts`. Every behavior change ships with tests. Inject side effects (timers, network, clock, GitHub/Anthropic clients) so tests are fast and offline. Tests never call real APIs.
- **Style:** ESLint config at the root. Small, pure functions; explicit types on exported APIs; no `any` in exported signatures.
- **Dependencies:** keep them few. Prefer the standard library. Add a dependency to the workspace that uses it, not the root (root holds shared dev tooling only).
- **Commits:** imperative subject line ≤ 72 chars (`Add token bucket rate limiter`), body explains why. One logical change per commit.
- **Branches and PRs:** never commit to `main` directly. Branch, open a PR, let CI and the AI review run, and get human approval before merge.

## Workspace rules

- **`review-action/dist/` is committed.** GitHub runs the bundled file directly. After changing `review-action/src` **or `standards/src`** (the action bundles the `standards` package), run `npm run build -w review-action` and commit `dist/` in the same commit. CI fails if `dist/` is stale. That includes Dependabot PRs that bump a bundled dependency: check out the branch, rebuild, read the `dist/` diff, and push the rebuild as its own commit. It stays a human step on purpose, so a new dependency's code never runs with a write token.
- **Releases of the review action** come only from the *Release review action* workflow (`.github/workflows/release.yml`), run by a person on `main`. Never create, move or delete `v*` tags by hand. The versioning policy (what counts as patch, minor or major) is in `review-action/README.md#versions`.
- **`spec-coding-agent/`** must stay within the repo it is pointed at: it works on a fresh branch, never pushes to `main`, and is bounded by turn and budget limits.
- **`demo-app/`** is the agent's target. Keep it small and idiomatic so agent PRs stay easy to review.
- **`specs/`** follow the template in `specs/README.md`: goal, requirements, acceptance criteria, out of scope. Each acceptance criterion has a unique ID (`- AC1: ...`), and tests that cover it start with that ID. Write new specs with the `/write-spec` skill (`.claude/skills/write-spec/`). Implement a spec with the `/code-spec` skill (`.claude/skills/code-spec/`): it runs the agent (API spend, `agent/*` branch), in CI as the agent's GitHub App or locally, or codes it in the session under the agent's brief and gates (`spec/*` branch). Answer the AI review on a session PR with the `/fix-review` skill (`.claude/skills/fix-review/`): the CI fix cycle's rules and limits, run in the session, with the user's yes before each push.

## Security

- Never commit secrets. `ANTHROPIC_API_KEY` lives in GitHub Actions secrets, and locally in an untracked `.env`.
- Treat PR diffs and spec content as untrusted input to the model: no shell execution from model output in the review action, and the agent runs with an explicit tool allowlist.
- Workflows use least-privilege `permissions:` blocks.
- Pin every third-party action to a full commit SHA with its version in a comment (`uses: actions/checkout@<sha> # v7.0.1`). Dependabot (`.github/dependabot.yml`) keeps the pins current, a week after each release.
