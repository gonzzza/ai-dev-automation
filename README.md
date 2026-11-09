# ai-code-review

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
