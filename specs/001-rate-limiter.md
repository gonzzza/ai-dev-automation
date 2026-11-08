# Add a token bucket rate limiter to demo-app

## Goal
Callers of external APIs need to stay under rate limits as well as retry failures. `demo-app` already has `retry()`; add a small, dependency-free rate limiter next to it that works well with it.

## Requirements
- New module `demo-app/src/rate-limiter.ts`, exported from `demo-app/src/index.ts`.
- `createRateLimiter(options)` returns a token bucket limiter. Options:
  - `capacity`: maximum tokens, a positive integer. The bucket starts full.
  - `refillPerSecond`: tokens added per second, a positive number. Refill is continuous, so fractional tokens accumulate.
  - `now` (optional): clock in milliseconds, injectable for tests. Defaults to `Date.now`.
  - `sleep` (optional): injectable wait function. Defaults to the `sleep` exported by `retry.ts`.
- The limiter has:
  - `tryRemove(tokens = 1): boolean`. Takes the tokens and returns true if available, otherwise returns false and takes nothing.
  - `available(): number`. Current tokens after refill, never above `capacity`.
  - `waitTime(tokens = 1): number`. Milliseconds until `tokens` would be available, 0 if they already are.
  - `acquire(tokens = 1): Promise<void>`. Waits until the tokens are available, then takes them.
- Invalid options or token counts throw `RangeError` with a message naming the bad value: non-positive capacity or rate, non-integer capacity, and token counts that are not positive or exceed `capacity`, since those could never succeed.

## Acceptance criteria
- A new limiter has `capacity` tokens available.
- `tryRemove` succeeds until the bucket is empty, then fails without going negative.
- Tokens refill with elapsed time at `refillPerSecond`, including fractional amounts, and never exceed `capacity`.
- `waitTime` returns the exact time needed for a partially refilled bucket, and 0 when enough tokens are available.
- `acquire` waits exactly `waitTime` via the injected `sleep`, then takes the tokens.
- Every invalid input listed above throws `RangeError`.
- Tests use the injected clock and sleep only, with no real timers, and run in milliseconds.
- `demo-app/README.md` documents the limiter with a short example.

## Out of scope
- Sharing a limiter across processes or machines.
- Sliding-window or leaky-bucket algorithms.
- Fairness or ordering between concurrent `acquire` calls.
