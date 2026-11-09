import { describe, expect, it } from "vitest";
import { createRateLimiter, type RateLimiterOptions } from "../src/rate-limiter.js";

/** A limiter on a fake clock whose sleep advances the clock and records each wait. */
function setup(options: Pick<RateLimiterOptions, "capacity" | "refillPerSecond">) {
  let time = 1_000;
  const sleeps: number[] = [];
  const limiter = createRateLimiter({
    ...options,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  });
  const advance = (ms: number): void => {
    time += ms;
  };
  return { limiter, advance, sleeps };
}

describe("createRateLimiter", () => {
  it("starts full", () => {
    const { limiter } = setup({ capacity: 5, refillPerSecond: 1 });
    expect(limiter.available()).toBe(5);
  });

  it("tryRemove succeeds until empty, then fails without going negative", () => {
    const { limiter } = setup({ capacity: 3, refillPerSecond: 1 });
    expect([limiter.tryRemove(), limiter.tryRemove(), limiter.tryRemove()]).toEqual([true, true, true]);
    expect(limiter.tryRemove()).toBe(false);
    expect(limiter.available()).toBe(0);
  });

  it("tryRemove takes nothing when not enough tokens are available", () => {
    const { limiter } = setup({ capacity: 3, refillPerSecond: 1 });
    expect(limiter.tryRemove(2)).toBe(true);
    expect(limiter.tryRemove(2)).toBe(false);
    expect(limiter.available()).toBe(1);
  });

  it("refills with elapsed time, including fractional tokens", () => {
    const { limiter, advance } = setup({ capacity: 10, refillPerSecond: 2 });
    expect(limiter.tryRemove(10)).toBe(true);
    advance(250);
    expect(limiter.available()).toBeCloseTo(0.5);
    expect(limiter.tryRemove()).toBe(false);
    advance(1_000);
    expect(limiter.available()).toBeCloseTo(2.5);
  });

  it("never refills above capacity", () => {
    const { limiter, advance } = setup({ capacity: 4, refillPerSecond: 3 });
    limiter.tryRemove(1);
    advance(60_000);
    expect(limiter.available()).toBe(4);
  });

  it("waitTime is 0 when enough tokens are available", () => {
    const { limiter } = setup({ capacity: 2, refillPerSecond: 1 });
    expect(limiter.waitTime()).toBe(0);
    expect(limiter.waitTime(2)).toBe(0);
  });

  it("waitTime is the exact time needed for a partially refilled bucket", () => {
    const { limiter, advance } = setup({ capacity: 10, refillPerSecond: 2 });
    limiter.tryRemove(10);
    advance(250);
    expect(limiter.waitTime()).toBeCloseTo(250);
    expect(limiter.waitTime(3)).toBeCloseTo(1_250);
  });

  it("acquire waits exactly waitTime via the injected sleep, then takes the tokens", async () => {
    const { limiter, advance, sleeps } = setup({ capacity: 3, refillPerSecond: 3 });
    limiter.tryRemove(3);
    advance(100);
    const expected = limiter.waitTime(2);
    await limiter.acquire(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeCloseTo(expected);
    expect(limiter.available()).toBeCloseTo(0);
  });

  it("acquire does not sleep when tokens are available", async () => {
    const { limiter, sleeps } = setup({ capacity: 2, refillPerSecond: 1 });
    await limiter.acquire(2);
    expect(sleeps).toEqual([]);
    expect(limiter.available()).toBe(0);
  });

  it("defaults to taking one token", async () => {
    const { limiter } = setup({ capacity: 3, refillPerSecond: 1 });
    limiter.tryRemove();
    await limiter.acquire();
    expect(limiter.available()).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects capacity %s", (capacity) => {
    expect(() => createRateLimiter({ capacity, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ capacity, refillPerSecond: 1 })).toThrow(`capacity must be a positive integer, got ${capacity}`);
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])("rejects refillPerSecond %s", (refillPerSecond) => {
    expect(() => createRateLimiter({ capacity: 1, refillPerSecond })).toThrow(RangeError);
    expect(() => createRateLimiter({ capacity: 1, refillPerSecond })).toThrow(`got ${refillPerSecond}`);
  });

  it.each([0, -1, 6, Number.NaN])("rejects token count %s in every method", async (tokens) => {
    const { limiter } = setup({ capacity: 5, refillPerSecond: 1 });
    const message = `got ${tokens}`;
    expect(() => limiter.tryRemove(tokens)).toThrow(RangeError);
    expect(() => limiter.tryRemove(tokens)).toThrow(message);
    expect(() => limiter.waitTime(tokens)).toThrow(RangeError);
    await expect(limiter.acquire(tokens)).rejects.toThrow(RangeError);
    await expect(limiter.acquire(tokens)).rejects.toThrow(message);
  });
});
