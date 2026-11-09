import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStandards, StandardsError } from "../src/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const VALID = fixture("valid");

describe("loadStandards", () => {
  it("AC3: reads every pack, ignoring non-.md files, nested directories and the top-level README", async () => {
    const standards = await loadStandards(VALID);
    expect(standards.map((s) => [s.pack, s.id])).toEqual([
      ["testing", "TEST-001"],
      ["typescript", "TS-001"],
      ["typescript", "TS-002"],
    ]);
    expect(standards[1]).toMatchObject({
      title: "No any in exported signatures",
      severity: "medium",
      appliesTo: ["**/src/**/*.ts"],
      use: ["agent", "review"],
      path: join(VALID, "typescript", "ts-001.md"),
      body: "Exported functions spell out their types.",
    });
  });

  it("AC3: reads only the named packs", async () => {
    const standards = await loadStandards(VALID, ["typescript"]);
    expect(standards.map((s) => s.id)).toEqual(["TS-001", "TS-002"]);
  });

  it("AC3: reads every pack when the pack list is empty", async () => {
    expect(await loadStandards(VALID, [])).toHaveLength(3);
  });

  it("AC3: throws StandardsError for a missing directory", async () => {
    const missing = fixture("does-not-exist");
    await expect(loadStandards(missing)).rejects.toThrow(StandardsError);
    await expect(loadStandards(missing)).rejects.toThrow(`${missing}: standards directory does not exist`);
  });

  it("AC3: throws StandardsError for an unknown pack, listing the available ones", async () => {
    const error = await loadStandards(VALID, ["typescript", "security"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StandardsError);
    expect((error as Error).message).toBe(`${VALID}: unknown pack "security"; available packs: testing, typescript`);
  });

  it("AC3: throws StandardsError for an id used in two files", async () => {
    const dir = fixture("duplicate");
    const error = await loadStandards(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StandardsError);
    expect((error as Error).message).toBe(`${join(dir, "b", "two.md")}: duplicate id "DUP-1", also used in ${join(dir, "a", "one.md")}`);
  });

  it("AC3: passes on parse errors with the file path and line", async () => {
    const dir = fixture("invalid");
    await expect(loadStandards(dir)).rejects.toThrow(`${join(dir, "broken", "bad-severity.md")}:4: severity must be one of`);
  });
});
