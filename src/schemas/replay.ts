// The schemas of the replay (D4c S2): the outputs of the truth and bands
// verifier prompts and of the severity step, the file of external
// candidates, and the results file of one case. The four output schemas go
// to a model; the two file schemas do not.
import { z } from "zod";
import { EFFORTS, type Effort } from "../config/models.js";
import { FindingSchema, type Finding } from "./finding.js";
import { ciEnum, integer } from "./json-schema.js";
import { LABEL_SEVERITIES, type LabelSeverity } from "./label.js";
import {
  FindingSourceSchema,
  QueryFailureSchema,
  type FindingSource,
  type QueryFailure,
} from "./record.js";
import { VERIFIER_SEVERITIES, type VerifierSeverity } from "./verifier.js";

/** The result of the truth prompt: the score form with no severity. */
export type TruthResult = {
  in_scope: boolean;
  claim_holds: boolean;
  introduced_by_pr: boolean;
  quotes: string[];
  rationale: string;
  score: number;
};

export const TruthResultSchema: z.ZodType<TruthResult> = z.strictObject({
  in_scope: z.boolean(),
  claim_holds: z.boolean(),
  introduced_by_pr: z.boolean(),
  quotes: z.array(z.string()),
  rationale: z.string(),
  score: integer(),
});

/** The five bands of the bands prompt, from the lowest to the highest. */
export const BANDS = ["contradicted", "unlikely", "possible", "likely", "certain"] as const;
export type Band = (typeof BANDS)[number];

/** The result of the bands prompt: a named band in place of the score. */
export type BandsResult = {
  in_scope: boolean;
  claim_holds: boolean;
  introduced_by_pr: boolean;
  quotes: string[];
  rationale: string;
  band: Band;
  severity: VerifierSeverity;
};

export const BandsResultSchema: z.ZodType<BandsResult> = z.strictObject({
  in_scope: z.boolean(),
  claim_holds: z.boolean(),
  introduced_by_pr: z.boolean(),
  quotes: z.array(z.string()),
  rationale: z.string(),
  band: ciEnum(BANDS),
  severity: ciEnum(VERIFIER_SEVERITIES),
});

/** The output of the severity step for one candidate. */
export type SeverityFindingOutput = { severity: LabelSeverity; rationale: string };

export const SeverityFindingOutputSchema: z.ZodType<SeverityFindingOutput> = z.strictObject({
  severity: ciEnum(LABEL_SEVERITIES),
  rationale: z.string(),
});

/** The output of the severity step for the candidates of one case, by index. */
export type SeverityPrOutput = {
  labels: { index: number; severity: LabelSeverity; rationale: string }[];
};

export const SeverityPrOutputSchema: z.ZodType<SeverityPrOutput> = z.strictObject({
  labels: z.array(
    z.strictObject({
      index: integer(),
      severity: ciEnum(LABEL_SEVERITIES),
      rationale: z.string(),
    }),
  ),
});

/** The file "<case>.json" of --candidates: the findings of one reviewer outside the pipeline. */
export type ExternalCandidates = { source: string; findings: Finding[] };

export const ExternalCandidatesSchema: z.ZodType<ExternalCandidates> = z.strictObject({
  source: z.string().min(1),
  findings: z.array(FindingSchema),
});

/** The cost, the duration, the model and the effort of one call. */
export type CallMeta = {
  model: string;
  effort: Effort;
  cost_usd: number | null;
  duration_ms: number;
  /** The tokens of a codex call: a number, or null when the outcome has none. */
  tokens?: number | null;
};

/**
 * A verifier result of any prompt form, in one shape. "score" is the
 * score of the form, or the score of the band. "severity" is null for the
 * truth form.
 */
export type ReplayResult = {
  in_scope: boolean;
  claim_holds: boolean;
  introduced_by_pr: boolean;
  quotes: string[];
  rationale: string;
  score: number;
  band?: Band;
  severity: VerifierSeverity | null;
};

/** The result of the severity step for one candidate. */
export type SeverityEntry = {
  /** The --severity value: mode, model and effort. */
  spec: string;
  /** The label, or null when the call failed or gave no label for the candidate. */
  label: LabelSeverity | null;
  rationale: string;
  failure?: QueryFailure;
  call: CallMeta | null;
  /** The candidates that the call labeled: 1 for the finding mode. */
  shared_by: number;
};

/** One candidate of a case, with its results. */
export type ReplayEntry = {
  /** The repeat of the record, or "external" for --candidates. */
  repeat: number | "external";
  /** findingKey of src/eval/score.ts: the file, the span and the claim. */
  key: string;
  finding: Finding;
  sources: FindingSource[];
  /** The reviewer that decides the threshold: the first source, or the external source. */
  reviewer: string;
  /** The golden of any label that the candidate matches, or null. */
  golden: { index: number; label: LabelSeverity } | null;
  result: ReplayResult | QueryFailure;
  /** The verifier call, or null for the stored arm when the record has no entry. */
  call: CallMeta | null;
  severity?: SeverityEntry;
  /** The first-result decision. Null for a truth result with no label. */
  decision: { passed: boolean; rejected?: string; unsure?: "claim" | "limit" } | null;
  /** True for a result in the escalation band, or a candidate that needs context. */
  in_band: boolean;
};

/** The file "<out>/<case>/results.json". */
export type ResultsFile = {
  version: 1;
  tool_version: string;
  arm: string;
  case: string;
  entries: ReplayEntry[];
};

const CallMetaSchema = z.strictObject({
  model: z.string(),
  effort: z.enum(EFFORTS as readonly [Effort, ...Effort[]]),
  cost_usd: z.number().nullable(),
  duration_ms: z.number(),
  tokens: z.number().nullable().optional(),
});

const ReplayResultSchema = z.strictObject({
  in_scope: z.boolean(),
  claim_holds: z.boolean(),
  introduced_by_pr: z.boolean(),
  quotes: z.array(z.string()),
  rationale: z.string(),
  score: z.number(),
  band: z.enum(BANDS).optional(),
  severity: z.enum(VERIFIER_SEVERITIES).nullable(),
});

export const ResultsFileSchema: z.ZodType<ResultsFile> = z.strictObject({
  version: z.literal(1),
  tool_version: z.string(),
  arm: z.string(),
  case: z.string(),
  entries: z.array(
    z.strictObject({
      repeat: z.union([z.number(), z.literal("external")]),
      key: z.string(),
      finding: FindingSchema,
      sources: z.array(FindingSourceSchema),
      reviewer: z.string(),
      golden: z.strictObject({ index: z.number(), label: z.enum(LABEL_SEVERITIES) }).nullable(),
      result: z.union([ReplayResultSchema, QueryFailureSchema]),
      call: CallMetaSchema.nullable(),
      severity: z
        .strictObject({
          spec: z.string(),
          label: z.enum(LABEL_SEVERITIES).nullable(),
          rationale: z.string(),
          failure: QueryFailureSchema.optional(),
          call: CallMetaSchema.nullable(),
          shared_by: z.number(),
        })
        .optional(),
      decision: z
        .strictObject({
          passed: z.boolean(),
          rejected: z.string().optional(),
          unsure: z.enum(["claim", "limit"]).optional(),
        })
        .nullable(),
      in_band: z.boolean(),
    }),
  ),
});
