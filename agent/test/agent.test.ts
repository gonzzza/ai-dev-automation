import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildPrompt, describeMessage } from "../src/agent.js";
import { parseSpec } from "../src/spec.js";

const spec = parseSpec("specs/002-x.md", "# X\n\n## Goal\ng\n\n## Requirements\nr\n\n## Acceptance criteria\na\n");

describe("buildPrompt", () => {
  it("embeds the spec and states scope, tools and git rules", () => {
    const prompt = buildPrompt(spec, ["demo-app"]);
    expect(prompt).toContain('<spec path="specs/002-x.md">\n# X');
    expect(prompt).toContain("Only create or edit files under: demo-app");
    expect(prompt).toContain("You have no shell");
    expect(prompt).toContain("Do not commit");
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
});
