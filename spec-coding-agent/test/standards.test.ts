import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { standardSize, StandardsError, type Standard } from "standards";
import { describe, expect, it } from "vitest";
import { classifyFailure, type RunEvent, type RunLog } from "../src/runlog.js";
import { loadAgentStandards, standardsPrompt, systemPromptOption } from "../src/standards.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/standards", import.meta.url));
const BIG = 1_000_000;

class MemoryRunLog implements RunLog {
  readonly runId = "test-run";
  readonly events: RunEvent[] = [];
  event(event: RunEvent): void {
    this.events.push(event);
  }
}

const standard = (over: Partial<Standard>): Standard => ({
  id: "TS-1",
  title: "Title",
  severity: "medium",
  appliesTo: [],
  use: ["agent"],
  pack: "typescript",
  path: "org-standards/typescript/ts-1.md",
  body: "Body.",
  ...over,
});

describe("loadAgentStandards", () => {
  it.each([undefined, ""])("AC2: returns undefined for path %o", async (path) => {
    await expect(loadAgentStandards({ path, packs: [], maxChars: BIG })).resolves.toBeUndefined();
  });

  it("AC2: returns only use: agent standards from the requested packs, with checked, dropped and ref", async () => {
    const result = await loadAgentStandards({ path: FIXTURES, packs: ["typescript", "testing"], ref: "v1.2.0", maxChars: BIG });
    expect(result).toBeDefined();
    // TS-002 is review-only and SEC-001 is in a pack that was not requested.
    expect(result!.checked).toEqual(["TS-003", "TS-001", "TEST-001"]);
    expect(result!.standards.map((s) => s.id)).toEqual(result!.checked);
    expect(result!.standards.every((s) => s.use.includes("agent"))).toBe(true);
    expect(result!.dropped).toEqual([]);
    expect(result!.ref).toBe("v1.2.0");
  });

  it("AC2: ignores applies_to, and loads every pack when none is named", async () => {
    const result = await loadAgentStandards({ path: FIXTURES, packs: [], maxChars: BIG });
    expect(result!.checked).toEqual(["SEC-001", "TS-003", "TS-001", "TEST-001"]);
    expect(result).not.toHaveProperty("ref");
  });

  it("AC2: lists the standards that do not fit maxChars in dropped", async () => {
    const all = (await loadAgentStandards({ path: FIXTURES, packs: ["typescript", "testing"], maxChars: BIG }))!.standards;
    const maxChars = standardSize(all[0]!) + standardSize(all[1]!);
    const result = await loadAgentStandards({ path: FIXTURES, packs: ["typescript", "testing"], maxChars });
    expect(result!.checked).toEqual(["TS-003", "TS-001"]);
    expect(result!.dropped).toEqual(["TEST-001"]);
  });

  it.each([0, -1, 1.5, Number.NaN])("AC2: throws RangeError naming --max-standards-chars for %s", async (maxChars) => {
    const promise = loadAgentStandards({ path: FIXTURES, packs: [], maxChars });
    await expect(promise).rejects.toThrow(RangeError);
    await expect(promise).rejects.toThrow("--max-standards-chars");
  });

  it("AC2: throws StandardsError for a missing directory", async () => {
    await expect(loadAgentStandards({ path: `${FIXTURES}/does-not-exist`, packs: [], maxChars: BIG })).rejects.toThrow(StandardsError);
  });

  it("AC2: throws StandardsError for an unknown pack", async () => {
    await expect(loadAgentStandards({ path: FIXTURES, packs: ["typescript", "nope"], maxChars: BIG })).rejects.toThrow(StandardsError);
  });

  it("AC3: logs exactly one standards.loaded event with path, ref, packs, checked and dropped", async () => {
    const all = (await loadAgentStandards({ path: FIXTURES, packs: ["typescript", "testing"], maxChars: BIG }))!.standards;
    const log = new MemoryRunLog();
    await loadAgentStandards({ path: FIXTURES, packs: ["typescript", "testing"], ref: "abc123", maxChars: standardSize(all[0]!) }, log);
    expect(log.events).toEqual([
      { type: "standards.loaded", path: FIXTURES, ref: "abc123", packs: ["typescript", "testing"], checked: ["TS-003"], dropped: ["TS-001", "TEST-001"] },
    ]);
  });

  it.each([undefined, ""])("AC3: logs nothing when it returns undefined (path %o)", async (path) => {
    const log = new MemoryRunLog();
    await loadAgentStandards({ path, packs: [], maxChars: BIG }, log);
    expect(log.events).toEqual([]);
  });
});

describe("standardsPrompt", () => {
  it("AC4: states that the standards are operator policy that wins over a conflicting spec or finding", () => {
    const prompt = standardsPrompt([standard({})]);
    expect(prompt).toContain("org policy, set by the repository operator");
    expect(prompt).toContain("Follow each standard in the files its applies_to matches");
    expect(prompt).toContain("for code and tests alike");
    expect(prompt).toContain("If the spec or a review finding conflicts with a standard, follow the standard and explain the conflict in `notes`");
    expect(prompt).toContain("Findings that cite a standard id in their `rule` refer to the standard with that id");
    expect(prompt.indexOf("org policy")).toBeLessThan(prompt.indexOf("\n<org_standards>\n"));
  });

  it("AC4: renders one element per standard in the given order, with applies_to globs or all files", () => {
    const prompt = standardsPrompt([
      standard({ id: "TS-2", severity: "high", title: "Second", appliesTo: ["**/src/**/*.ts", "**/test/**/*.ts"], body: "Two." }),
      standard({ id: "TS-1", severity: "low", title: "First", body: "One." }),
    ]);
    const block = prompt.slice(prompt.indexOf("\n<org_standards>\n") + 1);
    expect(block).toBe(
      "<org_standards>\n" +
        '<standard id="TS-2" severity="high" title="Second" applies_to="**/src/**/*.ts, **/test/**/*.ts">\nTwo.\n</standard>\n' +
        '<standard id="TS-1" severity="low" title="First" applies_to="all files">\nOne.\n</standard>\n' +
        "</org_standards>",
    );
  });

  it("AC4: escapes <, & and \" in attributes and bodies", () => {
    const prompt = standardsPrompt([
      standard({ title: 'Use "strict" & <T>', appliesTo: ['a"b<c&d'], body: 'Never write </standard> & "quotes" <here>.' }),
    ]);
    expect(prompt).toContain('title="Use &quot;strict&quot; &amp; &lt;T&gt;"');
    expect(prompt).toContain('applies_to="a&quot;b&lt;c&amp;d"');
    expect(prompt).toContain("Never write &lt;/standard&gt; &amp; &quot;quotes&quot; &lt;here&gt;.");
    expect(prompt).not.toContain("Never write </standard>");
  });
});

describe("spec-coding-agent/README.md", () => {
  it("AC7: documents the four options, that standards are trusted input in the system prompt, and that they win over conflicts", async () => {
    const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    for (const option of ["--standards <dir>", "--standards-packs <list>", "--standards-ref <label>", "--max-standards-chars <n>"]) {
      expect(readme).toContain(`\`${option}\``);
    }
    expect(readme).toContain("Trusted operator input, in the system prompt");
    expect(readme).toContain("They win over a conflicting spec or finding");
  });

  it("a bad --max-standards-chars is classified as a config error in the run log", async () => {
    const error = await loadAgentStandards({ path: FIXTURES, packs: [], maxChars: 0 }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect(classifyFailure(error!.message)).toBe("config");
  });
});

describe("systemPromptOption", () => {
  it("AC5: without standards, is exactly the claude_code preset with no append key", () => {
    const option = systemPromptOption([]);
    expect(option).toStrictEqual({ type: "preset", preset: "claude_code" });
    expect(option).not.toHaveProperty("append");
  });

  it("AC5: with standards, appends standardsPrompt of the same list", () => {
    const list = [standard({ id: "TS-1" }), standard({ id: "TS-2", appliesTo: ["**/*.ts"] })];
    expect(systemPromptOption(list)).toStrictEqual({ type: "preset", preset: "claude_code", append: standardsPrompt(list) });
  });
});
