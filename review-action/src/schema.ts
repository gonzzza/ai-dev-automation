import { z } from "zod";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ["bug", "security", "missing-tests", "performance", "maintainability"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * A finding without `rule`. Reviews without org standards send this schema, so their request
 * stays exactly what it was before standards existed.
 */
export const BaseFindingSchema = z.object({
  path: z.string().describe("File path exactly as shown in the <file path> attribute."),
  line: z.number().int().describe("New-file line number from the left column of the annotated diff."),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  title: z.string().describe("One line, under 80 characters."),
  body: z.string().describe("What is wrong, the concrete failure scenario, and how to fix it. Markdown."),
});

export const FindingSchema = BaseFindingSchema.extend({
  rule: z
    .string()
    .optional()
    .describe("Id of the org standard this finding violates, from the <org_standards> block. Omit it for other findings."),
});

const summaryField = () => z.string().describe("2-4 sentences on what the PR does and its overall risk.");

export const BaseReviewSchema = z.object({
  summary: summaryField(),
  findings: z.array(BaseFindingSchema),
});

export const ReviewSchema = z.object({
  summary: summaryField(),
  findings: z.array(FindingSchema),
});

export type Finding = z.infer<typeof FindingSchema>;
export type Review = z.infer<typeof ReviewSchema>;

/**
 * Model output may cite a rule that wasn't in the prompt. Keep only rules naming a standard that was
 * sent (`ids`); a finding with any other rule is kept without one.
 */
export function keepKnownRules(review: Review, ids: ReadonlySet<string>): Review {
  return {
    ...review,
    findings: review.findings.map((finding) => {
      if (finding.rule === undefined) return finding;
      const { rule, ...rest } = finding;
      const id = rule.trim();
      return ids.has(id) ? { ...rest, rule: id } : rest;
    }),
  };
}

/** Rank used for sorting and for the `fail-on` threshold. Higher is worse. */
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export const bySeverityDesc = (a: Finding, b: Finding): number => severityRank(b.severity) - severityRank(a.severity);

export function parseFailOn(value: string): Severity | "none" {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "none") return "none";
  if ((SEVERITIES as readonly string[]).includes(v)) return v as Severity;
  throw new Error(`fail-on must be one of none, ${SEVERITIES.join(", ")}; got "${value}"`);
}

export function shouldFail(findings: Finding[], failOn: Severity | "none"): boolean {
  if (failOn === "none") return false;
  return findings.some((f) => severityRank(f.severity) >= severityRank(failOn));
}
