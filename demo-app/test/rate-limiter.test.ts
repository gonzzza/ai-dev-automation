import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRateLimiter, type RateLimiterOptions } from "../src/rate-limiter.js";

/** A fake clock whose `sleep` advances time instantly and records each wait. */
function fakeTime() {
  const state = { t: 0, sleeps: [] as number[] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
    advance: (ms: number) => {
      state.t += ms;
    },
  };
}

function limiter(capacity: number, refillPerSecond: number) {
  const time = fakeTime();
  const rl = createRateLimiter({ capacity, refillPerSecond, now: time.now, sleep: time.sleep });
  return { rl, time };
}

describe("createRateLimiter", () => {
  it("AC1: a new limiter has capacity tokens available", () => {
    const { rl } = limiter(5, 1);
    expect(rl.available()).toBe(5);
  });

  it("AC2: tryRemove succeeds until the bucket is empty, then fails without going negative", () => {
    const { rl } = limiter(3, 1);
    expect([rl.tryRemove(), rl.tryRemove(), rl.tryRemove()]).toEqual([true, true, true]);
    expect(rl.tryRemove()).toBe(false);
    expect(rl.available()).toBe(0);
  });

  it("AC2: a failed multi-token tryRemove takes nothing", () => {
    const { rl } = limiter(4, 1);
    expect(rl.tryRemove(3)).toBe(true);
    expect(rl.tryRemove(2)).toBe(false);
    expect(rl.available()).toBe(1);
  });

  it("AC3: refills fractional tokens with elapsed time", () => {
    const { rl, time } = limiter(10, 2);
    expect(rl.tryRemove(10)).toBe(true);
    time.advance(250);
    expect(rl.available()).toBeCloseTo(0.5);
    time.advance(500);
    expect(rl.available()).toBeCloseTo(1.5);
    expect(rl.tryRemove()).toBe(true);
    expect(rl.available()).toBeCloseTo(0.5);
  });

  it("AC3: refill never exceeds capacity", () => {
    const { rl, time } = limiter(10, 2);
    rl.tryRemove(4);
    time.advance(60_000);
    expect(rl.available()).toBe(10);
  });

  it("AC3: a clock that steps backwards neither removes tokens nor goes negative", () => {
    const { rl, time } = limiter(4, 2);
    rl.tryRemove(3);
    time.advance(-5_000);
    expect(rl.available()).toBe(1);
    expect(rl.tryRemove(1)).toBe(true);
    time.advance(-1_000);
    expect(rl.available()).toBe(0);
    time.advance(500); // refill resumes from the latest reading: 1 token
    expect(rl.available()).toBeCloseTo(1);
  });

  it("AC4: waitTime is 0 when enough tokens are available", () => {
    const { rl } = limiter(5, 2);
    expect(rl.waitTime()).toBe(0);
    expect(rl.waitTime(5)).toBe(0);
  });

  it("AC4: waitTime returns the exact time needed for a partially refilled bucket", () => {
    const { rl, time } = limiter(5, 2);
    rl.tryRemove(5);
    time.advance(250); // 0.5 tokens
    expect(rl.waitTime(1)).toBeCloseTo(250);
    expect(rl.waitTime(3)).toBeCloseTo(1250);
  });

  it("AC5: acquire waits exactly waitTime via the injected sleep, then takes the tokens", async () => {
    const { rl, time } = limiter(2, 4);
    rl.tryRemove(2);
    time.advance(100); // 0.4 tokens
    const expected = rl.waitTime(1);
    await rl.acquire(1);
    expect(time.state.sleeps).toHaveLength(1);
    expect(time.state.sleeps[0]).toBeCloseTo(expected);
    expect(time.state.sleeps[0]).toBeCloseTo(150);
    expect(rl.available()).toBeCloseTo(0);
  });

  it("AC5: acquire waits again when another caller takes the tokens during its sleep", async () => {
    const time = fakeTime();
    let stolen = false;
    const rl = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: time.now,
      sleep: async (ms) => {
        await time.sleep(ms);
        if (!stolen) {
          stolen = true;
          expect(rl.tryRemove()).toBe(true); // a competing caller wins the refilled token
        }
      },
    });
    rl.tryRemove();
    await rl.acquire();
    expect(time.state.sleeps).toHaveLength(2);
    expect(time.state.sleeps[0]).toBeCloseTo(1000);
    expect(time.state.sleeps[1]).toBeCloseTo(1000);
    expect(rl.available()).toBeCloseTo(0);
  });

  it("AC5: acquire takes available tokens without sleeping", async () => {
    const { rl, time } = limiter(3, 1);
    await rl.acquire(2);
    expect(time.state.sleeps).toEqual([]);
    expect(rl.available()).toBe(1);
  });

  describe("AC6: invalid input throws RangeError", () => {
    const base: RateLimiterOptions = { capacity: 5, refillPerSecond: 1, now: () => 0 };

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("AC6: capacity %s", (capacity) => {
      expect(() => createRateLimiter({ ...base, capacity })).toThrow(RangeError);
      expect(() => createRateLimiter({ ...base, capacity })).toThrow(`capacity must be a positive integer; got ${capacity}`);
    });

    it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])("AC6: refillPerSecond %s", (refillPerSecond) => {
      expect(() => createRateLimiter({ ...base, refillPerSecond })).toThrow(RangeError);
      expect(() => createRateLimiter({ ...base, refillPerSecond })).toThrow(`got ${refillPerSecond}`);
    });

    it.each([0, -1, 6, Number.NaN])("AC6: token count %s", async (tokens) => {
      const rl = createRateLimiter(base);
      expect(() => rl.tryRemove(tokens)).toThrow(RangeError);
      expect(() => rl.tryRemove(tokens)).toThrow(`got ${tokens}`);
      expect(() => rl.waitTime(tokens)).toThrow(RangeError);
      await expect(rl.acquire(tokens)).rejects.toThrow(RangeError);
      expect(rl.available()).toBe(5);
    });
  });

  it("AC7: a long acquire completes instantly with the injected clock and sleep", async () => {
    const { rl, time } = limiter(1, 1 / 3600); // one token per hour
    rl.tryRemove();
    const started = performance.now();
    await rl.acquire();
    expect(time.state.sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(3_600_000);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("AC8: README documents the limiter with an example", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("createRateLimiter(");
    expect(readme).toContain("acquire(");
  });
});
