---
id: TEST-002
title: Tests never call real APIs
severity: high
applies_to: ["**/test/**/*.ts"]
---
Tests inject fakes for every side effect: network clients (GitHub, Anthropic, HTTP), the clock, timers and the environment. A test never reaches a real API, needs a secret, or waits on real time.

**Why:** tests that call real services are slow, flaky, cost money, and fail on forks and offline machines that have no credentials. Worse, a test holding a real key can leak it in logs.

Bad:

```ts
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
await reviewDiff(client, pr, files, opts);
```

Good:

```ts
const client = { beta: { messages: { stream: () => ({ finalMessage: async () => canned }) } } };
await reviewDiff(client, pr, files, opts);
```
