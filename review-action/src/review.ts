import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AnnotatedFile } from "./diff.js";
import { buildUserPrompt, SYSTEM_PROMPT, type PullRequestInfo } from "./prompt.js";
import { ReviewSchema, type Review } from "./schema.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ReviewOptions {
  model: string;
  effort: Effort;
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
  { model, effort }: ReviewOptions,
): Promise<ReviewResult> {
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    // If the model declines on safety grounds, the API retries on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort, format: betaZodOutputFormat(ReviewSchema) },
    system: SYSTEM_PROMPT,
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
    review: message.parsed_output,
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
