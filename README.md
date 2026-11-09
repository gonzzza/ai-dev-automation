# ai-dev-automation

**spec → agent writes the code → PR → AI review → agent fixes → human approves**

```mermaid
flowchart LR
  spec["Spec<br/>(markdown)"] --> agent["Agent writes<br/>code + tests"]
  agent --> pr["Pull request<br/>+ CI"]
  pr --> review["AI review<br/>(a different model)"]
  review -- "findings ≥ medium" --> fix["Agent fixes or declines<br/>(up to 5 cycles)"]
  fix -- "push" --> review
  review -- "only low findings, or none" --> human["Human approves<br/>and merges"]
  standards[("Org standards<br/>(pinned version)")] -.-> agent
  standards -.-> review
```

AI coding agents are fast, but unattended they are hard to trust. This repo shows one way to make them trustworthy: the agent works from a written spec, guardrails enforced in code and checked in CI limit what it can do, a second model reviews every change, and a person still approves every merge.

## See it run: [PR #5](https://github.com/gonzzza/ai-dev-automation/pull/5)

The agent implemented [`specs/001-rate-limiter.md`](specs/001-rate-limiter.md) on its own, and the loop took it from there. The PR history shows every step:

1. **The agent opened the PR:** a token bucket rate limiter with 22 tests, in 13 turns, for $0.74.
2. **The AI review found a bug the agent's tests missed.** Refill stopped after the system clock stepped backwards.
3. **Fix cycle 1 made it worse.** That run of the reviewer rated the clock bug *low*, so the agent wasn't asked to fix it. While adding the tests it was asked for, the agent wrote one that treated the bug as intended behavior. The loop's stop rule also misfired.
4. **The design was fixed ([#8](https://github.com/gonzzza/ai-dev-automation/pull/8)).** The fixer now sees low findings as context it must not lock in, and the loop stops only when a finding comes back, not on a count.
5. **Fix cycle 2 fixed the bug** and rewrote the wrong test, for $0.13.
6. **The final review had one low finding left**, so the loop stopped and handed the PR to a human.

That history is the point of the demo. The automation caught a real bug, made a mistake, and stayed bounded. Every step is visible on the PR for the person who decides.

## What's in the repo

| Path | What it is |
|------|------------|
| [`agent/`](agent) | The spec-driven agent, built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). It reads a spec, implements it with tests, verifies the result independently, and opens a PR. In fix mode it addresses review findings on its own PRs. |
| [`review-action/`](review-action) | A GitHub Action that reviews a PR's diff with Claude and posts inline comments on bugs, security issues and missing tests. Other repositories can use it on its own. |
| [`.github/workflows/`](.github/workflows) | CI (`npm run check`) and the AI review with the fix cycle, both running on this repo's own PRs. |
| [`specs/`](specs) | Feature specs, the agent's input. [`specs/README.md`](specs/README.md) has the template. |
| [`.claude/skills/write-spec/`](.claude/skills/write-spec/SKILL.md) | A Claude Code skill, `/write-spec <idea>`, that turns a rough idea into a spec: grounded in the code, with the open questions settled and every acceptance criterion testable. |
| [`demo-app/`](demo-app) | A small TypeScript library the agent works on. |
| [`org-standards/`](org-standards) | Sample org engineering standards. **A stand-in for a separate platform repo**, kept here so the demo is self-contained. See [Org standards](#org-standards). |
| [`standards/`](standards) | The parser and selector for those standards, shared by the agent and the review action. |

## Setup

### Add the AI review to your repository

The review action works on its own. Add an `ANTHROPIC_API_KEY` repository secret, then this workflow:

```yaml
# .github/workflows/ai-review.yml
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

The inputs (model, effort, `fail-on`, exclusions) are in [`review-action/README.md`](review-action/README.md).

### Run the whole loop

You need Node 24 or later, `git`, an authenticated [`gh`](https://cli.github.com/), and an Anthropic API key. Start with a fork, so the agent opens PRs on your copy.

```sh
git clone https://github.com/<you>/ai-dev-automation && cd ai-dev-automation
npm ci
npm run check                      # lint, typecheck, tests in every workspace, and spec validation

export ANTHROPIC_API_KEY=sk-ant-...
npm run agent -- specs/001-rate-limiter.md --dry-run   # implement and verify, no commit
npm run agent -- specs/001-rate-limiter.md             # open the PR
```

The agent creates the branch `agent/001-rate-limiter`, so delete that branch first if it already exists. To write your own spec, run `/write-spec <your idea>` in Claude Code, or copy the template in [`specs/README.md`](specs/README.md).

To run the review and the fix cycle on the PR in CI, add two repository secrets:

| Secret | Used for |
|--------|----------|
| `ANTHROPIC_API_KEY` | The review and the agent's fix cycle |
| `AGENT_GITHUB_TOKEN` | The fix cycle's push and PR comment. A [fine-grained token](https://github.com/settings/personal-access-tokens/new) for this repository only, with *Contents* and *Pull requests* set to read and write. A push made with the workflow's own token wouldn't trigger the next review. |

Without `AGENT_GITHUB_TOKEN`, the review still runs and only the fix cycle fails. On a fork, also enable GitHub Actions under the fork's **Actions** tab, since forks start with workflows disabled.

## Org standards

Every repo's agent and review follow the same engineering standards, kept in one place and owned by the platform team. A standard is a short markdown file with an id, a severity and the files it applies to ([format](org-standards/README.md)):

- **The agent** gets them in its system prompt, so the code it writes follows them from the start. Spec and fix runs both get them.
- **The review** checks each PR against the standards that apply to its changed files. A finding that breaks one cites it, e.g. `🐛 Bug · medium · TS-002`.
- **Every run records which standards it used, at which version:** the review summary, the agent's PR body and its audit log.

**In this repo**, the standards live in [`org-standards/`](org-standards) so the demo is self-contained. The review workflow reads them from the PR's base commit, so a PR can't change the rules it's reviewed against.

**In an enterprise setup**, they belong in their own repository, for example `acme/engineering-standards`:

- The platform team owns it through CODEOWNERS, and changes to a standard are reviewed like code.
- Each repo pins a tag (`v3.2.0`, never a branch), so reviews are reproducible. New standards arrive through a version-bump PR, for example from Renovate, that the team can review.
- Each repo picks the packs that fit its stack (`typescript`, `testing`, `api`, …).

The workflow checks out the pinned standards next to the code and passes the path to the action:

```yaml
steps:
  - uses: actions/create-github-app-token@v2   # read access to the standards repo
    id: app
    with:
      app-id: ${{ vars.STANDARDS_APP_ID }}
      private-key: ${{ secrets.STANDARDS_APP_KEY }}
      owner: acme
      repositories: engineering-standards
  - uses: actions/checkout@v7
    with:
      repository: acme/engineering-standards
      ref: v3.2.0
      path: .standards
      token: ${{ steps.app.outputs.token }}
      persist-credentials: false
  - uses: gonzzza/ai-dev-automation/review-action@v1
    with:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      standards-path: .standards
      standards-packs: typescript,testing
      standards-ref: v3.2.0
```

The agent takes the same checkout: `--standards .standards --standards-ref v3.2.0`. Standards are trusted input, so they go in the system prompt, and they must come from a pinned ref or the base branch, never from the PR being reviewed.

## How it stays safe

The agent runs unattended on input that might not be trustworthy, so its limits are enforced in code and unit tested. Its prompt alone doesn't enforce them.

- **No shell.** The agent can read, write and search files, and it has one tool that runs `npm run check`. A permission hook decides every tool call. Writes are allowed only inside the target directory, never in the files that define how the checks run, and never in files that may hold credentials.
- **Independent verification.** After the agent finishes, the harness re-runs the checks. It confirms that git's branch, commit, config and hooks are unchanged, that every changed file is in scope, and that nothing in the diff, PR body or comments looks like a credential. If any check fails, nothing is committed. CI then runs the checks again on a clean checkout.
- **Bounded.** Each run has turn and budget limits. The fix cycle stops after 5 fix commits, or as soon as a finding comes back. It only touches the agent's own branches, and it never merges.
- **Auditable.** Every run has an id that appears in its commits (`Agent-Run` trailer), PR body and comments. It writes a redacted JSONL audit log with the full transcript, every permission decision and a categorized outcome, and CI keeps that log as an artifact. In CI, agent-written tests run in a sandbox that can't reach the log. Metrics come from that log, and the agent can also send OpenTelemetry data to an existing monitoring stack. See [Audit log and monitoring](agent/README.md#audit-log-and-monitoring).
- **Model-written code never runs where the secrets are.** In CI, the tests the agent writes run in a throwaway Docker container with no network, no secrets, no view of the audit log and a read-only `.git`. See [the checks sandbox](agent/README.md#the-checks-sandbox).
- **Untrusted input stays data.** Specs, PR diffs and review findings reach the model as data, never as commands to run. The agent has no shell to run them with, and the review action executes nothing from model output. The workflows use least-privilege permissions.

[`agent/README.md`](agent/README.md) has the full list, including what these defenses don't cover.

## Why two models

The agent that writes the code and the action that reviews it run on different models:

| Role | Model | Set in |
|------|-------|--------|
| Implements specs and fixes review findings | Claude Opus 5.5 | `AGENT_MODEL` in [`ai-review.yml`](.github/workflows/ai-review.yml), `--model` locally |
| Reviews every PR | Claude Sonnet 5.5 | `REVIEW_MODEL` in [`ai-review.yml`](.github/workflows/ai-review.yml) |

**The reason is correlated errors.** A model reviewing its own output tends to repeat its own mistakes. If it misread the spec while writing the code, it misreads it the same way while reviewing it. A different reviewer is the cheapest way to get some independence. The fix job prints a warning if a config change makes the two models the same.

**It has already paid off here.** Opus implemented the rate limiter in [PR #5](https://github.com/gonzzza/ai-dev-automation/pull/5) and noted that a backwards clock jump was harmless. Sonnet's review showed that refill stops until the clock catches up. The agent's own 22 tests passed and missed it.

**Levels of independence**, from least to most:

1. **The same model with a fresh context.** It avoids anchoring on the author's reasoning, but has the same blind spots.
2. **A different model from the same vendor**, which is this repo's setup. It behaves differently, but shares training data with the author, so some blind spots are still correlated.
3. **A model from a different vendor.** This is the most independent option. It costs a second API, key and data-processing agreement, which in an enterprise is a procurement question as much as an engineering one. The review action is a small, separate component, so swapping its provider doesn't touch the agent.

**Which model is stronger is a cost decision.** The review runs on every push of every PR, human PRs included, while the agent runs once per spec. That's why the cheaper, faster model reviews here. Where a missed bug is expensive, such as security-sensitive code, use the stronger model as the reviewer. The fix cycle also benefits from that, because the reviewer decides when the cycle ends.

**Model diversity is one layer, not the safeguard.** Most of the independence comes from checks that aren't models:

- tests, typecheck and lint, re-run by the harness and again by CI on a clean checkout;
- the agent's tool policy and safety gates;
- the human approval before every merge.

The reviewer's findings are advice. The agent may decline a finding with a reason, and a person decides what ships.

## Known limitations

- **Reviewer severity varies between runs.** The same clock bug was rated medium, then low, then medium. The severity threshold decides which findings the agent attempts, not what is safe to merge; the human approval decides that.
- **The sandbox covers the tests, not the agent.** The agent process itself holds the API key and, in CI, the push token. Locally the sandbox is opt-in (`--sandbox docker`, which needs Docker). Without it, agent-written tests run on your machine with a credential-free environment but full network and file access.
- **An agent branch is identified by its name.** The fix cycle runs on any open `agent/*` PR from this repository, and anyone with push access can create such a branch. In an organization, add a branch ruleset that lets only the agent's GitHub App create `agent/**` branches, or have the fix job check that the PR author is that App.
- **This repo's CI fix job doesn't pass `--standards` to the agent yet.** In CI, the review checks PRs against the standards, but the agent fixing the findings only sees the finding text and the cited rule id. Locally, `--standards org-standards` gives the agent the standards in both modes.
- **Cost figures are estimates.** The PR footers and the audit log show the Agent SDK's estimate from token usage at list prices. The review's footer shows token counts only. The [Console](https://console.anthropic.com/settings/usage) has the actual bill.

## Development

```sh
npm ci
npm run check            # lint, typecheck and tests in every workspace: run before every commit
npm test -w agent        # one workspace
npm run build            # review-action bundles to dist/, which is committed
```

Tests are offline and fast. Git, GitHub, the clock and the Claude API are injected and faked, so `npm run check` never calls a real API. [`CLAUDE.md`](CLAUDE.md) has the conventions for people and coding agents working on the repo.
