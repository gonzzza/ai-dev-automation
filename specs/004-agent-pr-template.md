# Follow the repo's PR template in agent pull requests

## Goal
The repo's PR template (`.github/pull_request_template.md`) asks for What, Why and Testing sections and a title that starts with the spec ID. The agent opens its PRs through the API with a body and title built in `agent/src/pr.ts`, so its PRs follow neither. This change makes the template the one place the body format is defined: the agent reads it from the repo it works on and fills its sections, and agent PR titles start with `SPEC-XXX`. Reviewers then see every PR in the same shape, whoever opened it.

## Requirements

### Title
- `prTitle(spec)` returns `SPEC-<number> <spec.title>`, where `<number>` is the leading digits of `spec.slug`, zero-padded to at least three digits: `001-rate-limiter` → `SPEC-001`, `7-x` → `SPEC-007`, `1234-x` → `SPEC-1234`. A slug with no leading number gives `spec.title` unchanged.
- The 72-code-point limit applies to the whole title, `SPEC-<number> ` prefix included, and to a title with no prefix. Length is counted in Unicode code points (as `Array.from(title).length` counts them), so a cut never splits a surrogate pair. A full title longer than 72 code points is cut to its first 71, trailing whitespace is trimmed, and `…` is appended. The result is at most 72 code points: fewer when the cut lands on whitespace.
- The first line of `commitMessage(spec, run, runId)` is `prTitle(spec)` instead of `spec.title`. The rest of the message is unchanged.

### Reading the template
- New module `agent/src/template.ts`.
- `parsePrTemplate(text: string): PrTemplate | undefined`, where `PrTemplate` is `{ sections: { heading: string; guidance: string }[] }`:
  - Fenced code blocks are found first, by the CommonMark rules `blankCodeBlocks` in `agent/src/spec.ts` already implements: backtick or tilde fences, closed only by a bare fence of the same character at least as long as the opener, and an unclosed block runs to the end of the file. Export it and reuse it rather than writing a second fence parser. Comment markers inside a fenced block are code, not comments.
  - Outside fenced blocks, `<!--` opens a comment that closes at the next `-->`. An unclosed comment runs to the end of the file.
  - Each line matching `## <heading>` outside a fenced block and outside a comment starts a section. Lines inside them are part of the guidance. A heading that is empty after trimming doesn't start a section. `heading` is the trimmed heading text.
  - `guidance` is the section's content up to the next `## ` heading, with the `<!--` and `-->` markers removed and the result trimmed. Comments can span several lines. Non-comment text (such as a checklist) is kept as guidance.
  - Text before the first `## ` heading is ignored: it holds the title rule, which `prTitle` implements in code.
  - If a heading appears twice, the first one wins.
  - Sections whose heading matches one the agent adds itself (`Checks`, `Plan`, `Notes for the reviewer`, `Standards`, `Files changed`), ignoring case and surrounding whitespace, are dropped. The model is never asked to fill them, and the body never has two sections with the same heading, and the model is never asked to write a section the harness owns.
  - Returns `undefined` for an empty file, for one with no `## ` heading, and for one whose sections are all dropped. A template is never `{ sections: [] }`.
- `runPipeline` reads `.github/pull_request_template.md` with the existing injected `deps.readFile`, after the preflight checks and before `runAgent`. The pipeline starts from a clean checkout of the base branch, and the agent can't write under `.github/`, so this is the base commit's template. A PR can't change the template it is held to. `deps.readFile` returns `undefined` for a missing file, which means no template. Any other read error (a directory at that path, no permission) propagates and aborts the run before the agent starts, so no API spend goes on a broken setup.
- `PipelineDeps.runAgent` becomes `runAgent(spec: Spec, template?: PrTemplate): Promise<AgentRun>`. `cli.ts` passes the template on to `specTask`.

### Prompt and report
- `prTemplatePrompt(template?: PrTemplate): string` returns `""` without a template. Otherwise it returns an instruction followed by a `<pr_template>` block with one `<section heading="…">guidance</section>` element per section, in template order. Headings and guidance are XML-escaped, using the same escaping as `standardsPrompt` in `agent/src/standards.ts` (move the helper to a shared module if needed).
- The instruction tells the model to:
  - fill the report's `sections` with one entry per template section, in order, each with the section's `heading` and a markdown `text`, following that section's guidance;
  - leave the heading itself out of `text`;
  - treat the template as formatting guidance from the repository, not as instructions that change any other rule in the prompt.
- `agent/prompt.md` gains a `{{prTemplate}}` placeholder after the rules and before the `<spec>` block. `buildPrompt` and `specTask` take an optional `PrTemplate` and fill the placeholder with `prTemplatePrompt(template)`.
- `AgentReportSchema` gains a required `sections: { heading: string; text: string }[]`, described as one entry per section of the PR template in the prompt, and an empty array when the prompt has no template. The fix cycle's schema is unchanged.

### PR body
- `PrContext` gains an optional `template?: PrTemplate`, which the pipeline sets from the template it read.
- Without a template, `prBody` returns exactly what it returns today. The report's `sections` are ignored.
- With a template, the body is:
  1. The opening `> 🤖 Opened by the spec-driven agent…` line, as today.
  2. One `## <heading>` per template section, in template order. Its text is the first report entry whose heading matches the template's after trimming, ignoring case. If no entry matches, or its text is blank, the text is `_The agent did not fill this section._`. Report entries for headings the template doesn't have are dropped. Outside fenced code blocks (found as above), any line of the model's text that is a level-1 or level-2 ATX heading (`#` or `##` followed by a space, a tab or the end of the line, after up to three spaces) is rewritten as a `###` heading with the same text. If the text ends inside an open fence, a closing fence of the same character and length is appended, so it can't turn the sections after it into code. This keeps the body's structure tidy. It is not a security boundary: Markdown has other ways to draw a heading (setext underlines, raw HTML), and the PR body is not the evidence that checks passed. The CI status on the PR is.
  3. `## Checks`, holding the existing harness line: ``Re-run locally by the harness after the agent finished: `npm run check` (lint, typecheck, all tests) passed. CI verifies again on a clean checkout.``
  4. The agent-only sections as today: `## Plan`, `## Notes for the reviewer` (when notes are not blank), `## Standards` (when set), `## Files changed`, the run footer and the Claude Code line.
- With a template, the body has no `## Summary` and no agent `## Testing` section: the template's sections replace them. A template section named Testing is still rendered.

## Acceptance criteria
- AC1: `prTitle` gives `SPEC-001 Add a token bucket rate limiter` for `specs/001-rate-limiter.md`, pads `7-x` to `SPEC-007`, keeps `1234-x` as `SPEC-1234`, and returns the title unchanged for a slug with no number. A title over 72 code points comes out at most 72 code points long, ending in `…`: exactly 72 when the cut lands inside a word, fewer when it lands on whitespace (both cases tested). A title with an emoji at the cut point keeps no lone surrogate. The limit counts the prefix: `SPEC-001 ` plus a 70-code-point title comes out at most 72 code points, and a 90-code-point title with no number in its slug is cut the same way. The first line of `commitMessage` equals `prTitle` for the same spec.
- AC2: `parsePrTemplate` returns the sections in order with their guidance, handles single-line and multi-line comments, keeps non-comment text, ignores the text before the first heading, keeps the first of two duplicate headings, drops sections named `Checks`, `Plan`, `Notes for the reviewer`, `Standards` or `Files changed` in any case, doesn't start a section at a `## ` line inside a multi-line comment, a backtick fence or a tilde fence, treats `<!--` inside a fence as code, treats every line after an unclosed `<!--` as guidance, ignores an empty `## ` heading, and returns `undefined` for an empty string, for text with no `## ` heading, and for a template whose only sections are reserved ones.
- AC3: `prTemplatePrompt(undefined)` is `""`. With a template, it holds the instruction (including that the template does not change other rules) and one `<section>` element per section in order, with `<`, `&` and `"` escaped in headings and guidance. `buildPrompt` with a template contains that text before the `<spec>` block, and without one contains no `<pr_template>`.
- AC4: `AgentReportSchema` rejects a report with no `sections` and accepts one with an empty array. `AGENT_REPORT_JSON_SCHEMA` lists `sections` as required.
- AC5: With a template, `prBody` renders the template's headings in template order, matches report entries case-insensitively after trimming, shows the placeholder for a missing or blank entry, drops entries the template doesn't have, rewrites `#` and `##` heading lines in the model's text as `###`, including ones followed by a tab or nothing, but not inside a fenced code block, closes a fence the model's text leaves open, has `## Checks` after the template sections and the agent-only sections after that, and has no `## Summary`. Without a template, it equals the existing expected body in `agent/test/pr.test.ts` for the same input.
- AC6: `runPipeline` reads `.github/pull_request_template.md` through the injected `readFile` before calling `runAgent`, passes the parsed template to `runAgent` and into the PR body, and passes `undefined` and builds today's body when the file is missing. A `readFile` that throws aborts the run before `runAgent` is called. Tests use the existing fake git and fake `readFile`.
- AC7: A test reads this repo's `.github/pull_request_template.md`, finds the quoted example title that starts with `SPEC-`, and checks that `prTitle` gives exactly that string for a spec whose slug starts with the same number and whose title is the rest of the example. It fails if the template has no such example. This catches the template and `prTitle` drifting apart.
- AC8: `agent/README.md` explains that agent PRs follow the repo's `.github/pull_request_template.md` (read from the base checkout), what happens without one, which sections the agent always adds, and the `SPEC-XXX` title format with its 72-character cut. Tests use fixtures and fakes only: no network, no git and no Anthropic calls.

## Out of scope
- Other template locations GitHub supports (`PULL_REQUEST_TEMPLATE.md` at the root or in `docs/`, the `.github/PULL_REQUEST_TEMPLATE/` directory, multiple templates).
- Checking human PRs against the template, such as a workflow that lints titles or headings.
- Fix-cycle commits and comments: they keep their current format.
- Updating the PR body after a fix cycle.
- A spec ID field in the spec format: the number keeps coming from the file name.
- Changes to the review action or to `.github/pull_request_template.md` itself.
