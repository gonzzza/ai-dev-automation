import { describe, expect, it } from "vitest";
import { selectStandards, standardSize, type Standard } from "../src/index.js";

const standard = (over: Partial<Standard>): Standard => ({
  id: "TS-1",
  title: "Title",
  severity: "medium",
  appliesTo: [],
  use: ["agent", "review"],
  pack: "typescript",
  path: "org-standards/typescript/ts-1.md",
  body: "Body.",
  ...over,
});

const ids = (list: Standard[]) => list.map((s) => s.id);
const BIG = 1_000_000;

describe("selectStandards", () => {
  it("AC4: keeps standards for the requested use whose globs match at least one path", () => {
    const standards = [
      standard({ id: "TS-1", appliesTo: ["**/src/**/*.ts"] }),
      standard({ id: "TS-2", appliesTo: ["**/*.py"] }),
      standard({ id: "TS-3", appliesTo: ["docs/**", "**/test/**/*.test.ts"] }),
      standard({ id: "TS-4", use: ["agent"] }),
      standard({ id: "TS-5", use: ["review"] }),
    ];
    const { selected, dropped } = selectStandards(standards, {
      use: "review",
      paths: ["review-action/src/run.ts", "review-action/test/run.test.ts"],
      maxChars: BIG,
    });
    expect(ids(selected)).toEqual(["TS-1", "TS-3", "TS-5"]);
    expect(dropped).toEqual([]);
  });

  it("AC4: an empty applies_to matches every path", () => {
    const { selected } = selectStandards([standard({ id: "ANY-1" })], { use: "agent", paths: ["README.md"], maxChars: BIG });
    expect(ids(selected)).toEqual(["ANY-1"]);
  });

  it("AC4: orders by severity, most severe first, then by id", () => {
    const standards = [
      standard({ id: "TS-10", severity: "high" }),
      standard({ id: "A-1", severity: "low" }),
      standard({ id: "TS-2", severity: "high" }),
      standard({ id: "SEC-1", severity: "critical" }),
      standard({ id: "B-1", severity: "medium" }),
    ];
    const { selected } = selectStandards(standards, { use: "review", paths: ["a.ts"], maxChars: BIG });
    expect(ids(selected)).toEqual(["SEC-1", "TS-2", "TS-10", "B-1", "A-1"]);
  });

  it("AC4: drops from the least severe end until the selection fits maxChars", () => {
    const critical = standard({ id: "C-1", severity: "critical", body: "x".repeat(100) });
    const high = standard({ id: "H-1", severity: "high", body: "x".repeat(100) });
    const low1 = standard({ id: "L-1", severity: "low", body: "x".repeat(100) });
    const low2 = standard({ id: "L-2", severity: "low", body: "x".repeat(100) });
    const size = standardSize(critical); // all four are the same size
    expect(size).toBe("C-1".length + "Title".length + 100);

    const { selected, dropped } = selectStandards([low2, high, low1, critical], { use: "review", paths: ["a.ts"], maxChars: size * 2 + 1 });
    expect(ids(selected)).toEqual(["C-1", "H-1"]);
    expect(ids(dropped)).toEqual(["L-1", "L-2"]);
  });

  it("AC4: keeps everything when it fits exactly", () => {
    const list = [standard({ id: "A-1" }), standard({ id: "A-2" })];
    const total = list.reduce((sum, s) => sum + standardSize(s), 0);
    expect(selectStandards(list, { use: "review", paths: ["a.ts"], maxChars: total }).dropped).toEqual([]);
  });

  it("AC4: drops everything when even the most severe one does not fit", () => {
    const { selected, dropped } = selectStandards([standard({ body: "x".repeat(50) })], { use: "review", paths: ["a"], maxChars: 10 });
    expect(selected).toEqual([]);
    expect(ids(dropped)).toEqual(["TS-1"]);
  });

  it.each([0, -1, 1.5, Number.NaN])("throws RangeError for maxChars %s", (maxChars) => {
    expect(() => selectStandards([], { use: "review", paths: [], maxChars })).toThrow(RangeError);
  });
});

// Spec 003: the agent selects without paths, since it can't know which files it will create.
describe("selectStandards without paths", () => {
  it("AC1: keeps every standard for the requested use, whatever its applies_to", () => {
    const standards = [
      standard({ id: "TS-1", appliesTo: ["**/src/**/*.ts"] }),
      standard({ id: "TS-2", appliesTo: ["**/*.py"] }),
      standard({ id: "TS-3" }),
      standard({ id: "TS-4", use: ["review"], appliesTo: ["**/*.ts"] }),
      standard({ id: "TS-5", use: ["agent"] }),
    ];
    const { selected, dropped } = selectStandards(standards, { use: "agent", maxChars: BIG });
    expect(ids(selected)).toEqual(["TS-1", "TS-2", "TS-3", "TS-5"]);
    expect(dropped).toEqual([]);
  });

  it("AC1: an empty paths list still checks applies_to, as before", () => {
    const standards = [standard({ id: "TS-1", appliesTo: ["**/*.ts"] }), standard({ id: "TS-2" })];
    expect(ids(selectStandards(standards, { use: "agent", paths: [], maxChars: BIG }).selected)).toEqual(["TS-2"]);
  });

  it("AC1: orders by severity, most severe first, then by id", () => {
    const standards = [
      standard({ id: "TS-10", severity: "high", appliesTo: ["**/*.py"] }),
      standard({ id: "A-1", severity: "low" }),
      standard({ id: "TS-2", severity: "high", appliesTo: ["docs/**"] }),
      standard({ id: "SEC-1", severity: "critical", appliesTo: ["**/*.ts"] }),
    ];
    expect(ids(selectStandards(standards, { use: "agent", maxChars: BIG }).selected)).toEqual(["SEC-1", "TS-2", "TS-10", "A-1"]);
  });

  it("AC1: drops from the least severe end until the selection fits maxChars", () => {
    const critical = standard({ id: "C-1", severity: "critical", appliesTo: ["**/*.py"], body: "x".repeat(100) });
    const high = standard({ id: "H-1", severity: "high", appliesTo: ["docs/**"], body: "x".repeat(100) });
    const low = standard({ id: "L-1", severity: "low", body: "x".repeat(100) });
    const size = standardSize(critical);
    const { selected, dropped } = selectStandards([low, high, critical], { use: "agent", maxChars: size * 2 });
    expect(ids(selected)).toEqual(["C-1", "H-1"]);
    expect(ids(dropped)).toEqual(["L-1"]);
  });

  it.each([0, -1, 1.5, Number.NaN])("AC1: throws RangeError for maxChars %s", (maxChars) => {
    expect(() => selectStandards([], { use: "agent", maxChars })).toThrow(RangeError);
  });
});
