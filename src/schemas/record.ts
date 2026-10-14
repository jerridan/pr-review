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
  /** The normalized span text that the fingerprint hashes (normalizeWs of the head lines). */
  span_text: string;
};

/** What the run posted to GitHub with --format github (R5, R6). */
export type PostedGitHub = {
  /** Both are null when the review did not post. */
  review_id: number | null;
  review_url: string | null;
  /**
   * The login of the author of the posted review, as GitHub gives it. A
   * later run finds its own posts by this login. Null when the review did
   * not post or the run could not read the author.
   */
  author: string | null;
  /** The error text of a review that did not post, or null. */
  error: string | null;
  inline: { fingerprint: string; comment_id: number }[];
  /** The fingerprints of the findings in the review body. */
  in_body: string[];
  /** The check run, or its error. Null when no check run was tried. */
  check_run: { id: number } | { error: string } | null;
  cleanup_comment_id: number | null;
  /** The threads that the run resolved. */
  resolved: { thread_id: string; fingerprint: string }[];
  /** The failed steps after the review: the cleanup comment, a thread resolve, a reply. */
  errors: { step: string; message: string }[];
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

/** The prior state of a later or fresh run, as the record holds it (R8). */
export type PriorIdentity = {
  /** The last reviewed head, H0. */
  head: string;
  source: "record" | "marker" | null;
  /** The path of the prior record, or null. */
  record: string | null;
  open: string[];
  dismissed: string[];
  /** True when H0 was not in the store and the fetch failed: the run is then fresh. */
  fetch_failed: boolean;
};

/** The pull request of a --pr run, as the record holds it (R2). */
export type GitHubIdentity = {
  slug: string;
  /** The sanitized title. */
  title: string;
  draft: boolean;
  labels: string[];
  author: string;
  author_type: string;
  /** False for a fork, whatever the permission level and the flag. */
  author_write_access: boolean;
  fork: boolean;
  head_repo: string;
  url: string;
};

export type RunRecord = {
  identity: {
    repo: string;
    /** The pull request number of a --pr run, or null. */
    pr: number | null;
    /** The pull request of a --pr run, or null. */
    github: GitHubIdentity | null;
    /** A first run, a later run, or a fresh run (R7, R8). */
    run_kind: "first" | "later" | "fresh";
    /** The prior state of a later or fresh run, or null. */
    prior: PriorIdentity | null;
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
    /**
     * Where the description came from, whether the sanitizer changed it,
     * and whether the sanitizer cut it (R3).
     */
    description_meta: { source: "pr" | "commits"; sanitized: boolean; truncated: boolean };
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
    /**
     * The verified pre-existing findings (R6): out of scope, but real, with
     * a score at or above the threshold and a quote in the head file.
     */
    pre_existing: PostedFinding[];
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
    /** What the run posted with --format github, or null when it tried no review. */
    github: PostedGitHub | null;
    /** The new findings below blocking that a later run did not post (R7). */
    below_floor: PostedFinding[];
    /** The new findings whose fingerprint was open or dismissed (R7). */
    not_reposted: { fingerprint: string; reason: "open" | "dismissed" }[];
    /** The full finding of each open fingerprint of earlier runs that this run did not post (R7). */
    carried: PostedFinding[];
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
  span_text: z.string(),
});

export const PostedGitHubSchema: z.ZodType<PostedGitHub> = z.strictObject({
  review_id: integer().nullable(),
  review_url: z.string().nullable(),
  author: z.string().nullable(),
  error: z.string().nullable(),
  inline: z.array(z.strictObject({ fingerprint: z.string(), comment_id: integer() })),
  in_body: z.array(z.string()),
  check_run: z
    .union([z.strictObject({ id: integer() }), z.strictObject({ error: z.string() })])
    .nullable(),
  cleanup_comment_id: integer().nullable(),
  resolved: z.array(z.strictObject({ thread_id: z.string(), fingerprint: z.string() })),
  errors: z.array(z.strictObject({ step: z.string(), message: z.string() })),
});

const roleEnum = z.enum(ROLES as readonly [Role, ...Role[]]);
const effortEnum = z.enum(EFFORTS as readonly [Effort, ...Effort[]]);
const verifierOrFailure = z.union([VerifierResultSchema, QueryFailureSchema]);

const GitHubIdentitySchema = z.strictObject({
  slug: z.string(),
  title: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()),
  author: z.string(),
  author_type: z.string(),
  author_write_access: z.boolean(),
  fork: z.boolean(),
  head_repo: z.string(),
  url: z.string(),
});

const IdentitySchema = z.strictObject({
  repo: z.string(),
  pr: integer().min(1).nullable(),
  github: GitHubIdentitySchema.nullable(),
  run_kind: z.enum(["first", "later", "fresh"]),
  prior: z
    .strictObject({
      head: z.string(),
      source: z.enum(["record", "marker"]).nullable(),
      record: z.string().nullable(),
      open: z.array(z.string()),
      dismissed: z.array(z.string()),
      fetch_failed: z.boolean(),
    })
    .nullable(),
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
  description_meta: z.strictObject({
    source: z.enum(["pr", "commits"]),
    sanitized: z.boolean(),
    truncated: z.boolean(),
  }),
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
  pre_existing: z.array(PostedFindingSchema),
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
  github: PostedGitHubSchema.nullable(),
  below_floor: z.array(PostedFindingSchema),
  not_reposted: z.array(
    z.strictObject({ fingerprint: z.string(), reason: z.enum(["open", "dismissed"]) }),
  ),
  carried: z.array(PostedFindingSchema),
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
