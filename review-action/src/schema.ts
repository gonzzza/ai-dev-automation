import { z } from "zod";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ["bug", "security", "missing-tests", "performance", "maintainability"] as const;
export type Category = (typeof CATEGORIES)[number];

export const FindingSchema = z.object({
  path: z.string().describe("File path exactly as shown in the <file path> attribute."),
  line: z.number().int().describe("New-file line number from the left column of the annotated diff."),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  title: z.string().describe("One line, under 80 characters."),
  body: z.string().describe("What is wrong, the concrete failure scenario, and how to fix it. Markdown."),
});

export const ReviewSchema = z.object({
  summary: z.string().describe("2-4 sentences on what the PR does and its overall risk."),
  findings: z.array(FindingSchema),
});

export type Finding = z.infer<typeof FindingSchema>;
export type Review = z.infer<typeof ReviewSchema>;

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
