import { describe, expect, it, vi } from "vitest";
import { backoffDelay, retry } from "../src/retry.js";

const noWait = () => Promise.resolve();

describe("backoffDelay", () => {
  it("doubles each retry and respects the cap", () => {
    expect([1, 2, 3, 4].map((r) => backoffDelay(r, 100, 500))).toEqual([100, 200, 400, 500]);
  });
});

describe("retry", () => {
  it("returns the first successful result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");
    await expect(retry(fn, { sleep: noWait })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last error after all attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("down"));
    await expect(retry(fn, { attempts: 3, sleep: noWait })).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops early when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(retry(fn, { shouldRetry: () => false, sleep: noWait })).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits with exponential backoff between attempts", async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await retry(fn, { attempts: 4, baseDelayMs: 10, sleep: async (ms) => void waits.push(ms) }).catch(() => {});
    expect(waits).toEqual([10, 20, 40]);
  });

  it("rejects invalid attempts", async () => {
    await expect(retry(() => Promise.resolve(1), { attempts: 0 })).rejects.toThrow(RangeError);
  });
});
