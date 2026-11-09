---
id: TS-002
title: Inject clocks and timers
severity: medium
applies_to: ["**/src/**/*.ts"]
---
Code that reads the time or waits takes `now` / `sleep` as options, defaulting to `Date.now` and a `setTimeout`-based sleep. It does not call `Date.now()`, `new Date()`, `setTimeout` or `setInterval` directly in logic that tests need to exercise.

**Why:** tests of time-dependent code (rate limiters, retries, expiry) must run fast and deterministically. Without injection they either sleep for real, which makes the suite slow, or rely on global fake timers, which leak between tests.

Bad:

```ts
export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  await new Promise((r) => setTimeout(r, 1000));
  ...
}
```

Good:

```ts
export async function retry<T>(fn: () => Promise<T>, { sleep = defaultSleep }: RetryOptions = {}): Promise<T> {
  await sleep(1000);
  ...
}
```
