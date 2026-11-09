# AI Code Review Action

Reviews a pull request with Claude and posts one GitHub review: a summary, plus inline comments on bugs, security issues, missing tests, and performance problems. The review is advisory: findings never approve or block a PR unless you set `fail-on`. Operational errors (API outage, a refusal, a malformed response) do fail the job, so you notice them instead of silently getting no review. Don't make the check required unless you also use `fail-on`.

## Usage

```yaml
name: AI review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - uses: gonzzza/ai-dev-automation/review-action@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `anthropic-api-key` | required | Anthropic API key, from a secret. If empty (e.g. PRs from forks), the review is skipped with a warning. |
| `github-token` | `github.token` | Needs `pull-requests: write`. |
| `model` | `claude-sonnet-5-5` | Claude model ID. |
| `effort` | `high` | `low`, `medium`, `high`, `xhigh` or `max`. Higher is more thorough and costs more. |
| `fail-on` | `none` | Fail the check on a finding at or above `low`, `medium`, `high` or `critical`. |
| `max-diff-chars` | `400000` | Diff budget. Files past it are listed as not reviewed, never silently truncated. |
| `exclude` | | Extra glob patterns to skip, one per line. Lockfiles, `dist/`, `*.map`, `*.snap` and `*.min.js` are always skipped. |
| `standards-path` | | Directory of [org standards](#org-standards) to review against. Empty turns the feature off. |
| `standards-packs` | | Packs to load, comma- or newline-separated. Empty loads all of them. |
| `standards-ref` | | Label for the version of the standards applied (a tag or SHA), shown in the summary. |
| `max-standards-chars` | `40000` | Budget for standards text in the prompt. Past it, the least severe standards are left out and listed as not checked. |

Outputs: `findings` (count), `highest-severity`, and `findings-json`: the findings as a JSON array, most severe first, for automation such as the [agent's fix cycle](../agent#fix-cycle). A finding posted as an inline comment carries that comment's `commentId`, so automation can reply on its thread, and a finding that breaks an org standard carries its id as `rule`. It is model output, so validate it before acting on it.

Each run collapses the previous AI review's inline comments as outdated, except threads someone replied to: those stay visible as the record of how the finding was settled.

## Org standards

Platform teams can keep engineering standards in one place and have every repo reviewed against them. Point `standards-path` at a directory of standards and the review also checks the diff against the ones that apply to the changed files. A finding that breaks a standard cites its id, e.g. `**🐛 Bug · medium · TS-002**: …`, and the summary gets a **Standards** line listing the ids checked, the `standards-ref`, and any ids left out for the `max-standards-chars` budget (also logged as a warning).

**Always check the standards out from a pinned ref or the PR's base commit, never the PR head.** Otherwise a PR could edit or delete the standards it is reviewed against.

```yaml
    steps:
      # Standards from the PR's base commit: a PR can't change the rules it is reviewed against.
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
          sparse-checkout: org-standards
      - uses: gonzzza/ai-dev-automation/review-action@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          standards-path: base/org-standards
          standards-ref: ${{ github.event.pull_request.base.sha }}
          standards-packs: typescript, testing   # optional; default is every pack
```

To use a platform repo's standards instead, check that repo out at a tag (`repository: my-org/standards`, `ref: v3`) and pass the tag as `standards-ref`.

### Format

The directory holds one subdirectory per **pack** (e.g. `typescript/`, `testing/`), and each `.md` file in a pack is one **standard**. Other files, nested and hidden directories, and a top-level `README.md` are ignored. A standard is a frontmatter block between two `---` lines, then a markdown body with the rule, why it exists, and a short good/bad example:

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

| Key | Required | Value |
|-----|----------|-------|
| `id` | yes | Matches `^[A-Z][A-Z0-9]*-\d+$`, unique across every loaded file. |
| `title` | yes | One non-empty line. |
| `severity` | yes | `low`, `medium`, `high` or `critical`. Findings that break the standard use it, unless the failure scenario justifies higher. |
| `applies_to` | no | Inline list of globs matched against repo-relative paths (Node's `path.matchesGlob`). Absent or `[]` means every file. |
| `use` | no | Inline list of `agent` and/or `review`. Default `[agent, review]`. The review only uses `review` standards. |

The frontmatter is a strict YAML subset: one `key: value` per line, where a value is a bare or double-quoted string or an inline list `[a, "b"]`. Blank lines are allowed. Unknown keys, block lists, nested maps, multi-line strings and comments are errors. Quote globs that start with `*`.

Any problem (a bad input, a missing directory or pack, an invalid standard, a duplicate id) fails the action before the model is called, with the file and line, e.g. `org-standards/typescript/ts-002.md:4: severity must be one of low, medium, high, critical; got "urgent"`.

The selected standards are ordered most severe first. While they exceed `max-standards-chars` (counting id, title and body), the least severe is left out. They go in the system prompt as an `<org_standards>` block, since they are trusted configuration; the diff stays untrusted user input. A `rule` the model cites that wasn't sent is removed, and the finding kept. See [`org-standards/`](../org-standards) for examples.

## How it works

1. Lists the PR's changed files and drops excluded, deleted, binary and over-budget files. Each one is reported in the summary.
2. Rewrites each patch with new-file line numbers, so the model cites lines that exist in the diff.
3. Calls Claude with a JSON schema (structured outputs) and gets back `{ summary, findings[] }`.
4. Findings on diff lines become inline comments. Any others go in the summary. If GitHub rejects the inline comments, it posts them in the review body instead.

## Security

- The PR title, description and diff are passed as untrusted data, and the system prompt tells the model to ignore instructions inside them. The model's output is only posted as comments; it is never executed.
- The API key is masked in logs. Fork PRs don't get secrets, so they are skipped.
- Use the minimal `permissions` block shown above.

## Development

```sh
npm test -w review-action
npm run build -w review-action   # bundles src/ into dist/index.js; commit dist/
```
