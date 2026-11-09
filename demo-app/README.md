# demo-app

A deliberately small TypeScript library. It is the codebase the agent in [`../agent`](../agent) works on: specs in [`../specs`](../specs) describe features to add here.

Current contents: `retry()` with exponential backoff, and `createRateLimiter()`, a token bucket rate limiter.

## Rate limiter

`createRateLimiter({ capacity, refillPerSecond })` returns a token bucket that starts full and refills continuously. `tryRemove(n)` takes tokens without waiting, `available()` and `waitTime(n)` report state, and `acquire(n)` waits until tokens are free. Pass `now` and `sleep` to control time in tests. Invalid options or token counts throw `RangeError`.

```ts
import { createRateLimiter, retry } from "demo-app";

// At most 5 requests in a burst, then 2 per second.
const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 2 });

const data = await retry(async () => {
  await limiter.acquire();
  return fetchFromApi();
});
```

## Tests

```sh
npm test -w demo-app
```
