---
depends_on: [5]
---

# Run ready specs locally in parallel, one worktree each

## Goal
Spec 005's coordinator starts ready specs as CI runs, which needs the agent's GitHub App and Actions minutes and can't use a developer's own setup. This change lets a developer run the same plan on their machine: each ready spec gets its own git worktree, and the agents run in parallel under the same per-run limits. Every agent run now claims its spec on GitHub before the agent starts, so local and CI coordinators can run side by side without implementing a spec twice. The agents still never talk to each other.

## Requirements

### Claiming a spec before the agent runs
- `GitOps` (in `spec-coding-agent/src/pipeline.ts`) gains `claimBranch(name: string): Promise<unknown>`. `Git` implements it as `git push --no-verify --force-with-lease=<name>: origin <name>`. The empty expected value after the colon means "this ref must not exist on `origin` yet", so the push creates the branch or fails, and never moves an existing one. The server checks it, so of two runs racing for one spec, only one wins.
- `GitOps` also gains `branchExistsOnOrigin(name: string): Promise<boolean>`: the exact-match `git ls-remote --heads origin refs/heads/<name>` check that `Git.branchExists` already makes, on its own. It throws if `ls-remote` fails, so an unreachable `origin` is never read as "no branch".
- `runPipeline` calls `claimBranch(branch)` right after `createBranch` and before `fingerprint()` and the agent. Dry runs don't claim.
- **A branch can't tell a live claim from a stale one.** A run that claims and then fails leaves its branch on `origin` with nobody working on it, and nothing in the branch says so. So whenever the state is ambiguous, the run fails loudly, and a person decides, as spec 005 does for every exception. Only one case is unambiguous: a lost race.
  - **A lost race:** `claimBranch` fails, and `branchExistsOnOrigin(branch)` is then true. The branch didn't exist at preflight a moment earlier, so another run created it in the last few seconds and is certainly alive. `runPipeline` throws a `ClaimLostError` (a new exported `Error` subclass in `pipeline.ts`) with the message `Another run already claimed <spec path>: <branch> exists on origin.`, before any API spend.
  - **Any other failed claim push** (credentials, network, permissions, a server hook, or `branchExistsOnOrigin` throwing or returning false): `runPipeline` rethrows the push's error unchanged, as an ordinary failure.
  - **A branch already on `origin` at preflight** stays the ordinary `Branch … already exists` error, as today. It may be a live claim or a stale one.
- `exitCodeFor(error: unknown): number`, exported from `pipeline.ts`, returns `3` for a `ClaimLostError` and `1` for anything else. The CLI exits with it, and the run log's `run.end` gets the category `claim-lost`. `npm run agent` passes the code through: npm hands back a script's exit code, and the implementation checks that it survives the root script's nested `npm start -w`. Only local waves act on `3`. CI doesn't map it: a CI run that loses a race fails with the "already claimed" message and shows as `needs-human: failed`. That takes two runs passing preflight within the same few seconds, and a false alarm is better than a hidden failure.
- The claim branch points at the base commit, so it holds none of the agent's work until the final push, which fast-forwards it. If the run fails after claiming, the branch stays on `origin`. Spec 005's rules then show the spec as `in-progress (<branch>)`, or as `needs-human: failed` when a CI run failed, and any retry fails at preflight until a person deletes the branch.
- A branch on `origin` can be another run's live claim. So the README's re-arm steps say to delete one only after `--plan` shows the spec with no open PR and no run in flight, and only on the machine whose wave kept the worktree.
- `Git.push` drops `-u`: `git push --no-verify origin <branch>`. Parallel worktrees share the main repository's config, and `-u` writes tracking keys into that config. That would change the git-state fingerprint of every other run in progress and fail them. The harness doesn't need upstream tracking, since `gh pr create` gets `--head` explicitly. The fix cycle's pushes go through the same method.

### Starting from a detached worktree
- `runPipeline`'s preflight also accepts a detached `HEAD` whose commit is on `origin/<base>`: equal to it or an ancestor of it. Worktrees can't check out `main` while the main checkout has it. Ancestors are accepted, not only the tip, because a `git fetch` anywhere in the repository moves the shared `origin/main` ref, possibly while a wave's other worktrees are still running `npm ci`. Every commit on `main` still gives a PR that holds only the agent's work.
- `GitOps` gains `headSha(): Promise<string>`, which `Git` already has, and `headOnBase(base: string): Promise<boolean>`. `Git` implements it as `git merge-base --is-ancestor HEAD refs/remotes/origin/<base>`: exit code `0` is true, `1` is false, and anything else throws with the output. A detached `HEAD` that isn't on `origin/<base>` throws `Check out <base>, or detach on origin/<base>, first (currently detached at <short sha>).` A named branch behaves exactly as today.

### Planning with local worktrees
- New module `spec-coding-agent/src/local.ts`. Worktrees for local runs live in `<worktreeDir>/<slug>`. The CLI default for `worktreeDir` is `<parent of the repo root>/<repo folder name>-worktrees`: outside the repository, and outside the system temp directory, because a kept worktree is the record of a failure.
- `SpecState` (in `coordinate.ts`) gains `{ status: "needs-human"; reason: "local-worktree"; worktree: string }`, and `formatPlanned` prints it as `needs-human: local-worktree (<path>)`.
- `applyLocalWorktrees(plan: readonly PlannedSpec[], worktrees: readonly string[], worktreeDir: string, platform: NodeJS.Platform = process.platform): PlannedSpec[]` is pure. A spec has a leftover worktree when the resolved `worktreeDir` plus `slug` equals the resolved path of one of `worktrees`. Paths are resolved with the path functions of `platform`, not of the host: `path.win32.resolve` when `platform` is `win32`, then lowercased, because Windows paths ignore case (`git worktree list` can print `C:/Users/…` for a folder given in lower case); `path.posix.resolve` otherwise. That way the Windows behavior is tested on any host, the Linux CI runner included. Such a spec becomes `needs-human` / `local-worktree` when its planned state is `ready`, or `in-progress` with only a `branch` (no `pr`, no `run`). Every other state is kept: GitHub's view wins once a PR or a run exists.
- `worktrees` comes from `git worktree list --porcelain`, run right after `git worktree prune`: the path of each `worktree <path>` line. The prune drops the registration of a kept worktree whose folder was deleted by hand, so that spec isn't stuck at `needs-human`.

### A local wave
- `runLocalWave(deps)` takes the parsed specs, an injected `Exec`, the repo root, `worktreeDir`, `maxParallel`, the agent arguments to pass on (`agentArgs: string[]`), the environment for the runs (`env`), an injected `spawnAgent`, an optional sandbox to prepare, `log` and an optional `RunLog`. It returns `{ plan: PlannedSpec[]; started: string[]; succeeded: string[]; lostClaim: string[]; failed: { spec: string; worktree: string; exitCode: number }[] }`. In order:
  1. **Checkout.** The same checks as `--dispatch`: `git fetch origin main`, `HEAD` equals `origin/main`, nothing uncommitted under `specs/`.
  2. **Lock.** It creates `worktreeDir` if it doesn't exist (`mkdir` with `recursive: true`) and resolves it with `fs.realpath`. From then on it uses only that real path, for the lock, `git worktree add` and `applyLocalWorktrees`. Git records and lists real paths, so a `worktreeDir` reached through a symlink (macOS's `/tmp` is `/private/tmp`) would otherwise never match its own worktrees. Then it creates `<worktreeDir>/.lock` with the `wx` flag, and removes it in a `finally`. Only an `EEXIST` error means another wave holds the lock; any other error propagates unchanged. On `EEXIST` it throws `Another local wave is running, or one crashed and left <path>; delete it if none is running.` The lock keeps two waves on one machine from reading each other's worktrees as failures.
  3. **Plan.** The same three GitHub reads as `runCoordinator`, then `planSpecs`, then `applyLocalWorktrees`. The reads move into an exported `readGithubState(exec, repoRoot)` in `coordinate.ts`, which `runCoordinator` uses too. It logs one `formatPlanned` line per spec.
  4. **Prepare.** It takes up to `maxParallel` `ready` specs, lowest number first. For each, in turn, it runs `git worktree add --detach <worktreeDir>/<slug> origin/main`, then `npm ci` in that worktree, with a 15-minute timeout. Each worktree needs its own `node_modules`: the workspace packages are linked in it, so a shared one would test the main checkout's code. With a Docker sandbox, it calls `prepareSandbox` once before starting any run, so the runs don't install into the same dependency volume at the same time. If preparing fails, it removes every worktree it created in this wave, the half-prepared one included, with `git worktree remove --force <path>`. It logs a failed removal instead of throwing. Then it throws, naming the spec that failed, before any agent starts. No agent ran and nothing was claimed, so there's no failure to keep a record of.
  5. **Run.** It starts every prepared spec at once with `spawnAgent(["<spec path>", ...agentArgs], { cwd: <worktree>, env: { ...env, INIT_CWD: <worktree> }, onLine })`, which resolves to a numeric exit code, and waits for all of them. `INIT_CWD` is set because the CLI resolves paths against it. Each output line is passed to `log` prefixed with `[<number>] `, e.g. `[006] Created agent/006-…`. One run failing doesn't stop the others.
  6. **Clean up.** It handles each run by its exit code:
     - `0`: it runs `git worktree remove <worktree>`. If that fails, it logs a warning naming the path to remove by hand, and doesn't throw.
     - `3`, a lost claim: the worktree holds no work, and the local `agent/<slug>` branch it created points at the base commit. It runs `git worktree remove --force <worktree>` and `git branch -D agent/<slug>`, logging rather than throwing on failure, and records the spec in `lostClaim`.
     - Anything else: it keeps the worktree, records the spec in `failed`, and logs the worktree path.
- `spawnAgent`'s default implementation runs `npm run agent -- <args>` with `node:child_process` `spawn` and streams its output line by line. Like `exec`, it uses a shell only for `npm` on Windows. It resolves to `childExitCode(code, signal)`, a pure exported function: the exit code when `code` is a number, and `1` when the child was killed by a signal (`code` is `null`). So a killed run is never mistaken for a success.
- With a `RunLog`, it logs a `local.start` event `{ spec, worktree }` per run started, and a `local.end` event `{ spec, worktree, exitCode, kept }` per run finished.

### CLI
- New option `--local`: `npm run agent -- --plan --local [--max-parallel <n>] [--worktree-dir <dir>]`, listed in `USAGE`.
  - It reads the specs and runs `checkSpecs` as `--plan` does, then calls `runLocalWave`.
  - `--max-parallel` works as it does for `--dispatch`: default `2`, validated with `parseLimit(…, { integer: true })`. `runLocalWave` also throws `RangeError` for a `maxParallel` that isn't a positive integer, as `runCoordinator` does.
  - `--local` without `--plan`, `--local` with `--dispatch`, and `--worktree-dir` without `--local` are usage errors.
  - It needs `ANTHROPIC_API_KEY`, from the environment or the repo root's `.env`, read the way the CLI reads it today. The `env` it passes to `runLocalWave` is its own `process.env` plus that key, so the runs keep `PATH` and the rest, and get the key although a worktree has no `.env`.
  - These options are passed to every run unchanged: `--scope`, `--model`, `--effort`, `--max-turns`, `--max-budget`, `--sandbox`, `--sandbox-image`, `--standards`, `--standards-packs`, `--standards-ref`, `--max-standards-chars`. `--log-dir` is passed as an absolute path, so every run's audit log lands in one folder. Relative paths in the other options resolve in each worktree, which is at `origin/main`.
  - One wave spends at most `--max-parallel` times `--max-budget`. The process exits non-zero when any run failed. A lost claim alone doesn't make it fail.

## Acceptance criteria
- AC1: `runPipeline` accepts a detached `HEAD` for which `headOnBase` is true (equal to `origin/<base>`, or behind it after a fetch) and creates the branch as usual. It throws the detached-`HEAD` message when `headOnBase` is false, and behaves as before on a named branch: it runs on `base` and throws on any other branch.
- AC2: On a non-dry run, `runPipeline` calls `claimBranch` after `createBranch` and before `fingerprint` and `runAgent`. When `claimBranch` rejects and `branchExistsOnOrigin` is then true, it throws a `ClaimLostError` with the "already claimed" message naming the spec, and never calls `runAgent`. When `claimBranch` rejects and the branch isn't on `origin`, or `branchExistsOnOrigin` throws, it rethrows the push's error unchanged, not as a `ClaimLostError`, and still never calls `runAgent`. A branch that already exists at preflight, on `origin` or locally, gives the ordinary `already exists` error, as before. `exitCodeFor` returns `3` for a `ClaimLostError` and `1` for a plain `Error`. A dry run never calls `claimBranch` or `push`. `Git.claimBranch` and `Git.push` run exactly the arguments above, with no `-u`.
- AC3: In a real temporary repository with a local bare `origin` and two worktrees, both detached on `origin/main`:
  - the first `claimBranch` for a branch succeeds, and a second one, from the other worktree, fails;
  - `createBranch`, `claimBranch` and `push` in worktree A, taken together, leave worktree B's `fingerprint()` unchanged, as in a wave where A finishes while B runs;
  - `headOnBase` is true for a commit behind `origin/main` and false for a commit that isn't on it.
- AC4: `applyLocalWorktrees` turns a `ready` spec, and an `in-progress` spec with only a branch, into `needs-human` / `local-worktree` when its worktree is listed. With `platform: "win32"`, on any host, a listing with forward slashes matches a `worktreeDir` with backslashes, and a listing that differs only in letter case, drive letter included, still matches. With `platform: "linux"`, paths that differ only in case don't match. It leaves specs with an open PR, a merged PR, an in-flight run or no worktree unchanged. `formatPlanned` prints the new state as specified.
- AC5: With a fake `Exec` and a temporary `worktreeDir`:
  - `runLocalWave` creates a missing `worktreeDir` before taking the lock;
  - given a `worktreeDir` that is a directory symlink (a junction on Windows) to a temporary folder, it runs `git worktree add` with the real path;
  - it throws before creating any worktree when `HEAD` isn't `origin/main`, when `specs/` has uncommitted changes, or when the lock file exists (the "another local wave" message only in that last case);
  - it throws `RangeError` for a `maxParallel` of `0`, `-1` or `1.5`;
  - it removes its lock file both after a successful wave and after a wave that throws.
- AC6: For three `ready` specs and `maxParallel: 2`, `runLocalWave` prepares and starts only the two lowest. It runs `git worktree prune` before `git worktree list --porcelain`, and the exact `git worktree add` and `npm ci` commands for each spec, calls `prepareSandbox` once before the first `spawnAgent` when a sandbox is given, and calls `spawnAgent` with the spec path plus `agentArgs`, the worktree as `cwd`, and an `env` that keeps the given variables and sets `INIT_CWD`. When `npm ci` fails for the second spec, it runs `git worktree remove --force` for both worktrees created in the wave, then throws naming that spec, and never calls `spawnAgent`.
- AC7: For three runs that exit `0`, `1` and `3`:
  - `runLocalWave` removes the first worktree and keeps the second, returning it in `failed` with its worktree and exit code;
  - for the third, it runs `git worktree remove --force` and `git branch -D agent/<slug>`, and returns it in `lostClaim`, not `failed`;
  - it logs every output line with its `[<number>] ` prefix;
  - with an in-memory `RunLog`, it logs one `local.start` and one `local.end` per run, with `kept` true only for the failure.

  `childExitCode` returns the code for `(0, null)` and `(1, null)`, and `1` for `(null, "SIGTERM")` and `(null, "SIGKILL")`.
- AC8: `spec-coding-agent/README.md` documents:
  - the early claim; that only a race lost at the claim push gives exit code `3` and the `claim-lost` category; that a branch already on `origin` is an ordinary failure, because a branch can't tell a live claim from a stale one; and that a run failing after the claim leaves the branch on `origin`;
  - `--plan --local` and its options;
  - the worktree folder, the `local-worktree` state, and that a lost claim removes its worktree;
  - re-arming a local failure: `git worktree remove` (or `git worktree prune` when the folder is already gone), delete the local branch, check with `--plan` that no PR is open and no run is in flight before deleting the `origin` branch, then run again;
  - that interrupting a wave leaves its worktrees and claim branches behind.

  Tests use fakes, except AC3's repository in a temporary directory, like the existing `git-repo.test.ts`. No network, no `gh`, no Anthropic calls.

## Out of scope
- Starting another wave automatically when a wave finishes. Dependents only become ready after a human merges.
- Cleaning up after Ctrl-C.
- Showing a local failure on other machines or in CI. There the spec shows `in-progress (<branch>)` until a person re-arms it.
- Removing kept worktrees, or deleting claim branches, automatically.
- Sharing `node_modules` between worktrees, or running `npm ci` in parallel.
- A workflow that runs the coordinator on merges to `main`.
- Changes to spec 005's state rules other than the `local-worktree` state.
- Treating exit code `3` as success in `implement-spec.yml`. A CI run that loses a race fails, and a person looks.
- Claims that expire (leases, heartbeats), which would let the coordinator tell a stale claim from a live one and free it. Until then, a stale claim is a person's call.
