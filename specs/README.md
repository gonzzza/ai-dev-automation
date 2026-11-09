# Specs

Each spec is a markdown file the [agent](../agent) implements as one pull request. Write it the way you would brief a strong engineer who is new to the codebase: say what and why, and leave the how to them unless it matters.

The file name becomes the branch name, so use lowercase kebab-case with a number: `002-add-cache.md` → branch `agent/002-add-cache`.

## Template

```markdown
# <Title: becomes the PR title>

## Goal
Why this change exists and who it is for. Two or three sentences.

## Requirements
- Behavior, public API, error handling. Be specific about signatures when they matter.

## Acceptance criteria
- Observable, testable statements. The agent writes a test for each one.

## Out of scope
- What not to build, so the PR stays small.
```

`Goal`, `Requirements` and `Acceptance criteria` are required; the agent refuses a spec without them.
