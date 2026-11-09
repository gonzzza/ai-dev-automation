import { describe, expect, it } from "vitest";
import { FindingSchema, keepKnownRules, parseFailOn, shouldFail, type Finding } from "../src/schema.js";

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

describe("FindingSchema", () => {
  it("AC6: accepts an optional rule", () => {
    expect(FindingSchema.parse({ ...f("low"), rule: "TS-002" }).rule).toBe("TS-002");
    expect(FindingSchema.parse(f("low"))).not.toHaveProperty("rule");
  });
});

describe("keepKnownRules", () => {
  it("AC6: keeps rules naming a sent standard and removes the others, keeping the finding", () => {
    const review = {
      summary: "s",
      findings: [{ ...f("high"), rule: "TS-002" }, { ...f("low"), rule: " TS-002 " }, { ...f("low"), rule: "NOPE-9" }, f("medium")],
    };
    const { findings } = keepKnownRules(review, new Set(["TS-002"]));
    expect(findings).toEqual([{ ...f("high"), rule: "TS-002" }, { ...f("low"), rule: "TS-002" }, f("low"), f("medium")]);
    expect(findings[2]).not.toHaveProperty("rule");
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
