import { describe, expect, it } from "vitest";
import { parseFailOn, shouldFail, type Finding } from "../src/schema.js";

const f = (severity: Finding["severity"]): Finding => ({
  path: "a.ts",
  line: 1,
  category: "bug",
  severity,
  title: "t",
  body: "b",
});

describe("parseFailOn", () => {
  it("accepts none, empty and severities case-insensitively", () => {
    expect(parseFailOn("")).toBe("none");
    expect(parseFailOn("None")).toBe("none");
    expect(parseFailOn(" HIGH ")).toBe("high");
  });

  it("rejects unknown values", () => {
    expect(() => parseFailOn("severe")).toThrow(/fail-on must be one of/);
  });
});

describe("shouldFail", () => {
  it("fails only at or above the threshold", () => {
    expect(shouldFail([f("medium")], "high")).toBe(false);
    expect(shouldFail([f("medium"), f("high")], "high")).toBe(true);
    expect(shouldFail([f("critical")], "low")).toBe(true);
  });

  it("never fails when threshold is none", () => {
    expect(shouldFail([f("critical")], "none")).toBe(false);
  });
});
