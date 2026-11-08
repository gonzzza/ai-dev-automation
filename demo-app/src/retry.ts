export interface RetryOptions {
  /** Total attempts, including the first one. Default 3. */
  attempts?: number;
  /** Delay before the first retry, in ms. Doubles on each retry. Default 100. */
  baseDelayMs?: number;
  /** Upper bound for a single delay, in ms. Default 5000. */
  maxDelayMs?: number;
  /** Return false to stop retrying on this error. Default: retry every error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Injected for tests. Default: real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Delay before retry number `retry` (1-based), with exponential backoff and a cap. */
export function backoffDelay(retry: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (retry - 1), maxDelayMs);
}

/** Run `fn`, retrying failures with exponential backoff. Rethrows the last error. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    shouldRetry = () => true,
    sleep: wait = sleep,
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts must be a positive integer, got ${attempts}`);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error, attempt)) throw error;
      await wait(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }
}
