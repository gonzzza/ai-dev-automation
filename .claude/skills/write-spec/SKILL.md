---
name: write-spec
description: Turn a rough feature idea into a spec that a coding agent (or engineer) can implement as one pull request without guessing. Grounds the spec in the actual code, asks only the questions that change the outcome, gives every acceptance criterion a testable ID, and validates the file. Use when the user wants to write, draft or create a spec, or turn an idea into a spec.
argument-hint: <rough idea, e.g. "circuit breaker for outbound calls">
---

# Write a spec

You are helping a developer turn an idea into a spec. In spec-driven development, the spec is the whole brief: whoever implements it (often an autonomous agent) builds exactly what it says, and guesses at everything it doesn't. Your job is to **find the questions an implementer would otherwise have to guess at, and settle them before any code is written.**

The idea: $ARGUMENTS

If no idea was given, ask for it in one sentence and stop.

## 1. Learn the repo's spec conventions

Before drafting, find out how this repo does specs. Don't assume:

- **Where specs live.** Look for `specs/`, `docs/specs/`, `rfcs/` or similar, and read its README for the template and naming rules.
- **What a good spec looks like here.** Read one or two existing specs. They set the level of detail and tone.
- **Project conventions.** Read `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md`: language, test framework, how side effects are handled, error style.
- **The validator and the implementer.** Check `package.json` scripts, `Makefile` and READMEs for a spec check (e.g. `spec:check`) and for how a spec gets implemented (e.g. an agent command).

If the repo has no template, use this one and tell the user you did:

```markdown
# <Title: imperative, becomes the PR title>

## Goal
Why this change exists and who it is for. Two or three sentences.

## Requirements
- Behavior, public API, error handling. Exact signatures where callers depend on them.

## Acceptance criteria
- AC1: An observable, testable statement.

## Out of scope
- What not to build, so the change stays small.
```

The repo's template always wins over this one, including section names.

## 2. Ground the idea in the code

Find the code the change touches, and read it. A spec that names real modules, functions and patterns gets implemented consistently; one that doesn't gets a parallel universe. Note:

- Where the new code should live and how it is exported or wired in.
- Existing pieces it should reuse or compose with (helpers, types, error classes, injectable clocks or clients).
- How similar features are tested, especially how time, network and randomness are injected so tests stay fast and offline.

Never invent an API that doesn't exist. If the idea depends on something missing, that's either a requirement or a question.

## 3. Draft, then ask

Write a complete draft first. Then list the open questions: points where two reasonable engineers would build different things. Typical ones: what counts as an error and how it is reported, sync vs async, defaults, limits and edge values, concurrency, what happens on invalid input.

Ask **at most five**, only ones whose answer changes behavior, each with your recommended answer so the developer can just confirm. Use the AskUserQuestion tool when available. Settle anything minor yourself with the simplest reasonable choice, and say so in the draft. Fold the answers in: each one becomes a requirement or an out-of-scope line.

## 4. Check the draft

Go through every item and fix the draft before showing it:

- **Goal** says why and for whom, not how.
- **Requirements** pin down what callers see: public API, signatures, defaults, errors (type and when). Implementation details only when they matter (a dependency to avoid, a module to reuse).
- **Every acceptance criterion** has an ID (`AC1`, `AC2`, ... unique, in order), and is observable and testable on its own. Each should map to one or a few tests. Rewrite vague words ("fast", "robust", "handles errors", "works well") as something a test can assert.
- **Every requirement** is covered by at least one criterion, including the error cases.
- **Side effects are injectable**: if behavior depends on time, network, randomness or the filesystem, a requirement says how tests control it, and a criterion says tests don't use the real thing.
- **Docs** are a criterion if the change adds public API and the repo documents its API.
- **Out of scope** names the obvious next features and adjacent problems, so the implementer doesn't build them.
- **No secrets, credentials or internal URLs.** Specs are committed and sent to models.

**Size:** one spec is one pull request. If it spans unrelated modules or needs more than about eight criteria, propose a split into separate, numbered specs, each shippable on its own, and ask which to write first.

## 5. Write and validate

- Name it per the repo's rules. If unstated: next free number, zero-padded, plus a short kebab-case slug (`002-circuit-breaker.md`). Never overwrite an existing spec. If the target exists, pick another name or ask.
- Write the file.
- Run the repo's spec validator if there is one, fix what it reports and run it again until it passes. If there is none, re-check the file against the template yourself.

## 6. Hand off

Show the developer:

- The path and a short summary: the goal in one line, the criteria IDs with a few words each, and the decisions you made on their behalf.
- How to implement it, using the command you found in step 1 (for example a dry run first).

**Don't run the implementer, commit, push or open a PR** unless the developer asks. Implementing costs money and opens a pull request, and reviewing the spec first is the point of the workflow.
