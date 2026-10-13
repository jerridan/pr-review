// The result of one verifier query. The code checks that score is from
// 0 to 100; the schema does not.
import { z } from "zod";
import { severitySchema } from "./finding.js";
import { integer } from "./json-schema.js";

export type VerifierResult = {
  in_scope: boolean;
  claim_holds: boolean;
  introduced_by_pr: boolean;
  quotes: string[];
  rationale: string;
  score: number;
  severity: "blocking" | "suggestion" | "nit";
};

export const VerifierResultSchema: z.ZodType<VerifierResult> = z.strictObject({
  in_scope: z.boolean(),
  claim_holds: z.boolean(),
  introduced_by_pr: z.boolean(),
  quotes: z.array(z.string()),
  rationale: z.string(),
  score: integer(),
  severity: severitySchema(),
});
