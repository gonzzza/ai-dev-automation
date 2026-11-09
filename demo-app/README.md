# demo-app

A deliberately small TypeScript library. It is the codebase the agent in [`../agent`](../agent) works on: specs in [`../specs`](../specs) describe features to add here.

Current contents:

- `retry()` with exponential backoff.
- `createRateLimiter()`, a token bucket rate limiter.

## Rate limiter

`createRateLimiter({ capacity, refillPerSecond })` returns a bucket that starts with `capacity` tokens and refills continuously at `refillPerSecond`. Use `acquire()` to wait for a token, or `tryRemove()` to take one only if it is available right now. Combine it with `retry()` to stay under a rate limit and retry failures:

```ts
import { createRateLimiter, retry } from "demo-app";

// Bursts of up to 10 requests, 5 per second sustained.
const limiter = createRateLimiter({ capacity: 10, refillPerSecond: 5 });

const user = await retry(async () => {
  await limiter.acquire(); // waits until a token is available
  return fetchUser(id);
});

limiter.tryRemove(); // true if a token was taken, false otherwise (takes nothing)
limiter.available(); // current tokens, possibly fractional
limiter.waitTime(3); // ms until 3 tokens are available, 0 if they already are
```

`now` and `sleep` options inject the clock and wait function for tests. Invalid capacities, rates and token counts throw `RangeError`.

```sh
npm test -w demo-app
```
