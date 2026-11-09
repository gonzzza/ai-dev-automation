# Specs

Each spec is a markdown file the [agent](../agent) implements as one pull request. Write it the way you would brief a strong engineer who is new to the codebase: say what and why, and leave the how to them unless it matters.

The easiest way to write one is the `/write-spec` skill in Claude Code:

```
/write-spec circuit breaker for outbound calls
```

It reads the code the change touches, drafts the spec, asks the few questions that would change what gets built, checks every criterion is testable, and validates the file. It stops there: you review the spec before anything gets implemented. The skill is in [`.claude/skills/write-spec/`](../.claude/skills/write-spec/SKILL.md).

The file name becomes the branch name, so use lowercase kebab-case with a number: `002-add-cache.md` → branch `agent/002-add-cache`.

## Template

```markdown
# <Title: becomes the PR title>

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
