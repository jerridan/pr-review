// The result of one verifier query. The code checks that score is from
// 0 to 100; the schema does not.
import { z } from "zod";
import type { Severity } from "./finding.js";
import { ciEnum, integer } from "./json-schema.js";
import { LABEL_SEVERITIES, POSTED_SEVERITIES, type LabelSeverity } from "./label.js";

/**
 * The severity of a verifier result: the six labels of the severity
 * policy. Only the first three post.
 */
export const VERIFIER_SEVERITIES = LABEL_SEVERITIES;
export type VerifierSeverity = LabelSeverity;

/** True when the severity is one of the three labels that post. */
export function isPostedSeverity(severity: VerifierSeverity): severity is Severity {
  return POSTED_SEVERITIES.includes(severity);
}

export type VerifierResult = {
  in_scope: boolean;
  claim_holds: boolean;
  introduced_by_pr: boolean;
  quotes: string[];
  rationale: string;
  score: number;
  severity: VerifierSeverity;
};

export const VerifierResultSchema: z.ZodType<VerifierResult> = z.strictObject({
  in_scope: z.boolean(),
  claim_holds: z.boolean(),
  introduced_by_pr: z.boolean(),
  quotes: z.array(z.string()),
  rationale: z.string(),
  score: integer(),
  severity: ciEnum(VERIFIER_SEVERITIES),
});
