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

Outputs: `findings` (count) and `highest-severity`.

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
