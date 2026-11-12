# Specs

Each spec is a markdown file the [agent](../spec-coding-agent) implements as one pull request. Write it the way you would brief a strong engineer who is new to the codebase: say what and why, and leave the how to them unless it matters.

The easiest way to write one is the `/write-spec` skill in Claude Code:

```
/write-spec circuit breaker for outbound calls
```

It reads the code the change touches, drafts the spec, asks the few questions that would change what gets built, checks every criterion is testable, and validates the file. It stops there: you [review the spec](#review-the-spec) before anything gets implemented. The skill is in [`.claude/skills/write-spec/`](../.claude/skills/write-spec/SKILL.md).

The file name becomes the branch name, so use lowercase kebab-case with a number: `002-add-cache.md` → branch `agent/002-add-cache`.

## Template

```markdown
---
depends_on: [1, 3]
---

# <Title: at most 63 characters, becomes the PR title after the SPEC-XXX prefix>

## Goal
Why this change exists and who it is for. Two or three sentences.

## Requirements
- Behavior, public API, error handling. Be specific about signatures when they matter.

## Acceptance criteria
- AC1: An observable, testable statement. The agent writes a test for each one.
- AC2: ...

## Out of scope
- What not to build, so the PR stays small.
```

## Rules

`npm run spec:check` enforces these, and it runs as part of `npm run check` in CI. The agent refuses a spec that breaks them.

- `Goal`, `Requirements` and `Acceptance criteria` are required.
- Every top-level bullet under `Acceptance criteria` starts with a unique ID: `- AC1: ...`. The agent starts each test's name with the ID it covers (`it("AC3: ...")`), so a reviewer can trace every criterion to its tests. Indented lines and prose between bullets are fine.
- File names are numbered, and no two specs share a number.
- The frontmatter block is optional. Leave it out when the spec depends on nothing (see below).

## Dependencies

A spec that builds on others names them in a frontmatter block at the very top of the file. The [coordinator](../spec-coding-agent/README.md#coordinator-specs-in-dependency-order) (`npm run agent -- --plan`) only starts a spec once every spec it depends on has a merged PR.

```markdown
---
depends_on: [1, 3]
---
```

- The block starts on the first line with `---` and ends at the next `---` line. In between: `key: value` lines. `depends_on` is the only key.
- The value is an inline list of spec numbers. Leading zeros are allowed (`003` is `3`), and `[]` means no dependencies, the same as no block.
- These are errors, each naming the file: an unclosed block, any other key, `depends_on` given twice, a block list (`- 1` lines), an item that isn't a positive integer (`0`, `-1`, `1.5`, `abc`), and a number listed twice.
- `spec:check` also rejects a dependency on a number no spec has, a spec that depends on itself, and dependency cycles (`dependency cycle: 005 → 006 → 005`).
- `depends_on` only affects the order specs are started in. The agent implements each spec the same way.

## Review the spec

A spec reaches `main` through a pull request, and in CI the agent implements only specs on `main`, so that PR is the spec review. The checks above confirm the spec is well-formed. A reviewer confirms it's right. Look for:

- **Behavior the spec leaves undefined:** edge cases, errors, bad input, time and clocks. The agent will pick a behavior, and the AI review can't tell whether it's the one you wanted. Spec 001 never said what happens when the clock steps backwards, and that gap is the clock bug in the [example runs](../README.md#review-the-spec-before-any-code).
- **Acceptance criteria that miss a requirement**, or that a test can't settle.
- **Scope that won't fit one reviewable PR.** Split it into two specs.

Locally, `npm run agent` takes any spec file, merged or not, so the review is up to you.
