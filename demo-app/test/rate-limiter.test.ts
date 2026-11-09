import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, type RateLimiterOptions } from "../src/index.js";

/** A limiter on a fake clock whose `sleep` advances that clock instead of waiting. */
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
  return { limiter, sleeps, advance: (ms: number) => void (time += ms) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRateLimiter", () => {
  it("AC1: a new limiter has capacity tokens available", () => {
    const { limiter } = setup({ capacity: 5, refillPerSecond: 1 });
    expect(limiter.available()).toBe(5);
  });

  it("AC2: tryRemove succeeds until the bucket is empty, then fails without going negative", () => {
    const { limiter } = setup({ capacity: 3, refillPerSecond: 1 });
    expect([limiter.tryRemove(), limiter.tryRemove(), limiter.tryRemove()]).toEqual([true, true, true]);
    expect(limiter.tryRemove()).toBe(false);
    expect(limiter.available()).toBe(0);
  });

  it("AC2: a failed tryRemove takes nothing", () => {
    const { limiter } = setup({ capacity: 3, refillPerSecond: 1 });
    expect(limiter.tryRemove(2)).toBe(true);
    expect(limiter.tryRemove(2)).toBe(false);
    expect(limiter.available()).toBe(1);
    expect(limiter.tryRemove(1)).toBe(true);
  });

  it("AC3: refills with elapsed time, including fractional tokens", () => {
    const { limiter, advance } = setup({ capacity: 10, refillPerSecond: 2 });
    limiter.tryRemove(10);
    advance(250);
    expect(limiter.available()).toBe(0.5);
    expect(limiter.tryRemove()).toBe(false);
    advance(250);
    expect(limiter.available()).toBe(1);
    expect(limiter.tryRemove()).toBe(true);
  });

  it("AC3: never refills above capacity", () => {
    const { limiter, advance } = setup({ capacity: 4, refillPerSecond: 2 });
    limiter.tryRemove(1);
    advance(60_000);
    expect(limiter.available()).toBe(4);
  });

  it("AC4: waitTime returns the exact time needed for a partially refilled bucket", () => {
    const { limiter, advance } = setup({ capacity: 4, refillPerSecond: 2 });
    limiter.tryRemove(4);
    advance(250);
    expect(limiter.waitTime()).toBe(250);
    expect(limiter.waitTime(3)).toBe(1250);
  });

  it("AC4: waitTime returns 0 when enough tokens are available", () => {
    const { limiter } = setup({ capacity: 4, refillPerSecond: 2 });
    expect(limiter.waitTime()).toBe(0);
    expect(limiter.waitTime(4)).toBe(0);
  });

  it("AC5: acquire waits exactly waitTime via the injected sleep, then takes the tokens", async () => {
    const { limiter, sleeps, advance } = setup({ capacity: 4, refillPerSecond: 2 });
    limiter.tryRemove(4);
    advance(250);
    const expected = limiter.waitTime(2);
    await limiter.acquire(2);
    expect(sleeps).toEqual([expected]);
    expect(expected).toBe(750);
    expect(limiter.available()).toBe(0);
  });

  it("AC5: acquire takes available tokens without sleeping", async () => {
    const { limiter, sleeps } = setup({ capacity: 4, refillPerSecond: 2 });
    await limiter.acquire(3);
    expect(sleeps).toEqual([]);
    expect(limiter.available()).toBe(1);
  });

  it("AC5: concurrent acquire calls on an empty bucket wait in turn and never overdraw", async () => {
    // Sleeps stay pending until the test advances the fake clock past their deadline,
    // so both callers really are asleep at the same time.
    let time = 0;
    const sleeps: number[] = [];
    const pending: { until: number; resolve: () => void }[] = [];
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise<void>((resolve) => pending.push({ until: time + ms, resolve }));
      },
    });
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    expect(limiter.tryRemove()).toBe(true);
    const completedAt: number[] = [];
    const both = Promise.all([
      limiter.acquire().then(() => void completedAt.push(time)),
      limiter.acquire().then(() => void completedAt.push(time)),
    ]);

    const balances: number[] = [];
    await flush();
    for (let steps = 0; pending.length > 0 && steps < 10; steps++) {
      pending.sort((a, b) => a.until - b.until);
      const next = pending.shift()!;
      time = next.until;
      next.resolve();
      await flush();
      balances.push(limiter.available());
    }
    await both;

    // Ordering between the two callers is out of scope; only the timing is checked.
    expect(completedAt).toEqual([1000, 2000]);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(Math.min(...balances)).toBeGreaterThanOrEqual(0);
    expect(limiter.available()).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN])("AC6: rejects capacity %s", (capacity) => {
    expect(() => createRateLimiter({ capacity, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ capacity, refillPerSecond: 1 })).toThrow(`capacity must be a positive integer; got ${capacity}`);
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])("AC6: rejects refillPerSecond %s", (refillPerSecond) => {
    expect(() => createRateLimiter({ capacity: 1, refillPerSecond })).toThrow(RangeError);
    expect(() => createRateLimiter({ capacity: 1, refillPerSecond })).toThrow(`got ${refillPerSecond}`);
  });

  it.each([0, -1, Number.NaN, 6])("AC6: rejects a token count of %s", async (tokens) => {
    const { limiter } = setup({ capacity: 5, refillPerSecond: 1 });
    expect(() => limiter.tryRemove(tokens)).toThrow(RangeError);
    expect(() => limiter.tryRemove(tokens)).toThrow(`got ${tokens}`);
    expect(() => limiter.waitTime(tokens)).toThrow(RangeError);
    await expect(limiter.acquire(tokens)).rejects.toThrow(RangeError);
    expect(limiter.available()).toBe(5);
  });

  it("AC7: uses only the injected clock and sleep, never real timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const dateNowSpy = vi.spyOn(Date, "now");
    const { limiter, sleeps } = setup({ capacity: 1, refillPerSecond: 1 });
    await limiter.acquire();
    await limiter.acquire(); // needs 1 s of fake time
    expect(sleeps).toEqual([1000]);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(dateNowSpy).not.toHaveBeenCalled();
  });

  it("AC8: the README documents the limiter with an example", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("createRateLimiter(");
    expect(readme).toContain("acquire(");
  });
});
