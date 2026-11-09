import { sleep as defaultSleep } from "./retry.js";

export interface RateLimiterOptions {
  /** Maximum tokens, a positive integer. The bucket starts full. */
  capacity: number;
  /** Tokens added per second, a positive number. Refill is continuous. */
  refillPerSecond: number;
  /** Clock in milliseconds. Injected for tests. Default `Date.now`. */
  now?: () => number;
  /** Wait function. Injected for tests. Default: the `sleep` from `retry.ts`. */
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

/** Absorbs floating-point error so a wait of exactly `waitTime` always succeeds. */
const EPSILON = 1e-9;

/** Create a token bucket rate limiter. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerSecond, now = Date.now, sleep = defaultSleep } = options;

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(`capacity must be a positive integer; got ${capacity}`);
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new RangeError(`refillPerSecond must be a positive number; got ${refillPerSecond}`);
  }

  let tokens = capacity;
  let lastRefill = now();

  const refill = (): void => {
    const current = now();
    const elapsedMs = Math.max(0, current - lastRefill);
    tokens = Math.min(capacity, tokens + (elapsedMs * refillPerSecond) / 1000);
    lastRefill = current;
  };

  const checkTokens = (count: number): void => {
    if (!Number.isFinite(count) || count <= 0 || count > capacity) {
      throw new RangeError(`tokens must be a positive number no greater than capacity (${capacity}); got ${count}`);
    }
  };

  const tryRemove = (count = 1): boolean => {
    checkTokens(count);
    refill();
    if (tokens + EPSILON < count) return false;
    tokens = Math.max(0, tokens - count);
    return true;
  };

  const available = (): number => {
    refill();
    return tokens;
  };

  const waitTime = (count = 1): number => {
    checkTokens(count);
    refill();
    const deficit = count - tokens;
    return deficit <= EPSILON ? 0 : (deficit / refillPerSecond) * 1000;
  };

  const acquire = async (count = 1): Promise<void> => {
    checkTokens(count);
    // Loop rather than assume one wait suffices: another caller may take tokens meanwhile.
    while (!tryRemove(count)) {
      await sleep(waitTime(count));
    }
  };

  return { tryRemove, available, waitTime, acquire };
}
