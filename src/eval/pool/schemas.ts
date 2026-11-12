// The schemas of the pool: a finding with six fields, and the results of
// the blind review, the grouping and the adjudication. The model output
// schemas hold no range check. The code checks ranges.
import { z } from "zod";
import { CATEGORIES, type Category } from "../../schemas/finding.js";
import { ciEnum, integer } from "../../schemas/json-schema.js";

/** A finding of the pool: the six fields that every pool step sees. */
export type PoolFinding = {
  file: string;
  start_line: number;
  end_line: number;
  category: Category;
  claim: string;
  evidence: string;
};

/** The six fields, in the order that every output and request uses. */
export const POOL_FIELDS = [
  "file",
  "start_line",
  "end_line",
  "category",
  "claim",
  "evidence",
] as const;

/** Copy the six fields of "f", and nothing else. */
export function sixFields(f: PoolFinding): PoolFinding {
  return {
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    category: f.category,
    claim: f.claim,
    evidence: f.evidence,
  };
}

export const PoolFindingSchema: z.ZodType<PoolFinding> = z.strictObject({
  file: z.string(),
  start_line: integer(),
  end_line: integer(),
  category: ciEnum(CATEGORIES),
  claim: z.string(),
  evidence: z.string(),
});

export type ReviewOutput = { findings: PoolFinding[] };

/** The result of one blind review. */
export const ReviewOutputSchema: z.ZodType<ReviewOutput> = z.strictObject({
  findings: z.array(PoolFindingSchema),
});

export type GroupOutput = { groups: { members: string[]; representative: string }[] };

/** The result of one grouping call. */
export const GroupOutputSchema: z.ZodType<GroupOutput> = z.strictObject({
  groups: z.array(
    z.strictObject({
      members: z.array(z.string()),
      representative: z.string(),
    }),
  ),
});

export type AdjudicationOutput = {
  score: number;
  reason: string;
  start_line: number;
  end_line: number;
};

/** The result of one adjudication call. */
export const AdjudicationOutputSchema: z.ZodType<AdjudicationOutput> = z.strictObject({
  score: integer(),
  reason: z.string(),
  start_line: integer(),
  end_line: integer(),
});

/**
 * A finding from a record or a file. It needs file, the two lines,
 * category and claim. Evidence is optional. Other fields are dropped.
 */
export const InputFindingSchema = z
  .object({
    file: z.string(),
    start_line: z.int().min(1),
    end_line: z.int(),
    category: ciEnum(CATEGORIES),
    claim: z.string(),
    evidence: z.string().optional(),
  })
  .refine((f) => f.end_line >= f.start_line, {
    message: "end_line is below start_line",
    path: ["end_line"],
  })
  .transform((f): PoolFinding => ({ ...f, evidence: f.evidence ?? "" }));
