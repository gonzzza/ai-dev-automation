import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStandards } from "../src/index.js";

const ORG_STANDARDS = fileURLToPath(new URL("../../org-standards", import.meta.url));

describe("org-standards/", () => {
  it("AC8: loads without errors, with at least four standards in at least two packs", async () => {
    const standards = await loadStandards(ORG_STANDARDS);
    expect(standards.length).toBeGreaterThanOrEqual(4);
    expect(new Set(standards.map((s) => s.pack)).size).toBeGreaterThanOrEqual(2);
    for (const s of standards) expect(s.body.length).toBeGreaterThan(0);
  });
});
