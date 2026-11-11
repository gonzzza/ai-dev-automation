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
  export interface RunSummary { id: number; title: string; status: string; conclusion: string | null; createdAt: string }
  export interface GithubState { pulls: readonly PullSummary[]; branches: readonly string[]; runs: readonly RunSummary[] }
  export type SpecState =
    | { status: "done"; pr: number }
    | { status: "in-progress"; pr?: number; branch?: string; run?: true }
    | { status: "needs-human"; reason: "closed" | "reverted"; pr: number }
    | { status: "needs-human"; reason: "failed"; conclusion: string }
    | { status: "blocked"; waitingOn: number[] }
    | { status: "ready" };
  export interface PlannedSpec { number: number; path: string; slug: string; state: SpecState }
  export function planSpecs(specs: readonly Spec[], github: GithubState): PlannedSpec[];
  ```

- A PR belongs to spec `n` when its title matches `^SPEC-0*n ` (the agent's and session mode's title format), compared as numbers. A PR reverts spec `n` when its title starts with `Revert "SPEC-0*n ` (GitHub's revert button). `branches` holds remote branch names without `refs/heads/`.
- A run belongs to a spec when its title is exactly `Implement <spec path>`. `implement-spec.yml` sets this with `run-name: Implement ${{ inputs.spec }}${{ inputs.dry-run && ' (dry run)' || '' }}`, added together with this spec. Dry runs, and runs from before that change (titled `Implement a spec`), belong to no spec. A run is in flight when its `status` isn't `completed`.
- The first rule that applies decides each spec's state:
  1. Any open PR of the spec: `in-progress` with the lowest such PR number.
  2. A merged PR of the spec exists. If a merged revert PR has a later `mergedAt` than the latest merged PR, the state is `needs-human` / `reverted` with the revert PR's number. Otherwise it is `done` with the latest merged PR's number.
  3. An in-flight run of the spec: `in-progress` with `run: true`.
  4. A closed, unmerged PR of the spec: `needs-human` / `closed` with the highest such PR number. This comes before the branch rule, because GitHub keeps a branch when its PR is closed without merging.
  5. `agent/<slug>` or `spec/<slug>` is among `branches`: `in-progress` with that branch. The branch is the claim: the agent already refuses to start when its branch exists.
  6. The spec's most recent completed run (by `createdAt`) has a `conclusion` other than `success`: `needs-human` / `failed` with that conclusion. A run that fails before pushing leaves no branch and no PR, so without this rule the spec would look `ready` and be dispatched again.
  7. Every dependency is `done`: `ready`. Otherwise `blocked`, with the dependencies that aren't `done` in ascending order.
- The coordinator never retries on its own. Fixing the cause of a failure doesn't change a spec's state by itself. A person re-arms a `needs-human` spec by fixing the cause, then running *Implement a spec* by hand: that run moves the spec to `in-progress`, and the PR it opens takes over from there.
- The run history the coordinator reads is the last 200 runs. A failure older than that is no longer seen, so a spec can get at most one more automatic attempt after its failure falls out of that window.

### Reading GitHub and dispatching
- `runCoordinator(deps)` takes the parsed specs, an injected `Exec`, the repo root, `dispatch: boolean`, `maxParallel: number`, a `log(line)` function, an injected `sleep(ms): Promise<void>` and an optional `RunLog`. It returns `{ plan: PlannedSpec[]; dispatched: string[]; inFlightRuns: number }`. It reads GitHub with exactly these commands, run in the repo root:
  - `gh api --paginate "repos/{owner}/{repo}/pulls?state=all&base=main&per_page=100" --jq ".[] | {number, title, state, merged_at}"`: one JSON object per line, for every PR against `main`. A PR is `MERGED` when `merged_at` is set, `OPEN` when `state` is `open`, and `CLOSED` otherwise. Matching is done on the titles in code, so there is no search tokenizing and no result cap. It costs one request per 100 PRs.
  - `git ls-remote --heads origin refs/heads/agent/* refs/heads/spec/*`.
  - `gh run list --workflow implement-spec.yml --limit 200 --json databaseId,displayTitle,status,conclusion,createdAt`, read into `RunSummary` with `id` from `databaseId` and `title` from `displayTitle`.

  Any of them exiting non-zero throws, with the command's output, before anything is dispatched.
- It logs one line per spec, in number order: the number, the status and the detail (`done (#33)`, `in-progress (agent/001-rate-limiter)`, `in-progress (run)`, `blocked: waiting on 005`, `needs-human: reverted (#41)`, `needs-human: failed (failure)`).
- With `dispatch: false` (the default), it dispatches nothing.
- With `dispatch: true`, it first checks the local checkout. It runs `git fetch origin main`, then throws, naming the problem, unless `git rev-parse HEAD` equals `git rev-parse origin/main` and nothing under `specs/` has uncommitted changes. The workflow implements the spec as it is on `main`, so the local plan must match it, and the fetch keeps a stale `origin/main` from passing the check.
- With `dispatch: true` and any run of `implement-spec.yml` in flight, including dry runs and untitled ones, it dispatches nothing and logs how many runs it is waiting on. Dispatching one wave at a time keeps the spend of a wave bounded and the plan simple.
- Otherwise it dispatches up to `maxParallel` `ready` specs, lowest number first, each with `gh workflow run implement-spec.yml --ref main -f spec=<repo-relative spec path>`. A failed dispatch throws and stops the rest. The ones already dispatched are in the error message.
- `gh workflow run` returns before GitHub lists the new run. So after dispatching, it re-runs the `gh run list` command every 5 seconds, through `sleep`, until each dispatched spec has a run titled `Implement <spec path>` whose `id` wasn't in the list read before dispatching. That run counts whether it is in flight or already completed, since a run that fails in its first step can finish between two checks. Comparing ids, not `createdAt`, keeps a skewed local clock out of it. If after 60 seconds any spec still has no new run, it throws naming those specs. A pass started after `runCoordinator` returns therefore sees each dispatched spec's run, in flight or finished. Two passes started at the same moment can still both dispatch. The workflow that will run the coordinator (out of scope) prevents that with a single `concurrency` group.
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
- AC3: `planSpecs` applies rules 1–6 in order:
  - an open PR wins over a merged one;
  - a merged PR gives `done`;
  - a later merged `Revert "SPEC-…` PR gives `needs-human` / `reverted`;
  - a revert merged before the latest merge still gives `done`;
  - an in-flight `Implement <spec path>` run gives `in-progress` with `run: true`, even with a closed PR;
  - a closed, unmerged PR gives `needs-human` / `closed`, even when its `agent/<slug>` branch still exists;
  - an `agent/<slug>` or `spec/<slug>` branch without a PR gives `in-progress`;
  - with no PR, branch or in-flight run, a most recent completed run concluded `failure` or `cancelled` gives `needs-human` / `failed`, and one concluded `success` doesn't;
  - dry-run runs and runs titled `Implement a spec` affect no spec.

  `SPEC-004` and `SPEC-4` both match spec 4, and `SPEC-0040` and `XSPEC-004` don't.
- AC4: `planSpecs` marks a spec `ready` only when all its dependencies are `done`. Otherwise it is `blocked`, with the unfinished dependencies in ascending order, including ones that are `needs-human`, `in-progress` or `blocked`. The result is sorted by spec number.
- AC5: With a fake `Exec`, `runCoordinator` runs exactly the three read commands above and builds `GithubState` from their output. It maps `open`, `closed` and `merged_at` to the three PR states, and reads every line of a multi-page `gh api` output. It throws when any read command fails. With `dispatch: false` it never runs `git fetch` or `gh workflow run`.
- AC6: With `dispatch: true`:
  - it dispatches the `ready` specs lowest number first, at most `maxParallel` of them, with the exact `gh workflow run` arguments above;
  - it dispatches nothing while any `implement-spec.yml` run is in flight;
  - it runs `git fetch origin main` before comparing, and throws before dispatching when `HEAD` isn't `origin/main` or a file under `specs/` has uncommitted changes;
  - when the second of three dispatches fails, it throws with the first spec's path in the message and doesn't attempt the third;
  - it returns once every dispatched spec has a run with a new `id`, re-listing runs through the fake `sleep`. A new run that is already `completed` with `failure` counts, and a run whose `id` was listed before dispatching doesn't. It throws naming the missing specs when no new run has appeared after 60 seconds of fake time.
- AC7: With an in-memory `RunLog`, `runCoordinator` logs one `plan.result` event and one `dispatch` event per dispatched spec, and the per-spec lines it passes to `log` match the formats above.
- AC8: `spec-coding-agent/README.md` documents the `--plan` mode, its options and the rules for each state, including that reverts, closed PRs and failed runs go to a human and are never retried, and that two passes started at the same moment can both dispatch. `specs/README.md` shows the optional `depends_on` frontmatter in the template and its rules. Tests use fakes only: no network, no `gh`, no git remote.

## Out of scope
- Running agents locally in parallel, one git worktree per spec. That is spec 006, which reuses `planSpecs`.
- A workflow that runs `--plan --dispatch` on every merge to `main`. A human adds it after this PR, since the agent can't write under `.github/`.
- Other changes to `implement-spec.yml`, such as budget inputs. Its `run-name` was added together with this spec.
- Claim stores other than GitHub (Postgres, leases, lease expiry).
- Retrying failed or closed runs, and re-implementing reverted specs automatically.
- Detecting reverts whose title isn't GitHub's `Revert "SPEC-…` format, and partial reverts.
- Passing one spec's output to another's prompt, or any agent-to-agent messaging.
- Changes to how the agent implements a single spec. `depends_on` only affects the plan.
