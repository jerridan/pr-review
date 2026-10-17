// The answer of the eval judge for one pair of a posted finding and a
// golden finding.
import { z } from "zod";
import { ciEnum } from "./json-schema.js";

export type JudgeOutput = { same_issue: "yes" | "no" | "unknown"; reason: string };

export const JudgeOutputSchema: z.ZodType<JudgeOutput> = z.strictObject({
  same_issue: ciEnum(["yes", "no", "unknown"] as const),
  reason: z.string(),
});
