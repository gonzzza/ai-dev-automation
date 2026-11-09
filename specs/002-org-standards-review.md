# Review pull requests against org engineering standards

## Goal
Platform teams keep engineering standards (API design, error handling, testing rules) in one place, and every repo should be held to them without copying them around. This change defines a standards file format, a shared parser, and teaches the review action to check a PR against the standards that apply to the files it changes, citing the rule it found broken. Spec 003 will feed the same standards to the agent.

## Requirements

### Standards format
- A standards directory has one subdirectory per **pack** (e.g. `typescript/`, `testing/`). Each `.md` file in a pack is one standard. Other files, nested directories and a top-level `README.md` are ignored.
- Each standard starts with a frontmatter block between two `---` lines, then a markdown body (the rule, why it exists, a short good/bad example):

  ```markdown
  ---
  id: TS-002
  title: Inject clocks and timers
  severity: medium
  applies_to: ["**/src/**/*.ts"]
  use: [agent, review]
  ---
  Code that reads the time or waits takes `now` / `sleep` as options...
  ```

- Frontmatter keys:
  - `id` (required): matches `^[A-Z][A-Z0-9]*-\d+$`, unique across every loaded file.
  - `title` (required): non-empty, one line.
  - `severity` (required): `low`, `medium`, `high` or `critical`.
  - `applies_to` (optional): list of globs matched against repo-relative paths with `matchesGlob` from `node:path`. Absent or empty means it applies to every file.
  - `use` (optional): list of `agent` and/or `review`. Default `[agent, review]`.
- The frontmatter is a strict YAML subset, parsed without dependencies: one `key: value` per line, where a value is a bare or double-quoted string or an inline list `[a, "b"]`. Blank lines are allowed. Anything else (unknown keys, block lists, nested maps, multi-line strings, comments, a missing or unclosed block) is an error.
- Every error throws `StandardsError` (extends `Error`) whose message starts with the file path and, for a frontmatter problem, the line, e.g. `org-standards/typescript/ts-002.md:4: severity must be one of low, medium, high, critical; got "urgent"`.

### `standards` workspace
- The `standards/` workspace (package name `standards`, no runtime dependencies) already exists, with `StandardsError` in `src/index.ts`, and `review-action` already depends on it. Its `exports` point at the TypeScript source, so import it as `"standards"`. Do not change any `package.json` or `tsconfig` file. Tests go in `standards/test/`.
- Exports, with explicit types:
  - `parseStandard(path: string, pack: string, text: string): Standard`, where `Standard` is `{ id, title, severity, appliesTo: string[], use: ("agent" | "review")[], pack, path, body }`.
  - `loadStandards(dir: string, packs?: string[]): Promise<Standard[]>`. Reads every pack, or only the named ones. Throws `StandardsError` if `dir` does not exist, if a named pack does not exist (the message lists the packs that do), or on any parse error or duplicate id.
  - `selectStandards(standards, { use, paths, maxChars }): { selected: Standard[]; dropped: Standard[] }`. Keeps the standards for `use` that apply to at least one of `paths`, ordered by severity (most severe first), then by id. Then, while the total size of the selected ones (id + title + body) is over `maxChars`, it moves the last one, the least severe, to `dropped`.

### Review action
- New inputs in `action.yml`:
  - `standards-path`: directory of standards. Empty (the default) turns the feature off, and the action behaves exactly as it does today.
  - `standards-packs`: packs to load, comma- or newline-separated. Empty means all of them.
  - `standards-ref`: a label for the version being applied (a tag or SHA), shown in the summary. Optional.
  - `max-standards-chars`: the budget for standards text in the prompt. Default `40000`. It must be a positive integer, validated like `max-diff-chars`.
- Configuration errors (a bad input, a missing path or pack, an invalid standard) fail the action before any model call.
- The standards are selected with `use: "review"` and the paths of the files being reviewed. The selected ones are appended to the system prompt, after the existing rules, as an `<org_standards>` block with one `<standard id="…" severity="…" title="…">` element per standard holding its body. A short instruction comes with it: report a violation as a finding, set `rule` to the standard's id, use the standard's severity unless the failure scenario justifies a higher one, and in the body say what the standard requires and where the code departs from it. Standards are trusted input and go in the system prompt. The untrusted-input rules for the diff stay unchanged.
- `FindingSchema` gains an optional `rule: string`. After parsing, a `rule` that doesn't match a standard sent in this review is removed and the finding is kept.
- A finding with a `rule` shows it in the inline comment and summary header, e.g. `**🐛 Bug · medium · TS-002**: …`. `findings-json` carries `rule`.
- When standards were used, the review summary gets a "Standards" line: the ids checked, `standards-ref` if given, and any ids dropped for budget, marked as not checked. Dropped ids are also logged with `io.warning`.

### Sample standards and wiring in this repo
- New `org-standards/` at the repo root stands in for a separate platform repo. Its `README.md` says so and documents the file format. It holds at least four standards across at least two packs, written from the rules this repo already follows (for example: no `any` in exported signatures, inject clocks and timers, tests name the criterion ID they cover, invalid arguments throw `RangeError` naming the value).
- Done by hand after this PR, not by the implementer: `.github/workflows/ai-review.yml` checks out `org-standards/` from the PR's **base** commit (`github.event.pull_request.base.sha`) into a separate path with a second `actions/checkout`, then passes that path and the base SHA as `standards-path` and `standards-ref`. A PR can't change the standards it is reviewed against.

## Acceptance criteria
- AC1: `parseStandard` returns every field for a valid file, with `use` defaulting to `[agent, review]`, `applies_to` defaulting to `[]`, quoted and bare strings both accepted, and the body excluding the frontmatter.
- AC2: `parseStandard` throws `StandardsError` with `path:line` for each of: missing required key, unknown key, invalid `id`, `severity` or `use` value, block list, nested map, and missing or unclosed frontmatter.
- AC3: `loadStandards` reads all packs or only the named ones, ignores non-`.md` files and the top-level README, and throws `StandardsError` for a missing directory, an unknown pack (listing the available ones), and an id used in two files. Tests use fixture directories under `standards/test/fixtures/`.
- AC4: `selectStandards` keeps only standards for the requested `use` whose globs match at least one path (an empty `applies_to` always matches), orders them by severity then id, and when over `maxChars` drops from the least severe end, returning the dropped ones.
- AC5: With `standards-path` empty, the request sent to the injected Anthropic client is byte-for-byte what it was before this change. With standards configured, the system prompt is the existing prompt followed by the `<org_standards>` block holding only the selected standards.
- AC6: A finding whose `rule` matches a sent standard keeps it, shows the id in its inline comment and appears in `findings-json` with it. A finding with an unknown `rule` is kept without one.
- AC7: The summary lists the checked ids, `standards-ref` and the dropped ids. An invalid `max-standards-chars`, a missing `standards-path` or an unknown pack fails the action before the Anthropic client is called.
- AC8: A test loads the real `org-standards/` directory without errors and finds at least four standards in at least two packs. `review-action/README.md` documents the four inputs, the file format and the advice to check standards out from a pinned ref or the PR base, never the PR head.

## Out of scope
- Feeding standards to the agent (spec 003).
- Editing `.github/workflows/` and rebuilding `review-action/dist/`. A human does both after the PR.
- Fetching standards from another repo inside the action. The workflow checks them out, so the action only reads a directory.
- Repo-local overrides or exemptions (disabling a standard for one repo or path).
- Linking findings to a URL for the standard's source file.
- Full YAML support, and frontmatter keys beyond the five listed.
- Metrics on which rules fire or get dismissed.
