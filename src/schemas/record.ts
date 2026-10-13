// The run record: one JSON file per run, with four parts. This schema is
// not sent to a model.
import { z } from "zod";
import { RepoConfigSchema, type RepoConfig, type Suppression } from "../config/repo-config.js";
import { EFFORTS, ROLES, type Effort, type Role } from "../config/models.js";
import type { QueryMeta } from "../sdk/client.js";
import { CATEGORIES, FindingSchema, SEVERITIES, findingShape, type Finding } from "./finding.js";
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
    | "limit"
    | "timeout";
  message: string;
};

export type PostedFinding = Finding & {
  fingerprint: string;
  severity: "blocking" | "suggestion" | "nit";
  score: number;
  verifier: VerifierResult;
};

/** A reviewer that the tier and the triggers selected, but that did not run. */
export type SkippedReviewer = {
  name: string;
  reason: "disabled by config" | "no description" | "token ceiling";
  /** The pass that did not start, for the reason "token ceiling". */
  pass?: number;
};

/** A custom reviewer, and whether the run gave it Bash. */
export type CustomReviewerEntry = { name: string; bash_granted: boolean; reason: string | null };

export type Verdict = "skipped" | "incomplete" | "would request changes" | "would approve";

export type RunRecord = {
  identity: {
    repo: string;
    pr: null;
    base: string;
    head: string;
    started_at: string;
    tool_version: string;
    /** The SHA-256 of the loaded .pr-review/ files, or null when none loaded. */
    config_hash: string | null;
    /** The repo config of the run: the loaded paths and the values with defaults. */
    config: {
      files: string[];
      values: RepoConfig;
      custom_reviewers: CustomReviewerEntry[];
    };
    /** The description of the change that every reviewer and verifier got. */
    description: string;
    /** Whether gather built the history block, and whether it cut the block to fit. */
    history: { built: boolean; truncated: boolean };
    /** The files in each reviewer's rules block, and whether each was cut to fit. */
    injected: { path: string; truncated: boolean }[];
    changed_files: { path: string; hunks: number }[];
    excluded_files: { path: string; reason: "rename-only" | "generated" }[];
    sensitive_files: string[];
    triage: TriageBrief | null;
    tier: "skip" | "fast" | "full";
    tier_reason: string;
    selected_reviewers: {
      name: string;
      trigger: string;
      model: string;
      effort: Effort;
      /** Tools in the reviewer's frontmatter that are not read-only tools. */
      tools_ignored: string[];
    }[];
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
      rejected?: string;
    }[];
    merges: { group: number[]; result: MergeOutput | QueryFailure; rejected?: string }[];
    capped: PostedFinding[];
    /** The verified findings that a suppression rule removed before the merge groups formed. */
    suppressed: { finding: Finding; reviewer: string; rule: Suppression }[];
  };
  posted: {
    verdict: "skipped" | "incomplete" | "would request changes" | "would approve";
    coverage: {
      reviewers_ran: string[];
      reviewers_failed: string[];
      reviewers_skipped: SkippedReviewer[];
      /** Custom reviewers whose tools name Bash and that ran without it, with the reason. */
      reviewers_without_bash: { name: string; reason: string }[];
      /**
       * Sensitive paths in the diff with no text hunk (a mode flip or a
       * binary). The tier does not change for them.
       */
      sensitive_without_hunks: string[];
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
    /**
     * The sum of the known query costs. When queries_without_cost is above
     * 0, the true cost is higher. Null when no query has a cost.
     */
    total_cost_usd: number | null;
    /** The number of queries with no cost (a query that threw, for example). */
    queries_without_cost: number;
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
  "timeout",
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
  config_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  config: z.strictObject({
    files: z.array(z.string()),
    values: RepoConfigSchema,
    custom_reviewers: z.array(
      z.strictObject({
        name: z.string(),
        bash_granted: z.boolean(),
        reason: z.string().nullable(),
      }),
    ),
  }),
  description: z.string(),
  history: z.strictObject({ built: z.boolean(), truncated: z.boolean() }),
  injected: z.array(z.strictObject({ path: z.string(), truncated: z.boolean() })),
  changed_files: z.array(z.strictObject({ path: z.string(), hunks: integer() })),
  excluded_files: z.array(
    z.strictObject({ path: z.string(), reason: z.enum(["rename-only", "generated"]) }),
  ),
  sensitive_files: z.array(z.string()),
  triage: TriageBriefSchema.nullable(),
  tier: z.enum(TIERS),
  tier_reason: z.string(),
  selected_reviewers: z.array(
    z.strictObject({
      name: z.string(),
      trigger: z.string(),
      model: z.string(),
      effort: effortEnum,
      tools_ignored: z.array(z.string()),
    }),
  ),
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
      rejected: z.string().optional(),
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
  suppressed: z.array(
    z.strictObject({
      finding: FindingSchema,
      reviewer: z.string(),
      rule: z.strictObject({
        reviewer: z.string().optional(),
        category: z.enum(CATEGORIES).optional(),
        path: z.string().optional(),
        reason: z.string(),
      }),
    }),
  ),
});

export const SkippedReviewerSchema: z.ZodType<SkippedReviewer> = z.strictObject({
  name: z.string(),
  reason: z.enum(["disabled by config", "no description", "token ceiling"]),
  pass: integer().optional(),
});

const PostedSchema = z.strictObject({
  verdict: z.enum(["skipped", "incomplete", "would request changes", "would approve"]),
  coverage: z.strictObject({
    reviewers_ran: z.array(z.string()),
    reviewers_failed: z.array(z.string()),
    reviewers_skipped: z.array(SkippedReviewerSchema),
    reviewers_without_bash: z.array(z.strictObject({ name: z.string(), reason: z.string() })),
    sensitive_without_hunks: z.array(z.string()),
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
  queries_without_cost: integer(),
  stage_ms: z.record(z.string(), z.number()),
  errors: z.array(z.strictObject({ stage: z.string(), message: z.string() })),
});

export const RecordSchema: z.ZodType<RunRecord> = z.strictObject({
  identity: IdentitySchema,
  stages: StagesSchema,
  posted: PostedSchema,
  cost: CostSchema,
});
