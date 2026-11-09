import { sleep as defaultSleep } from "./retry.js";

export interface RateLimiterOptions {
  /** Maximum tokens, a positive integer. The bucket starts full. */
  capacity: number;
  /** Tokens added per second, a positive number. Refill is continuous. */
  refillPerSecond: number;
  /** Clock in milliseconds. Injected for tests. Default: `Date.now`. */
  now?: () => number;
  /** Wait function. Injected for tests. Default: `sleep` from `retry.ts`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  /** Take `tokens` if available and return true; otherwise take nothing and return false. */
  tryRemove(tokens?: number): boolean;
  /** Current tokens after refill, never above `capacity`. */
  available(): number;
  /** Milliseconds until `tokens` would be available, 0 if they already are. */
  waitTime(tokens?: number): number;
  /** Wait until `tokens` are available, then take them. */
  acquire(tokens?: number): Promise<void>;
}

/** Tolerance for floating-point error when comparing token counts. */
const EPSILON = 1e-9;

/** Create a token bucket rate limiter. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerSecond, now = Date.now, sleep = defaultSleep } = options;

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new RangeError(`refillPerSecond must be a positive number, got ${refillPerSecond}`);
  }

  let tokens = capacity;
  let last = now();

  const refill = (): void => {
    const current = now();
    if (current > last) {
      tokens = Math.min(capacity, tokens + ((current - last) * refillPerSecond) / 1000);
      last = current;
    }
  };

  const validate = (count: number): void => {
    if (!Number.isFinite(count) || count <= 0 || count > capacity) {
      throw new RangeError(`tokens must be a positive number no greater than capacity (${capacity}), got ${count}`);
    }
  };

  const available = (): number => {
    refill();
    return tokens;
  };

  const waitTime = (count = 1): number => {
    validate(count);
    const deficit = count - available();
    return deficit <= EPSILON ? 0 : (deficit / refillPerSecond) * 1000;
  };

  const tryRemove = (count = 1): boolean => {
    validate(count);
    if (available() + EPSILON < count) return false;
    tokens = Math.max(0, tokens - count);
    return true;
  };

  const acquire = async (count = 1): Promise<void> => {
    validate(count);
    // Loop rather than wait once: a concurrent caller may take the tokens while we sleep.
    for (let ms = waitTime(count); ms > 0; ms = waitTime(count)) {
      await sleep(ms);
    }
    tryRemove(count);
  };

  return { tryRemove, available, waitTime, acquire };
}
