// Select the reviewers for a run from their triggers.
import { matchesAny } from "../config/globs.js";
import type { RepoConfig } from "../config/repo-config.js";
import type { SkippedReviewer } from "../schemas/record.js";
import type { Tier } from "../triage/tier.js";
import { reviewerEntry, type ReviewerDefinition } from "./loader.js";

/** The reviewer that needs a description. With no description, it does not run. */
export const DESCRIPTION_REVIEWER = "description-drift";

const TIER_RANK: Record<Tier, number> = { skip: 0, fast: 1, full: 2 };

/**
 * Pick each reviewer whose min_tier is at or below the tier, whose paths
 * are empty or match a changed file, and whose categories are empty or
 * match a triage category. The skip tier picks no reviewer. "trigger"
 * tells why the reviewer runs.
 */
export function selectReviewers(
  defs: ReviewerDefinition[],
  tier: Tier,
  changedFiles: string[],
  categories: string[],
): { def: ReviewerDefinition; trigger: string }[] {
  if (tier === "skip") return [];
  const triageCategories = new Set(categories.map((c) => c.toLowerCase()));
  const picked: { def: ReviewerDefinition; trigger: string }[] = [];

  for (const def of defs) {
    const { paths, categories: wanted, min_tier: minTier } = def.frontmatter.triggers;
    if (TIER_RANK[minTier] > TIER_RANK[tier]) continue;

    let pathPart = "paths: any";
    if (paths.length > 0) {
      let match: string | null = null;
      for (const file of changedFiles) {
        const glob = paths.find((g) => matchesAny(file, [g]));
        if (glob) {
          match = `path ${file} matches ${glob}`;
          break;
        }
      }
      if (!match) continue;
      pathPart = match;
    }

    let categoryPart = "categories: any";
    if (wanted.length > 0) {
      const hit = wanted.find((c) => triageCategories.has(c.toLowerCase()));
      if (!hit) continue;
      categoryPart = `category ${hit.toLowerCase()}`;
    }

    picked.push({ def, trigger: `min_tier ${minTier} <= ${tier}; ${pathPart}; ${categoryPart}` });
  }
  return picked;
}

/**
 * Split the selected reviewers into the ones that run and the ones that
 * are skipped. A reviewer that the config disables is skipped with the
 * reason "disabled by config". The description reviewer is skipped with
 * the reason "no description" when the description is empty. Only a
 * selected reviewer can be skipped, so a reviewer that the tier or the
 * triggers do not select is in neither list.
 */
export function skipSelected<T extends { def: ReviewerDefinition }>(
  selected: T[],
  context: { config: RepoConfig; description: string },
): { run: T[]; skipped: SkippedReviewer[] } {
  const run: T[] = [];
  const skipped: SkippedReviewer[] = [];
  for (const s of selected) {
    const name = s.def.frontmatter.name;
    if (reviewerEntry(context.config, name)?.enabled === false) {
      skipped.push({ name, reason: "disabled by config" });
    } else if (name === DESCRIPTION_REVIEWER && context.description.trim() === "") {
      skipped.push({ name, reason: "no description" });
    } else {
      run.push(s);
    }
  }
  return { run, skipped };
}
