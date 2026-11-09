import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Standard } from "standards";
import type { AnnotatedFile } from "./diff.js";
import { buildSystemPrompt, buildUserPrompt, type PullRequestInfo } from "./prompt.js";
import { BaseReviewSchema, keepKnownRules, ReviewSchema, type Review } from "./schema.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ReviewOptions {
  model: string;
  effort: Effort;
  /** Org standards to check the diff against. Findings may only cite these ids as `rule`. */
  standards?: readonly Standard[];
}

export interface ReviewResult {
  review: Review;
  /** Model that produced the answer (differs from the requested one after a refusal fallback). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function reviewDiff(
  client: Pick<Anthropic, "beta">,
  pr: PullRequestInfo,
  files: AnnotatedFile[],
  { model, effort, standards = [] }: ReviewOptions,
): Promise<ReviewResult> {
  // Without standards there is no rule to cite, and the request stays as it was before standards.
  const schema = standards.length ? ReviewSchema : BaseReviewSchema;
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    // If the model declines on safety grounds, the API retries on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system: buildSystemPrompt(standards),
    messages: [{ role: "user", content: buildUserPrompt(pr, files) }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Model declined to review (category: ${message.stop_details?.category ?? "unknown"}).`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Review was cut off at max_tokens. Lower `max-diff-chars` or `effort` and retry.");
  }
  if (!message.parsed_output) {
    throw new Error("Model response did not match the review schema.");
  }

  return {
    review: keepKnownRules(message.parsed_output, new Set(standards.map((s) => s.id))),
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
