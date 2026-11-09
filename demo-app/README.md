# demo-app

A deliberately small TypeScript library. It is the codebase the agent in [`../agent`](../agent) works on: specs in [`../specs`](../specs) describe features to add here.

Current contents:

- `retry()` with exponential backoff.
- `createRateLimiter()`, a token bucket rate limiter.

## Rate limiter

`createRateLimiter({ capacity, refillPerSecond })` returns a bucket that starts with `capacity` tokens and refills continuously at `refillPerSecond`. It has four methods:

- `tryRemove(n)` takes the tokens and returns `true` if they are available, or takes nothing and returns `false`.
- `available()` returns the current token count.
- `waitTime(n)` returns the milliseconds until `n` tokens are available.
- `acquire(n)` waits for the tokens, then takes them.

`n` defaults to 1. Invalid options or token counts throw `RangeError`. You can pass `now` and `sleep` to inject a clock and a wait function, for example in tests.

It works together with `retry()`: the limiter keeps you under the rate limit, and `retry()` handles failures.

```ts
import { createRateLimiter, retry } from "demo-app";

const limiter = createRateLimiter({ capacity: 10, refillPerSecond: 5 }); // bursts of 10, 5 req/s sustained

const data = await retry(async () => {
  await limiter.acquire();
  return fetch("https://api.example.com/items").then((r) => r.json());
});
```

```sh
npm test -w demo-app
```
