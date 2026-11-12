// Default model, effort and limits for each role. A model change is a
// change to this file, so the harness can measure it.

export type Role = "triage" | "reviewer" | "verifier" | "verifier-escalation" | "merge" | "smoke";

/**
 * The roles of the eval, not of a run. "judge" scores the eval, "labeler"
 * labels a golden, and the three "pool" roles build a pooled golden set.
 * They are not in ROLES, a run record has no entry for them, and a repo
 * config cannot set them.
 */
export type EvalRole = "judge" | "labeler" | "pool-reviewer" | "pool-grouper" | "adjudicator";

/** The role of one query. */
export type QueryRole = Role | EvalRole;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleConfig {
  model: string;
  effort: Effort;
  maxTurns: number;
  maxBudgetUsd: number;
  /**
   * The wall-clock limit of one query, in milliseconds. The client aborts
   * a query that runs longer, so a hung process does not hold its
   * semaphore slot.
   */
  timeoutMs: number;
  tools: "read-only" | "none";
}

export const MODEL_IDS: {
  opus: "claude-opus-5-5";
  sonnet: "claude-sonnet-5-5";
  haiku: "claude-haiku-5-5";
} = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

export const ROLES: readonly Role[] = [
  "triage",
  "reviewer",
  "verifier",
  "verifier-escalation",
  "merge",
  "smoke",
];

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const ROLE_DEFAULTS: Record<Role, RoleConfig> = {
  triage: {
    model: MODEL_IDS.sonnet,
    effort: "medium",
    maxTurns: 5,
    maxBudgetUsd: 0.5,
    timeoutMs: 120_000,
    tools: "none",
  },
  reviewer: {
    model: MODEL_IDS.opus,
    effort: "low",
    maxTurns: 40,
    maxBudgetUsd: 2,
    timeoutMs: 600_000,
    tools: "read-only",
  },
  verifier: {
    model: MODEL_IDS.sonnet,
    effort: "high",
    maxTurns: 25,
    maxBudgetUsd: 0.5,
    timeoutMs: 300_000,
    tools: "read-only",
  },
  "verifier-escalation": {
    model: MODEL_IDS.opus,
    effort: "high",
    maxTurns: 25,
    maxBudgetUsd: 1,
    timeoutMs: 300_000,
    tools: "read-only",
  },
  merge: {
    model: MODEL_IDS.sonnet,
    effort: "medium",
    maxTurns: 5,
    maxBudgetUsd: 0.25,
    timeoutMs: 120_000,
    tools: "none",
  },
  smoke: {
    model: MODEL_IDS.sonnet,
    effort: "low",
    maxTurns: 2,
    maxBudgetUsd: 0.05,
    timeoutMs: 60_000,
    tools: "none",
  },
};

/**
 * The judge of the eval. It runs on a different model from the reviewer
 * role, with no tools. Effort "high" turns thinking on.
 */
export const JUDGE_DEFAULTS: RoleConfig = {
  model: MODEL_IDS.sonnet,
  effort: "high",
  maxTurns: 5,
  maxBudgetUsd: 0.25,
  timeoutMs: 120_000,
  tools: "none",
};

/**
 * The scorer of the severity labeler. Its model is pinned apart from the
 * pipeline roles, so a golden label does not change when they change.
 */
export const LABELER_DEFAULTS: RoleConfig = {
  // The literal id is on purpose: the pin stays apart from the pipeline roles.
  model: "claude-opus-5-5",
  effort: "high",
  maxTurns: 5,
  maxBudgetUsd: 0.5,
  timeoutMs: 300_000,
  tools: "none",
};

/**
 * The blind reviewer of the pool. It reviews a case with no record and no
 * golden. Its pin stays apart from the pipeline roles, so the pool does
 * not change when they change.
 */
export const POOL_REVIEWER_DEFAULTS: RoleConfig = {
  // The literal id is on purpose: the pin stays apart from the pipeline roles.
  model: "claude-opus-5-5",
  effort: "high",
  maxTurns: 40,
  maxBudgetUsd: 2,
  timeoutMs: 900_000,
  tools: "read-only",
};

/** The adjudicator of the pool: it scores one pool item at the case head. */
export const ADJUDICATOR_DEFAULTS: RoleConfig = {
  model: "claude-opus-5-5",
  effort: "high",
  maxTurns: 25,
  maxBudgetUsd: 1,
  timeoutMs: 600_000,
  tools: "read-only",
};

/** The grouping of the pool: it joins the items that state the same defect. */
export const POOL_GROUPER_DEFAULTS: RoleConfig = {
  model: "claude-sonnet-5-5",
  effort: "high",
  maxTurns: 5,
  maxBudgetUsd: 0.5,
  timeoutMs: 300_000,
  tools: "none",
};

const EVAL_DEFAULTS: Record<EvalRole, RoleConfig> = {
  judge: JUDGE_DEFAULTS,
  labeler: LABELER_DEFAULTS,
  "pool-reviewer": POOL_REVIEWER_DEFAULTS,
  "pool-grouper": POOL_GROUPER_DEFAULTS,
  adjudicator: ADJUDICATOR_DEFAULTS,
};

/** Give true when "role" is a role of the eval, not of a run. */
export function isEvalRole(role: QueryRole): role is EvalRole {
  return Object.hasOwn(EVAL_DEFAULTS, role);
}

/** The defaults of the role of one query. */
export function roleConfig(role: QueryRole): RoleConfig {
  if (isEvalRole(role)) return EVAL_DEFAULTS[role];
  return ROLE_DEFAULTS[role];
}

// An exact model ID starts with "claude-". Any other value must be an alias.
const MODEL_ID_PATTERN = /^claude-[a-z0-9][a-z0-9.-]*$/;

/**
 * Map an alias (opus, sonnet, haiku) to its pinned ID. Pass an exact ID
 * through. Throw on an unknown alias.
 */
export function resolveModel(aliasOrId: string): string {
  const value = aliasOrId.trim();
  const alias = value.toLowerCase();
  if (alias === "opus" || alias === "sonnet" || alias === "haiku") {
    return MODEL_IDS[alias];
  }
  if (MODEL_ID_PATTERN.test(value)) return value;
  throw new Error(
    `Unknown model "${aliasOrId}". Use opus, sonnet, haiku or an exact ID that starts with "claude-".`,
  );
}
