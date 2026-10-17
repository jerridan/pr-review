// Default model, effort and limits for each role. A model change is a
// change to this file, so the harness can measure it.

export type Role = "triage" | "reviewer" | "verifier" | "verifier-escalation" | "merge" | "smoke";

/**
 * The role of one query. "judge" is a role of the eval, not of a run: it
 * is not in ROLES, a run record has no entry for it, and a repo config
 * cannot set it.
 */
export type QueryRole = Role | "judge";

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

/** The defaults of the role of one query. */
export function roleConfig(role: QueryRole): RoleConfig {
  return role === "judge" ? JUDGE_DEFAULTS : ROLE_DEFAULTS[role];
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
