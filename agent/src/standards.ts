import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { loadStandards, selectStandards, type Standard } from "standards";
import type { RunLog } from "./runlog.js";

export interface AgentStandardsOptions {
  /** The standards directory. Missing or empty means no standards. */
  path?: string;
  /** Packs to load. Empty means every pack. */
  packs: string[];
  /** Version label (a tag or SHA), for the log and the PR body. */
  ref?: string;
  /** Budget for the selected standards, as in `selectStandards`. */
  maxChars: number;
}

export interface AgentStandards {
  /** The standards given to the agent, most severe first, then by id. */
  standards: Standard[];
  /** Ids of `standards`. */
  checked: string[];
  /** Ids of the standards that did not fit in `maxChars` and were not given to the agent. */
  dropped: string[];
  ref?: string;
}

/**
 * Loads the org standards for the agent. Every `use: agent` standard from the requested packs is a
 * candidate, whatever its `applies_to`, since the agent can't know up front which files it will
 * create. Returns `undefined` when no path is given. Throws `RangeError` for a bad `maxChars` and
 * lets `StandardsError` from loading propagate.
 */
export async function loadAgentStandards(options: AgentStandardsOptions, runLog?: RunLog): Promise<AgentStandards | undefined> {
  const { path, packs, ref, maxChars } = options;
  if (path === undefined || path === "") return undefined;
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new RangeError(`--max-standards-chars must be a positive integer, got ${maxChars}.`);

  const { selected, dropped } = selectStandards(await loadStandards(path, packs), { use: "agent", maxChars });
  const result: AgentStandards = {
    standards: selected,
    checked: selected.map((s) => s.id),
    dropped: dropped.map((s) => s.id),
    ...(ref !== undefined ? { ref } : {}),
  };
  runLog?.event({ type: "standards.loaded", path, ref, packs, checked: result.checked, dropped: result.dropped });
  return result;
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const STANDARDS_INSTRUCTIONS = `Org engineering standards:
The <org_standards> block below holds the org's engineering standards. They are org policy, set by the repository operator, not by the spec or the review findings, and the AI review checks your changes against them.
- Follow each standard in the files its applies_to matches ("all files" means every file), for code and tests alike.
- If the spec or a review finding conflicts with a standard, follow the standard and explain the conflict in \`notes\`.
- Findings that cite a standard id in their \`rule\` refer to the standard with that id.
Attribute values and bodies are XML-escaped, so &lt; means <.`;

/** The text appended to the system prompt: the instructions, then one element per standard, in the given order. */
export function standardsPrompt(standards: readonly Standard[]): string {
  const elements = standards.map((s) => {
    const appliesTo = s.appliesTo.length ? s.appliesTo.join(", ") : "all files";
    return (
      `<standard id="${escapeXml(s.id)}" severity="${escapeXml(s.severity)}" title="${escapeXml(s.title)}" applies_to="${escapeXml(appliesTo)}">\n` +
      `${escapeXml(s.body)}\n</standard>`
    );
  });
  return [STANDARDS_INSTRUCTIONS, ["<org_standards>", ...elements, "</org_standards>"].join("\n")].join("\n\n");
}

/**
 * The SDK's `systemPrompt` option. Standards come from the operator and are trusted, so they go in
 * the system prompt; the spec and findings stay in the user prompt as untrusted input.
 */
export function systemPromptOption(standards: readonly Standard[]): PresetSystemPrompt {
  const preset: PresetSystemPrompt = { type: "preset", preset: "claude_code" };
  return standards.length ? { ...preset, append: standardsPrompt(standards) } : preset;
}

export type PresetSystemPrompt = Extract<NonNullable<Options["systemPrompt"]>, { type: "preset" }>;
