# Org engineering standards

This directory stands in for a **separate platform repo** that owns the engineering standards every repo is held to. In a real setup it would live in its own repository; it sits here so the demo is self-contained. The AI review action checks pull requests against it (see [`review-action/README.md`](../review-action/README.md#org-standards)), and the agent gets the same standards in its system prompt (see [`spec-coding-agent/README.md`](../spec-coding-agent/README.md)).

The review and fix jobs read these files from the PR's **base** commit, never from the PR head, so a PR can't change the standards it is reviewed and fixed against. That isn't a version pin: the base follows `main`, so a change merged here applies to the next PR. In a real setup, each repo pins a tag of the standards repo and takes new versions through a bump PR (see [Org standards](../README.md#org-standards)).

## Layout

```
org-standards/
  README.md            ignored
  typescript/          a pack
    ts-001-no-any-in-exports.md
    ...
  testing/             another pack
    test-001-criterion-ids.md
    ...
```

Each subdirectory is a **pack**, and each `.md` file in a pack is one **standard**. Other files, nested directories and this README are ignored. Repos can opt into a subset of packs with the action's `standards-packs` input.

## File format

A standard starts with a frontmatter block between two `---` lines, followed by a markdown body: the rule, why it exists, and a short good/bad example.

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
| `id` | yes | Matches `^[A-Z][A-Z0-9]*-\d+$` (e.g. `TS-002`). Unique across every loaded file. Findings cite it. |
| `title` | yes | One non-empty line. |
| `severity` | yes | `low`, `medium`, `high` or `critical`. The review uses it for findings that break the standard. |
| `applies_to` | no | Inline list of globs matched against repo-relative paths with Node's `path.matchesGlob`. Absent or `[]` means every file. |
| `use` | no | Inline list of `agent` and/or `review`. Default `[agent, review]`. |

The frontmatter is a strict YAML subset, parsed without dependencies:

- One `key: value` per line. Blank lines are fine.
- A value is a bare string, a double-quoted string (`\"` and `\\` are the only escapes), or an inline list like `[a, "b"]`.
- Quote anything YAML would treat specially, such as globs starting with `*` (`"**/src/**"`) or text containing `: ` or ` #`.
- Unknown keys, block lists (`- item` lines), nested maps, multi-line strings and comments are errors.

Errors name the file and line, e.g. `org-standards/typescript/ts-002.md:4: severity must be one of low, medium, high, critical; got "urgent"`.

## Writing a good standard

- One rule per file, phrased so a reviewer can tell whether a diff breaks it.
- Say why it exists: the failure it prevents.
- Keep the body short. Every standard that applies to a PR is sent to the model, within the `max-standards-chars` budget; the least severe ones are dropped first when it runs out.
- Narrow `applies_to` so a standard is only sent for the files it is about.
