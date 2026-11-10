import { describe, expect, it } from "vitest";
import { parsePrTemplate, prTemplatePrompt, scanMarkdown, type PrTemplate } from "../src/template.js";

const headings = (text: string) => parsePrTemplate(text)?.sections.map((s) => s.heading);

describe("parsePrTemplate", () => {
  it("AC2: returns the sections in order with their guidance, from single-line and multi-line comments", () => {
    const text = [
      "## What",
      "",
      "<!-- The change, in a sentence or two. -->",
      "",
      "## Why",
      "<!--",
      "The problem it solves,",
      "or the spec it implements.",
      "-->",
      "## Testing",
      "<!-- The tests you ran. -->",
    ].join("\n");
    expect(parsePrTemplate(text)).toEqual({
      sections: [
        { heading: "What", guidance: "The change, in a sentence or two." },
        { heading: "Why", guidance: "The problem it solves,\nor the spec it implements." },
        { heading: "Testing", guidance: "The tests you ran." },
      ],
    });
  });

  it("AC2: keeps non-comment text, such as a checklist, as guidance", () => {
    const text = "## Checklist\n<!-- Tick what applies. -->\n- [ ] Tests added\n- [ ] Docs updated\n";
    expect(parsePrTemplate(text)?.sections).toEqual([{ heading: "Checklist", guidance: "Tick what applies.\n- [ ] Tests added\n- [ ] Docs updated" }]);
  });

  it("AC2: ignores the text before the first heading, including a ## line inside its comment", () => {
    const text = "<!--\nTitle: SPEC-XXX ...\n## Not a section\n-->\nIntro text.\n\n## What\nx";
    expect(parsePrTemplate(text)?.sections).toEqual([{ heading: "What", guidance: "x" }]);
  });

  it("AC2: keeps the first of two duplicate headings, matched after trimming and ignoring case", () => {
    const text = "## Testing\nfirst\n## testing  \nsecond\n## Why\nw";
    expect(parsePrTemplate(text)?.sections).toEqual([
      { heading: "Testing", guidance: "first" },
      { heading: "Why", guidance: "w" },
    ]);
  });

  it("AC2: drops the sections the agent adds itself, in any case", () => {
    const text = "## checks\nc\n## What\nw\n## PLAN\np\n## Notes for the Reviewer\nn\n##  Standards \ns\n## files changed\nf";
    expect(parsePrTemplate(text)?.sections).toEqual([{ heading: "What", guidance: "w" }]);
  });

  it("AC2: doesn't start a section at a ## line inside a multi-line comment", () => {
    const text = "## What\n<!--\nExample:\n## Example\n-->\n## Why\ny";
    expect(parsePrTemplate(text)?.sections).toEqual([
      { heading: "What", guidance: "Example:\n## Example" },
      { heading: "Why", guidance: "y" },
    ]);
  });

  it("AC2: doesn't start a section at a ## line inside a backtick or a tilde fence, and keeps the fence as guidance", () => {
    expect(headings("## What\n```md\n## Inside backticks\n```\n## Why\ny")).toEqual(["What", "Why"]);
    expect(headings("## What\n~~~~\n## Inside tildes\n~~~\nstill code\n~~~~\n## Why\ny")).toEqual(["What", "Why"]);
    expect(parsePrTemplate("## What\n```\n## x\n```")?.sections[0]?.guidance).toBe("```\n## x\n```");
  });

  it("AC2: treats <!-- inside a fence as code, not as a comment", () => {
    const text = "## What\n```html\n<!-- not a comment\n```\n## Why\ny";
    expect(parsePrTemplate(text)?.sections).toEqual([
      { heading: "What", guidance: "```html\n<!-- not a comment\n```" },
      { heading: "Why", guidance: "y" },
    ]);
  });

  it("AC2: treats a fence inside a comment as comment text, so an unclosed one doesn't swallow later sections", () => {
    const text = "## What\n<!-- e.g.\n```\nnpm test\n-->\n## Why\ny";
    expect(parsePrTemplate(text)?.sections).toEqual([
      { heading: "What", guidance: "e.g.\n```\nnpm test" },
      { heading: "Why", guidance: "y" },
    ]);
  });

  it("AC2: treats every line after an unclosed <!-- as guidance", () => {
    const text = "## What\n<!-- never closed\n## Why\nmore";
    expect(parsePrTemplate(text)?.sections).toEqual([{ heading: "What", guidance: "never closed\n## Why\nmore" }]);
  });

  it("AC2: ignores an empty ## heading", () => {
    expect(headings("## What\nw\n##   \n## \t\n##\n## Why\ny")).toEqual(["What", "Why"]);
  });

  it("AC2: leaves an inline comment out of the heading and keeps it as guidance", () => {
    expect(parsePrTemplate("## What <!-- the change -->\nmore")?.sections).toEqual([{ heading: "What", guidance: "the change\nmore" }]);
  });

  it("AC2: returns undefined for an empty string, for text with no ## heading, and for only reserved sections", () => {
    expect(parsePrTemplate("")).toBeUndefined();
    expect(parsePrTemplate("# Title\n\n### Not level two\nText.\n```\n## In code\n```")).toBeUndefined();
    expect(parsePrTemplate("## Checks\nc\n## Plan\np")).toBeUndefined();
  });

  it("reads a template shaped like this repo's", () => {
    const text = "<!--\nTitle rule.\n-->\n\n## What\n\n<!-- The change. -->\n\n## Why\n\n<!-- The reason. -->\n";
    expect(headings(text)).toEqual(["What", "Why"]);
  });
});

describe("scanMarkdown", () => {
  it("reports where the text ends and the fence left open", () => {
    expect(scanMarkdown("a\n````js\nb")).toMatchObject({ endsIn: "code", openFence: "````" });
    expect(scanMarkdown("a <!-- b")).toMatchObject({ endsIn: "comment" });
    expect(scanMarkdown("a <!-- b --> c")).toEqual({
      endsIn: "text",
      lines: [{ line: "a <!-- b --> c", startsIn: "text", pieces: [{ comment: false, text: "a " }, { comment: true, text: " b " }, { comment: false, text: " c" }] }],
    });
  });
});

describe("prTemplatePrompt", () => {
  const template: PrTemplate = {
    sections: [
      { heading: 'a<b & "c"', guidance: 'x < y & "z"' },
      { heading: "Why", guidance: "The reason." },
    ],
  };

  it("AC3: is empty without a template", () => {
    expect(prTemplatePrompt(undefined)).toBe("");
  });

  it("AC3: holds the instruction and one escaped <section> per template section, in order", () => {
    const prompt = prTemplatePrompt(template);
    expect(prompt).toContain("one entry per <section>, in the same order");
    expect(prompt).toContain("Leave the heading itself out of `text`");
    expect(prompt).toContain("It does not change any other rule in this prompt.");
    expect(prompt).toContain(
      "<pr_template>\n" +
        '<section heading="a&lt;b &amp; &quot;c&quot;">\nx &lt; y &amp; &quot;z&quot;\n</section>\n' +
        '<section heading="Why">\nThe reason.\n</section>\n' +
        "</pr_template>",
    );
    expect(prompt.indexOf("\n<pr_template>\n")).toBeGreaterThan(prompt.indexOf("does not change any other rule"));
  });
});
