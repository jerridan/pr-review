// The output of one semantic-merge query.
import { z } from "zod";
import { severitySchema } from "./finding.js";
import { integer } from "./json-schema.js";

export type MergeOutput = {
  merged: {
    member_index: number;
    claim: string;
    explanation: string;
    suggested_fix?: string;
    severity: "blocking" | "suggestion" | "nit";
  }[];
};

export const MergeOutputSchema: z.ZodType<MergeOutput> = z.strictObject({
  merged: z.array(
    z.strictObject({
      member_index: integer(),
      claim: z.string(),
      explanation: z.string(),
      suggested_fix: z.string().optional(),
      severity: severitySchema(),
    }),
  ),
});
