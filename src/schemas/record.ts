// The run record: one JSON file per run, with four parts. This schema is
// not sent to a model.
import { z } from "zod";
import { EFFORTS, ROLES, type Effort, type Role } from "../config/models.js";
import type { QueryMeta } from "../sdk/client.js";
import { FindingSchema, SEVERITIES, findingShape, type Finding } from "./finding.js";
import { integer } from "./json-schema.js";
import { MergeOutputSchema, type MergeOutput } from "./merge.js";
import { TIERS, TriageBriefSchema, type TriageBrief } from "./triage.js";
import { VerifierResultSchema, type VerifierResult } from "./verifier.js";

export type QueryFailure = {
  kind:
    | "subtype"
    | "no-structured-output"
    | "refusal"
    | "max_tokens"
    | "out-of-range"
    | "thrown"
    | "limit";
  message: string;
};

export type PostedFinding = Finding & {
  fingerprint: string;
  severity: "blocking" | "suggestion" | "nit";
  score: number;
  verifier: VerifierResult;
};

export type Verdict = "skipped" | "incomplete" | "would request changes" | "would approve";

export type RunRecord = {
  identity: {
    repo: string;
    pr: null;
    base: string;
    head: string;
    started_at: string;
    tool_version: string;
    config_hash: null;
    changed_files: { path: string; hunks: number }[];
    excluded_files: { path: string; reason: "rename-only" | "generated" }[];
    sensitive_files: string[];
    triage: TriageBrief | null;
    tier: "skip" | "fast" | "full";
    tier_reason: string;
    selected_reviewers: { name: string; trigger: string }[];
    models: Record<Role, { model: string; effort: Effort }>;
  };
  stages: {
    reviewers: {
      name: string;
      pass: number;
      status: "ok" | "failed";
      failure?: QueryFailure;
      findings: Finding[];
      dropped: { finding: Finding; reason: "bad-quote" | "out-of-range" }[];
      meta: QueryMeta | null;
    }[];
    verifications: {
      finding: Finding;
      first: VerifierResult | QueryFailure;
      escalated?: VerifierResult | QueryFailure;
      final: VerifierResult | null;
      passed: boolean;
    }[];
    merges: { group: number[]; result: MergeOutput | QueryFailure; rejected?: string }[];
    capped: PostedFinding[];
  };
  posted: {
    verdict: "skipped" | "incomplete" | "would request changes" | "would approve";
    coverage: {
      reviewers_ran: string[];
      reviewers_failed: string[];
      findings_dropped_by_failed_verifier: number;
    };
    findings: PostedFinding[];
  };
  cost: {
    queries: {
      role: Role;
      reviewer?: string;
      model: string;
      duration_ms: number;
      stop_reason: string | null;
      subtype: string;
      usage: unknown;
      cost_usd: number | null;
    }[];
    total_cost_usd: number | null;
    stage_ms: Record<string, number>;
    errors: { stage: string; message: string }[];
  };
};

export const FAILURE_KINDS = [
  "subtype",
  "no-structured-output",
  "refusal",
  "max_tokens",
  "out-of-range",
  "thrown",
  "limit",
] as const;

export const QueryFailureSchema: z.ZodType<QueryFailure> = z.strictObject({
  kind: z.enum(FAILURE_KINDS),
  message: z.string(),
});

export const QueryMetaSchema: z.ZodType<QueryMeta> = z.strictObject({
  model: z.string(),
  durationMs: z.number(),
  stopReason: z.string().nullable(),
  subtype: z.string(),
  usage: z.unknown(),
  costUsd: z.number().nullable(),
});

export const PostedFindingSchema: z.ZodType<PostedFinding> = z.strictObject({
  ...findingShape,
  fingerprint: z.string(),
  severity: z.enum(SEVERITIES),
  score: integer(),
  verifier: VerifierResultSchema,
});

const roleEnum = z.enum(ROLES as readonly [Role, ...Role[]]);
const effortEnum = z.enum(EFFORTS as readonly [Effort, ...Effort[]]);
const verifierOrFailure = z.union([VerifierResultSchema, QueryFailureSchema]);

const IdentitySchema = z.strictObject({
  repo: z.string(),
  pr: z.null(),
  base: z.string(),
  head: z.string(),
  started_at: z.string(),
  tool_version: z.string(),
  config_hash: z.null(),
  changed_files: z.array(z.strictObject({ path: z.string(), hunks: integer() })),
  excluded_files: z.array(
    z.strictObject({ path: z.string(), reason: z.enum(["rename-only", "generated"]) }),
  ),
  sensitive_files: z.array(z.string()),
  triage: TriageBriefSchema.nullable(),
  tier: z.enum(TIERS),
  tier_reason: z.string(),
  selected_reviewers: z.array(z.strictObject({ name: z.string(), trigger: z.string() })),
  models: z.record(roleEnum, z.strictObject({ model: z.string(), effort: effortEnum })),
});

const StagesSchema = z.strictObject({
  reviewers: z.array(
    z.strictObject({
      name: z.string(),
      pass: integer(),
      status: z.enum(["ok", "failed"]),
      failure: QueryFailureSchema.optional(),
      findings: z.array(FindingSchema),
      dropped: z.array(
        z.strictObject({
          finding: FindingSchema,
          reason: z.enum(["bad-quote", "out-of-range"]),
        }),
      ),
      meta: QueryMetaSchema.nullable(),
    }),
  ),
  verifications: z.array(
    z.strictObject({
      finding: FindingSchema,
      first: verifierOrFailure,
      escalated: verifierOrFailure.optional(),
      final: VerifierResultSchema.nullable(),
      passed: z.boolean(),
    }),
  ),
  merges: z.array(
    z.strictObject({
      group: z.array(integer()),
      result: z.union([MergeOutputSchema, QueryFailureSchema]),
      rejected: z.string().optional(),
    }),
  ),
  capped: z.array(PostedFindingSchema),
});

const PostedSchema = z.strictObject({
  verdict: z.enum(["skipped", "incomplete", "would request changes", "would approve"]),
  coverage: z.strictObject({
    reviewers_ran: z.array(z.string()),
    reviewers_failed: z.array(z.string()),
    findings_dropped_by_failed_verifier: integer(),
  }),
  findings: z.array(PostedFindingSchema),
});

const CostSchema = z.strictObject({
  queries: z.array(
    z.strictObject({
      role: roleEnum,
      reviewer: z.string().optional(),
      model: z.string(),
      duration_ms: z.number(),
      stop_reason: z.string().nullable(),
      subtype: z.string(),
      usage: z.unknown(),
      cost_usd: z.number().nullable(),
    }),
  ),
  total_cost_usd: z.number().nullable(),
  stage_ms: z.record(z.string(), z.number()),
  errors: z.array(z.strictObject({ stage: z.string(), message: z.string() })),
});

export const RecordSchema: z.ZodType<RunRecord> = z.strictObject({
  identity: IdentitySchema,
  stages: StagesSchema,
  posted: PostedSchema,
  cost: CostSchema,
});
