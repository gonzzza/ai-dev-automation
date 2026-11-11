# Give the agent the org engineering standards

## Goal
Spec 002 made the AI review check pull requests against the org standards in `org-standards/`. The agent that writes the code doesn't see them yet, so it can write code the review then flags, and spend a fix cycle on it. This change gives the agent the same standards up front, in spec runs and fix runs, so the code it writes already follows the rules the review enforces.

## Requirements

### `standards` package
- `selectStandards` (in `standards/src/select.ts`) makes `paths` optional in `SelectOptions`. When `paths` is omitted, `applies_to` globs are not checked: every standard for `use` is a candidate. Ordering and the `maxChars` budget work as before, and calls that pass `paths` behave exactly as today.

### Loading in the agent
- New module `spec-coding-agent/src/standards.ts`, importing from the `standards` package (already a dependency of `spec-coding-agent`, so don't edit any `package.json`).
- `loadAgentStandards(options, runLog?)`, where `options` is `{ path?: string; packs: string[]; ref?: string; maxChars: number }`:
  - Returns `undefined` when `path` is missing or empty, and the agent then behaves exactly as it does today.
  - Otherwise it loads the standards with `loadStandards(path, packs)`, selects them with `selectStandards(…, { use: "agent", maxChars })` and no `paths` (the agent can't know which files it will create), and returns `{ standards: Standard[]; checked: string[]; dropped: string[]; ref?: string }`.
  - It throws `RangeError` naming `--max-standards-chars` when `maxChars` is not a positive integer, and lets the `StandardsError` from a missing directory, an unknown pack or an invalid file propagate unchanged.
  - When a `runLog` is passed, it logs one `standards.loaded` event: `{ path, ref, packs, checked, dropped }`.

### Prompt
- `standardsPrompt(standards: readonly Standard[]): string` renders the text appended to the system prompt: a short instruction, then an `<org_standards>` block with one `<standard id="…" severity="…" title="…" applies_to="…">` element per standard holding its body. `applies_to` lists the globs comma-separated, or says `all files` when there are none. Attribute values and bodies are XML-escaped.
- The instruction says:
  - The standards are org policy, set by the repository operator.
  - Follow each one in the files its `applies_to` matches, for code and tests alike.
  - If the spec or a review finding conflicts with a standard, follow the standard and explain the conflict in `notes`.
  - Findings that cite a standard id in their `rule` refer to the standard with that id.
- `systemPromptOption(standards: readonly Standard[])` returns the SDK's `systemPrompt` option:
  - With no standards, exactly `{ type: "preset", preset: "claude_code" }`.
  - Otherwise, the same object plus `append: standardsPrompt(standards)`.
- `runAgent` uses `systemPromptOption(config.standards ?? [])`. `AgentConfig` gains an optional `standards?: Standard[]`. The standards go in the system prompt because they come from the operator and are trusted. The spec body and findings stay in the user prompt, untrusted.

### CLI
- New options on `npm run agent`, listed in `USAGE`:
  - `--standards <dir>`: standards directory. Absent means no standards.
  - `--standards-packs <list>`: comma-separated packs. Default: all.
  - `--standards-ref <label>`: version label (a tag or SHA) for the log and the PR body.
  - `--max-standards-chars <n>`: default `40000`.
- `cli.ts` calls `loadAgentStandards` once, after the run log starts and before any git or agent work, and sets `config.standards`. Spec runs and fix runs both get them. It prints one line: the checked ids, and the dropped ids if any.

### PR body
- `PrContext` gains an optional `standards?: { checked: string[]; dropped: string[]; ref?: string }`, which the pipeline passes through from its deps.
- When set, `prBody` adds a `## Standards` section before `## Files changed`. It lists the checked ids, the ref if given, and the dropped ids marked as not given to the agent. Without it, the body is unchanged.

## Acceptance criteria
- AC1: `selectStandards` without `paths` keeps every standard for the requested `use`, whatever its `applies_to`, ordered by severity then id and trimmed to `maxChars` from the least severe end. The existing tests with `paths` still pass unchanged.
- AC2: `loadAgentStandards` returns `undefined` for a missing or empty path. For a fixture directory it returns only `use: agent` standards from the requested packs, with `checked`, `dropped` and `ref`. It throws `RangeError` naming `--max-standards-chars` for `0`, `-1`, `1.5` and `NaN`. It throws `StandardsError` for a missing directory and an unknown pack. Fixtures live under `spec-coding-agent/test/fixtures/`.
- AC3: `loadAgentStandards` logs exactly one `standards.loaded` event with `path`, `ref`, `packs`, `checked` and `dropped` to an in-memory `RunLog`, and logs nothing when it returns `undefined`.
- AC4: `standardsPrompt` renders the instruction (including that a standard wins over a conflicting spec or finding, with the conflict recorded in `notes`), then one element per standard in the given order, showing `applies_to` globs or `all files`, with `<`, `&` and `"` escaped in attributes and bodies.
- AC5: `systemPromptOption([])` deep-equals `{ type: "preset", preset: "claude_code" }` with no `append` key. With standards, it adds `append` equal to `standardsPrompt` of the same list.
- AC6: `prBody` with `standards` has a `## Standards` section listing the checked ids, the ref and the dropped ids, placed before `## Files changed`. Without `standards`, it equals the output from before this change for the same input.
- AC7: `spec-coding-agent/README.md` documents the four options and explains that standards are trusted operator input in the system prompt, and that they win over a conflicting spec or finding. Tests use fixtures and in-memory logs only: no network and no Anthropic calls.

## Out of scope
- Filtering standards by the files the agent ends up touching, or reloading them mid-run.
- Passing `--standards` in `.github/workflows/ai-review.yml` for the fix job. A human does that after this PR, checking the standards out from the PR base as the review job does.
- Showing standards in fix-cycle PR comments.
- Agent-side checks that the code follows the standards. The review remains the check.
- Changes to the standards file format.
