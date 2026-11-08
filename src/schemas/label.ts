// The results of the two calls of the severity labeler: the scorer gives a
// label, and the judge accepts or rejects it.
import { z } from "zod";
import { CATEGORIES, type Category } from "./finding.js";
import { ciEnum } from "./json-schema.js";

/** The six labels of the severity policy. The first three post. */
export const LABEL_SEVERITIES = [
  "blocking",
  "suggestion",
  "nit",
  "dont_post",
  "not_real",
  "unsure",
] as const;
export type LabelSeverity = (typeof LABEL_SEVERITIES)[number];

/** The labels that post. A golden with one of them counts for recall. */
export const POSTED_SEVERITIES: readonly LabelSeverity[] = ["blocking", "suggestion", "nit"];

export type ScorerResult = {
  severity: LabelSeverity;
  category: Category;
  policy_section: string;
  rationale: string;
};

export const ScorerResultSchema: z.ZodType<ScorerResult> = z.strictObject({
  severity: ciEnum(LABEL_SEVERITIES),
  category: ciEnum(CATEGORIES),
  policy_section: z.string(),
  rationale: z.string(),
});

export type JudgeResult = { accept: boolean; policy_section: string; reason: string };

export const JudgeResultSchema: z.ZodType<JudgeResult> = z.strictObject({
  accept: z.boolean(),
  policy_section: z.string(),
  reason: z.string(),
});
