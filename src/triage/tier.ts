// Decide the review tier. The first rule that applies wins (R4):
// 1. the --tier override,
// 2. the labels review:skip, review:fast and review:full, in that order,
// 3. the skip rules of the repo config, for a pull request only,
// 4. zero hunks means skip,
// 5. a sensitive path sets a floor of full,
// 6. a triage failure or low confidence gives full, else the triage brief.
//    On a later run, the triage result is the higher of this run's triage
//    tier and the triage tier of the prior record (R7).
import type { RepoConfig } from "../config/repo-config.js";
import type { TriageBrief } from "../schemas/triage.js";

export type Tier = "skip" | "fast" | "full";

/** The pull request data that the tier rules read. The title is sanitized. */
export type TierPullRequest = { draft: boolean; title: string; author: string };

/** The inputs of the rules that come before the diff: rules 1 to 3. */
export type PreTierInput = {
  override?: Tier;
  labels?: string[];
  pr?: TierPullRequest | null;
  skip?: RepoConfig["skip"];
};

// The tier labels, in their order of precedence.
const TIER_LABELS: { label: string; tier: Tier; reason: string }[] = [
  { label: "review:skip", tier: "skip", reason: "Label review:skip sets the tier skip." },
  { label: "review:fast", tier: "fast", reason: "Label review:fast sets the tier fast." },
  { label: "review:full", tier: "full", reason: "Label review:full sets a floor of full." },
];

// GitHub compares label names and logins without regard to case.
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// Give the reason of the first skip rule that matches the pull request,
// or null. Each reason names the rule and the config value that matched.
function skipRuleReason(
  pr: TierPullRequest,
  labels: string[],
  skip: RepoConfig["skip"],
): string | null {
  if (skip.draft && pr.draft) {
    return "Skip rule skip.draft: the pull request is a draft.";
  }
  const title = pr.title.toLowerCase();
  const keyword = skip.title_keywords.find((k) => k !== "" && title.includes(k.toLowerCase()));
  if (keyword !== undefined) {
    return `Skip rule skip.title_keywords: the title contains "${keyword}".`;
  }
  const label = skip.labels.find((l) => labels.some((have) => same(have, l)));
  if (label !== undefined) {
    return `Skip rule skip.labels: the pull request has the label "${label}".`;
  }
  const author = skip.bot_authors.find((a) => same(a, pr.author));
  if (author !== undefined) {
    return `Skip rule skip.bot_authors: the author is "${author}".`;
  }
  return null;
}

/**
 * Give the decision of rules 1 to 3, or null when none applies. These
 * rules need no diff, so the run can use them before gather.
 */
export function preTier(input: PreTierInput): { tier: Tier; reason: string } | null {
  if (input.override) {
    return { tier: input.override, reason: `Tier set by --tier ${input.override}.` };
  }
  const labels = input.labels ?? [];
  for (const entry of TIER_LABELS) {
    if (labels.some((l) => same(l, entry.label))) return { tier: entry.tier, reason: entry.reason };
  }
  if (input.pr && input.skip) {
    const reason = skipRuleReason(input.pr, labels, input.skip);
    if (reason !== null) return { tier: "skip", reason };
  }
  return null;
}

/**
 * Return true when the triage query runs. It does not run when an earlier
 * rule sets skip, or when no hunks remain, because the diff is then empty.
 */
export function shouldRunTriage(input: PreTierInput & { totalHunks: number }): boolean {
  return preTier(input)?.tier !== "skip" && input.totalHunks > 0;
}

// The order of the tiers, so that one tier can be higher than another.
const TIER_RANK: Record<Tier, number> = { skip: 0, fast: 1, full: 2 };

export function decideTier(input: {
  override?: Tier;
  /** The triage tier of the prior record of a later run, or null. */
  priorTriageTier?: Tier | null;
  labels?: string[];
  pr?: TierPullRequest | null;
  skip: RepoConfig["skip"];
  totalHunks: number;
  sensitive: string[];
  brief: TriageBrief | null;
  triageFailed: boolean;
}): { tier: Tier; reason: string; triageRan: boolean } {
  const triageRan = shouldRunTriage(input);
  const result = (tier: Tier, reason: string) => ({ tier, reason, triageRan });

  const early = preTier(input);
  if (early) return result(early.tier, early.reason);
  if (input.totalHunks === 0) {
    return result("skip", "No hunks remain after exclusions.");
  }
  if (input.sensitive.length > 0) {
    return result("full", `Sensitive paths set a floor of full: ${input.sensitive.join(", ")}.`);
  }
  if (input.triageFailed) {
    return result("full", "Triage failed, so the review is full.");
  }
  if (!input.brief) {
    return result("full", "No triage brief, so the review is full.");
  }
  if (input.brief.confidence === "low") {
    return result("full", "Triage has low confidence, so the review is full.");
  }
  // Triage never lowers the tier between runs.
  const prior = input.priorTriageTier ?? null;
  if (prior !== null && TIER_RANK[prior] > TIER_RANK[input.brief.tier]) {
    const reason = input.brief.reason.replace(/\.$/, "");
    return result(prior, `Triage: ${reason}. The tier stays ${prior} from the prior record.`);
  }
  return result(input.brief.tier, `Triage: ${input.brief.reason}`);
}
