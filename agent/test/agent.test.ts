import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_REPORT_JSON_SCHEMA, buildPrompt, describeMessage, loadPromptTemplate } from "../src/agent.js";
import { parseSpec } from "../src/spec.js";

const spec = parseSpec("specs/002-x.md", "# X\n\n## Goal\ng\n\n## Requirements\nr\n\n## Acceptance criteria\na\n");

describe("buildPrompt", () => {
  it("fills prompt.md with the spec and states scope, tools and git rules", async () => {
    const prompt = buildPrompt(await loadPromptTemplate(), spec, ["demo-app", "specs"]);
    expect(prompt).toContain('<spec path="specs/002-x.md">\n# X');
    expect(prompt).toContain("Only create or edit files under: demo-app, specs");
    expect(prompt).toContain("You have no shell");
    expect(prompt).toContain("Do not commit");
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(prompt.endsWith("</spec>")).toBe(true);
  });

  it("does not expand placeholder-like text or $ patterns inside the spec", () => {
    const tricky = { ...spec, body: "use {{writableDirs}} and $& literally" };
    expect(buildPrompt("<spec>{{specBody}}</spec>", tricky, ["demo-app"])).toBe(
      "<spec>use {{writableDirs}} and $& literally</spec>",
    );
  });

  it("rejects unknown placeholders in the template", () => {
    expect(() => buildPrompt("Hi {{nope}}", spec, ["demo-app"])).toThrow("Unknown placeholder {{nope}}");
  });
});

describe("describeMessage", () => {
  it("summarizes tool calls and ignores other messages", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the code." },
          { type: "tool_use", id: "1", name: "Read", input: { file_path: "demo-app/src/retry.ts" } },
          { type: "tool_use", id: "2", name: "mcp__repo__run_checks", input: {} },
        ],
      },
    } as unknown as SDKMessage;
    expect(describeMessage(message)).toBe("  → Read demo-app/src/retry.ts\n  → run_checks");
    expect(describeMessage({ type: "system" } as unknown as SDKMessage)).toBeUndefined();
  });

  it("shows absolute paths relative to the repo root", () => {
    const root = resolve("repo");
    const message = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "1", name: "Write", input: { file_path: join(root, "demo-app", "src", "a.ts") } }] },
    } as unknown as SDKMessage;
    expect(describeMessage(message, root)).toBe("  → Write demo-app/src/a.ts");
  });
});

describe("AGENT_REPORT_JSON_SCHEMA", () => {
  it("is draft-07, which the Claude Code CLI accepts, and requires every report field", () => {
    expect(AGENT_REPORT_JSON_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(AGENT_REPORT_JSON_SCHEMA.required).toEqual(["plan", "summary", "testing", "checksPassed", "notes"]);
  });
});
