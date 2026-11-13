---
depends_on: [5]
---

# Run ready specs locally in parallel, one worktree each

## Goal
Spec 005's coordinator starts ready specs as CI runs, which needs the agent's GitHub App and Actions minutes and can't use a developer's own setup. This change lets a developer run the same plan on their machine: each ready spec gets its own git worktree, and the agents run in parallel under the same per-run limits. Every agent run now claims its spec on GitHub before the agent starts, so local and CI coordinators can run side by side without implementing a spec twice. The agents still never talk to each other.

## Requirements

### Claiming a spec before the agent runs
- `GitOps` (in `spec-coding-agent/src/pipeline.ts`) gains `claimBranch(name: string): Promise<unknown>`. `Git` implements it as `git push --no-verify --force-with-lease=<name>: origin <name>`. The empty expected value after the colon means "this ref must not exist on `origin` yet", so the push creates the branch or fails, and never moves an existing one. The server checks it, so of two runs racing for one spec, only one wins.
- `runPipeline` calls `claimBranch(branch)` right after `createBranch` and before `fingerprint()` and the agent. If it fails, it throws `Another run already claimed <spec path>: <branch> exists on origin.`, with the push's output, before any API spend. Dry runs don't claim.
- The claim branch points at the base commit, so it holds none of the agent's work until the final push, which fast-forwards it. If the run fails after claiming, the branch stays on `origin`. Spec 005's rules then show the spec as `in-progress (<branch>)`, or as `needs-human: failed` when a CI run failed. The README's re-arm steps already say to delete it.
- `Git.push` drops `-u`: `git push --no-verify origin <branch>`. Parallel worktrees share the main repository's config, and `-u` writes tracking keys into that config. That would change the git-state fingerprint of every other run in progress and fail them. The harness doesn't need upstream tracking, since `gh pr create` gets `--head` explicitly. The fix cycle's pushes go through the same method.

### Starting from a detached worktree
- `runPipeline`'s preflight also accepts a detached `HEAD` whose commit equals `origin/<base>`. Worktrees can't check out `main` while the main checkout has it. `GitOps` gains `headSha(): Promise<string>`, which `Git` already has, and `remoteSha(branch: string): Promise<string>` (`git rev-parse refs/remotes/origin/<branch>`). A detached `HEAD` anywhere else throws `Check out <base>, or detach at origin/<base>, first (currently detached at <short sha>).` A named branch behaves exactly as today.

### Planning with local worktrees
- New module `spec-coding-agent/src/local.ts`. Worktrees for local runs live in `<worktreeDir>/<slug>`. The CLI default for `worktreeDir` is `<parent of the repo root>/<repo folder name>-worktrees`: outside the repository, and outside the system temp directory, because a kept worktree is the record of a failure.
- `SpecState` (in `coordinate.ts`) gains `{ status: "needs-human"; reason: "local-worktree"; worktree: string }`, and `formatPlanned` prints it as `needs-human: local-worktree (<path>)`.
- `applyLocalWorktrees(plan: readonly PlannedSpec[], worktrees: readonly string[], worktreeDir: string): PlannedSpec[]` is pure. A spec has a leftover worktree when `path.resolve(worktreeDir, slug)` equals the `path.resolve` of one of `worktrees`. Such a spec becomes `needs-human` / `local-worktree` when its planned state is `ready`, or `in-progress` with only a `branch` (no `pr`, no `run`). Every other state is kept: GitHub's view wins once a PR or a run exists.
- `worktrees` comes from `git worktree list --porcelain`: the path of each `worktree <path>` line.

### A local wave
- `runLocalWave(deps)` takes the parsed specs, an injected `Exec`, the repo root, `worktreeDir`, `maxParallel`, the agent arguments to pass on (`agentArgs: string[]`), the environment for the runs (`env`), an injected `spawnAgent`, an optional sandbox to prepare, `log` and an optional `RunLog`. It returns `{ plan: PlannedSpec[]; started: string[]; succeeded: string[]; failed: { spec: string; worktree: string; exitCode: number }[] }`. In order:
  1. **Checkout.** The same checks as `--dispatch`: `git fetch origin main`, `HEAD` equals `origin/main`, nothing uncommitted under `specs/`.
  2. **Lock.** It creates `<worktreeDir>/.lock` with the `wx` flag, and removes it in a `finally`. If the file exists, it throws `Another local wave is running, or one crashed and left <path>; delete it if none is running.` The lock keeps two waves on one machine from reading each other's worktrees as failures.
  3. **Plan.** The same three GitHub reads as `runCoordinator`, then `planSpecs`, then `applyLocalWorktrees`. The reads move into an exported `readGithubState(exec, repoRoot)` in `coordinate.ts`, which `runCoordinator` uses too. It logs one `formatPlanned` line per spec.
  4. **Prepare.** It takes up to `maxParallel` `ready` specs, lowest number first. For each, in turn, it runs `git worktree add --detach <worktreeDir>/<slug> origin/main`, then `npm ci` in that worktree, with a 15-minute timeout. Each worktree needs its own `node_modules`: the workspace packages are linked in it, so a shared one would test the main checkout's code. With a Docker sandbox, it calls `prepareSandbox` once before starting any run, so the runs don't install into the same dependency volume at the same time. A failure here throws, naming the specs prepared so far, before any agent starts.
  5. **Run.** It starts every prepared spec at once with `spawnAgent(["<spec path>", ...agentArgs], { cwd: <worktree>, env, onLine })`, which resolves to the exit code, and waits for all of them. `env` sets `INIT_CWD` to the worktree, because the CLI resolves paths against it. Each output line is passed to `log` prefixed with `[<number>] `, e.g. `[006] Created agent/006-…`. One run failing doesn't stop the others.
  6. **Clean up.** After exit code `0`, it runs `git worktree remove <worktree>`. If that fails, it logs a warning and doesn't throw. Otherwise it keeps the worktree, records the spec in `failed`, and logs the worktree path.
- `spawnAgent`'s default implementation runs `npm run agent -- <args>` with `node:child_process` `spawn` and streams its output line by line. Like `exec`, it uses a shell only for `npm` on Windows.
- With a `RunLog`, it logs a `local.start` event `{ spec, worktree }` per run started, and a `local.end` event `{ spec, worktree, exitCode, kept }` per run finished.

### CLI
- New option `--local`: `npm run agent -- --plan --local [--max-parallel <n>] [--worktree-dir <dir>]`, listed in `USAGE`.
  - It reads the specs and runs `checkSpecs` as `--plan` does, then calls `runLocalWave`.
  - `--local` with `--dispatch` is a usage error, and so is `--worktree-dir` without `--local`.
  - It needs `ANTHROPIC_API_KEY`, from the environment or the repo root's `.env`, read the way the CLI reads it today. It passes the key to the runs in `env`, since a worktree has no `.env`.
  - These options are passed to every run unchanged: `--scope`, `--model`, `--effort`, `--max-turns`, `--max-budget`, `--sandbox`, `--sandbox-image`, `--standards`, `--standards-packs`, `--standards-ref`, `--max-standards-chars`. `--log-dir` is passed as an absolute path, so every run's audit log lands in one folder. Relative paths in the other options resolve in each worktree, which is at `origin/main`.
  - One wave spends at most `--max-parallel` times `--max-budget`. The process exits non-zero when any run failed.

## Acceptance criteria
- AC1: `runPipeline` accepts a detached `HEAD` equal to `origin/<base>` and creates the branch as usual. It throws the detached-`HEAD` message when the detached commit differs, and behaves as before on a named branch: it runs on `base` and throws on any other branch.
- AC2: On a non-dry run, `runPipeline` calls `claimBranch` after `createBranch` and before `fingerprint` and `runAgent`. When `claimBranch` rejects, it throws the "already claimed" message naming the spec and never calls `runAgent`. A dry run never calls `claimBranch` or `push`. `Git.claimBranch` and `Git.push` run exactly the arguments above, with no `-u`.
- AC3: In a real temporary repository with a local bare `origin` and two worktrees, the first `claimBranch` for a branch succeeds and a second one, from the other worktree, fails. A `push` from one worktree leaves the other worktree's `fingerprint()` unchanged.
- AC4: `applyLocalWorktrees` turns a `ready` spec, and an `in-progress` spec with only a branch, into `needs-human` / `local-worktree` when its worktree is listed. It matches paths after `path.resolve`, so a listing with forward slashes matches a Windows `worktreeDir`. It leaves specs with an open PR, a merged PR, an in-flight run or no worktree unchanged. `formatPlanned` prints the new state as specified.
- AC5: With a fake `Exec`, `runLocalWave` throws before creating any worktree when `HEAD` isn't `origin/main`, when `specs/` has uncommitted changes, or when the lock file exists. It removes its lock file both after a successful wave and after a run that throws.
- AC6: For three `ready` specs and `maxParallel: 2`, `runLocalWave` prepares and starts only the two lowest. It runs the exact `git worktree add` and `npm ci` commands for each, calls `prepareSandbox` once before the first `spawnAgent` when a sandbox is given, and calls `spawnAgent` with the spec path plus `agentArgs`, the worktree as `cwd`, and `INIT_CWD` set in `env`. A failing `npm ci` throws before any `spawnAgent` call.
- AC7: When one of two runs exits `1` and the other `0`, `runLocalWave` removes only the successful worktree, returns the failure with its worktree and exit code, and logs every output line with its `[<number>] ` prefix. With an in-memory `RunLog`, it logs one `local.start` and one `local.end` per run, with `kept` set correctly.
- AC8: `spec-coding-agent/README.md` documents:
  - the early claim, and that a run failing after it leaves the branch on `origin`;
  - `--plan --local` and its options;
  - the worktree folder, and the `local-worktree` state;
  - re-arming a local failure: `git worktree remove`, delete the local and the `origin` branch, run again;
  - that interrupting a wave leaves its worktrees and claim branches behind.

  Tests use fakes, except AC3's repository in a temporary directory, like the existing `git-repo.test.ts`. No network, no `gh`, no Anthropic calls.

## Out of scope
- Starting another wave automatically when a wave finishes. Dependents only become ready after a human merges.
- Cleaning up after Ctrl-C, and telling a lost claim race apart from a failure (both keep the worktree).
- Showing a local failure on other machines or in CI. There the spec shows `in-progress (<branch>)` until a person re-arms it.
- Removing kept worktrees, or deleting claim branches, automatically.
- Sharing `node_modules` between worktrees, or running `npm ci` in parallel.
- A workflow that runs the coordinator on merges to `main`.
- Changes to spec 005's state rules other than the `local-worktree` state.
