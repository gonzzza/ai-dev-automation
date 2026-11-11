---
depends_on: [4]
---

# Run independent specs in parallel, in dependency order

## Goal
Today a person picks each spec and starts the agent on it by hand, one at a time, and has to remember which specs build on which. This change lets a spec declare the specs it depends on, and adds a coordinator that works out which specs are ready and dispatches one CI agent run for each, in parallel. The agents never talk to each other: GitHub (branches, pull requests and workflow runs) is the only shared state, and every exception goes to a human instead of being retried.

## Requirements

### `depends_on` in specs
- A spec may start with a frontmatter block: a `---` line, `key: value` lines, then a closing `---` line. The only key is `depends_on`, whose value is an inline list of spec numbers: `depends_on: [1, 3]`. Numbers are positive decimal integers, and leading zeros are allowed (`003` is `3`). `[]` is allowed. A spec without frontmatter depends on nothing.
- `Spec` (in `spec-coding-agent/src/spec.ts`) gains `dependsOn: number[]`, in the order written. `parseSpec` blanks the frontmatter lines before reading the title, sections and criteria, the same way it blanks code blocks, and keeps them in `body`.
- `parseSpec` throws an `Error` naming the spec path for: an unclosed block, a key other than `depends_on`, a duplicate key, a value that isn't an inline list, an item that isn't a positive integer, and a number listed twice. It handles a block list (`- 1` lines) the same way. This is a separate, smaller parser from the one in `standards`. Don't change `standards/src`, which would mean rebuilding `review-action/dist`.
- `checkSpecs` also reports, as one error string each:
  - a dependency on a number no spec has;
  - a spec that depends on itself;
  - each dependency cycle, once, naming its specs in order from its lowest number, padded to three digits, e.g. `dependency cycle: 005 → 006 → 005`.

  `npm run spec:check` therefore rejects all three, and the specs already in `specs/` still pass.

### The plan
- New module `spec-coding-agent/src/coordinate.ts`. `planSpecs(specs, github)` is pure and returns `PlannedSpec[]` sorted by spec number:

  ```ts
  export interface PullSummary { number: number; title: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null }
  export interface GithubState { pulls: readonly PullSummary[]; branches: readonly string[] }
  export type SpecState =
    | { status: "done"; pr: number }
    | { status: "in-progress"; pr?: number; branch?: string }
    | { status: "needs-human"; reason: "closed" | "reverted"; pr: number }
    | { status: "blocked"; waitingOn: number[] }
    | { status: "ready" };
  export interface PlannedSpec { number: number; path: string; slug: string; state: SpecState }
  export function planSpecs(specs: readonly Spec[], github: GithubState): PlannedSpec[];
  ```

- A PR belongs to spec `n` when its title matches `^SPEC-0*n ` (the agent's and session mode's title format), compared as numbers. A PR reverts spec `n` when its title starts with `Revert "SPEC-0*n ` (GitHub's revert button). `branches` holds remote branch names without `refs/heads/`. The first rule that applies decides each spec's state:
  1. Any open PR of the spec: `in-progress` with the lowest such PR number.
  2. A merged PR of the spec exists. If a merged revert PR has a later `mergedAt` than the latest merged PR, the state is `needs-human` / `reverted` with the revert PR's number. Otherwise it is `done` with the latest merged PR's number.
  3. `agent/<slug>` or `spec/<slug>` is among `branches`: `in-progress` with that branch. The branch is the claim: the agent already refuses to start when its branch exists.
  4. A closed, unmerged PR of the spec: `needs-human` / `closed` with the highest such PR number.
  5. Every dependency is `done`: `ready`. Otherwise `blocked`, with the dependencies that aren't `done` in ascending order.
- The coordinator never retries on its own. A person re-arms a `needs-human` spec by running *Implement a spec* by hand, or by fixing what made it fail.

### Reading GitHub and dispatching
- `runCoordinator(deps)` takes the parsed specs, an injected `Exec`, the repo root, `dispatch: boolean`, `maxParallel: number`, a `log(line)` function and an optional `RunLog`. It returns `{ plan: PlannedSpec[]; dispatched: string[]; inFlightRuns: number }`. It reads GitHub with exactly these commands, run in the repo root:
  - `gh pr list --state all --base main --search "SPEC- in:title" --limit 1000 --json number,title,state,mergedAt`. If it returns 1000 PRs, it throws, because the plan could be incomplete.
  - `git ls-remote --heads origin refs/heads/agent/* refs/heads/spec/*`.
  - `gh run list --workflow implement-spec.yml --limit 100 --json status`. A run is in flight when its `status` isn't `completed`.

  Any of them exiting non-zero throws, with the command's output, before anything is dispatched.
- It logs one line per spec, in number order: the number, the status and the detail (`done (#33)`, `in-progress (agent/001-rate-limiter)`, `blocked: waiting on 005`, `needs-human: reverted (#41)`).
- With `dispatch: false` (the default), it dispatches nothing.
- With `dispatch: true`, it first checks the local checkout. It throws, naming the problem, unless `git rev-parse HEAD` equals `git rev-parse origin/main` and nothing under `specs/` has uncommitted changes. The workflow implements the spec as it is on `main`, so the local plan must match it.
- With `dispatch: true` and in-flight runs, it dispatches nothing and logs how many runs it is waiting on. It dispatches one wave at a time: a run's branch only appears when it pushes, so a pass during a run can't tell which spec that run claimed.
- Otherwise it dispatches up to `maxParallel` `ready` specs, lowest number first, each with `gh workflow run implement-spec.yml --ref main -f spec=<repo-relative spec path>`. A failed dispatch throws and stops the rest. The ones already dispatched are in the error message.
- With a `RunLog`, it logs one `plan.result` event with the plan, and one `dispatch` event per dispatched spec path.

### CLI
- New mode: `npm run agent -- --plan [--dispatch] [--max-parallel <n>]`, listed in `USAGE`.
  - It reads every spec in `specs/` except `README.md`, runs `checkSpecs` and stops with the errors if there are any, then calls `runCoordinator`.
  - `--max-parallel` defaults to `2` and is validated with `parseLimit(…, { integer: true })`.
  - It doesn't need `ANTHROPIC_API_KEY`, since no agent runs in this process. Each dispatched run has its own turn and budget limits (the defaults), so one wave spends at most `maxParallel` times `--max-budget`.
  - `--plan` with a spec path, `--fix-pr`, `--dry-run` or `--base` is a usage error.
  - `--dispatch` or `--max-parallel` without `--plan` is a usage error.
- `GH_TOKEN` (or `gh`'s login) needs `actions: write` to dispatch. Planning only needs read access.

## Acceptance criteria
- AC1: `parseSpec` returns `dependsOn: []` for a spec without frontmatter and for `depends_on: []`, and `[1, 3]` for `depends_on: [001, 3]`. The title, sections and criteria parse the same with or without a frontmatter block. It throws, naming the path, for an unclosed block, an unknown key, a duplicate key, a block list, `0`, `-1`, `1.5`, `abc` and a number listed twice.
- AC2: `checkSpecs` reports a dependency on a missing number, a self-dependency and a three-spec cycle, the last as `dependency cycle: 005 → 006 → 007 → 005` (starting from its lowest number). Valid dependency graphs give no errors, and `npm run spec:check` passes on the specs in `specs/`.
- AC3: `planSpecs` applies rules 1–4 in order:
  - an open PR wins over a merged one;
  - a merged PR gives `done`;
  - a later merged `Revert "SPEC-…` PR gives `needs-human` / `reverted`;
  - a revert merged before the latest merge still gives `done`;
  - an `agent/<slug>` or `spec/<slug>` branch without a PR gives `in-progress`;
  - a closed, unmerged PR gives `needs-human` / `closed`.

  `SPEC-004` and `SPEC-4` both match spec 4, and `SPEC-0040` and `XSPEC-004` don't.
- AC4: `planSpecs` marks a spec `ready` only when all its dependencies are `done`. Otherwise it is `blocked`, with the unfinished dependencies in ascending order, including ones that are `needs-human`, `in-progress` or `blocked`. The result is sorted by spec number.
- AC5: With a fake `Exec`, `runCoordinator` runs exactly the three read commands above and builds `GithubState` from their output. It throws when any of them fails, and when `gh pr list` returns 1000 PRs. With `dispatch: false` it never calls `gh workflow run`.
- AC6: With `dispatch: true`:
  - it dispatches the `ready` specs lowest number first, at most `maxParallel` of them, with the exact `gh workflow run` arguments above;
  - it dispatches nothing while any `implement-spec.yml` run is in flight;
  - it throws before dispatching when `HEAD` isn't `origin/main` or a file under `specs/` has uncommitted changes;
  - when the second of three dispatches fails, it throws with the first spec's path in the message and doesn't attempt the third.
- AC7: With an in-memory `RunLog`, `runCoordinator` logs one `plan.result` event and one `dispatch` event per dispatched spec, and the per-spec lines it passes to `log` match the formats above.
- AC8: `spec-coding-agent/README.md` documents the `--plan` mode, its options and the rules for each state, including that reverts and closed PRs go to a human and are never retried. `specs/README.md` shows the optional `depends_on` frontmatter in the template and its rules. Tests use fakes only: no network, no `gh`, no git remote.

## Out of scope
- Running agents locally in parallel, one git worktree per spec. That is spec 006, which reuses `planSpecs`.
- A workflow that runs `--plan --dispatch` on every merge to `main`. A human adds it after this PR, since the agent can't write under `.github/`.
- Changes to `implement-spec.yml`, such as a `run-name` naming the spec or budget inputs.
- Claim stores other than GitHub (Postgres, leases, lease expiry).
- Retrying failed or closed runs, and re-implementing reverted specs automatically.
- Detecting reverts whose title isn't GitHub's `Revert "SPEC-…` format, and partial reverts.
- Passing one spec's output to another's prompt, or any agent-to-agent messaging.
- Changes to how the agent implements a single spec. `depends_on` only affects the plan.
