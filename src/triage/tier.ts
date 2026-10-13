// Decide the review tier. The first rule that applies wins:
// 1. the --tier override, 2. zero hunks means skip, 3. a sensitive path
// sets a floor of full, 4. a triage failure or low confidence gives full,
// 5. the triage brief.
import type { TriageBrief } from "../schemas/triage.js";

export type Tier = "skip" | "fast" | "full";

/**
 * Return true when the triage query runs. It does not run when an earlier
 * rule sets skip, or when no hunks remain, because the diff is then empty.
 */
export function shouldRunTriage(input: { override?: Tier; totalHunks: number }): boolean {
  return input.override !== "skip" && input.totalHunks > 0;
}

export function decideTier(input: {
  override?: Tier;
  totalHunks: number;
  sensitive: string[];
  brief: TriageBrief | null;
  triageFailed: boolean;
}): { tier: Tier; reason: string; triageRan: boolean } {
  const triageRan = shouldRunTriage(input);
  const result = (tier: Tier, reason: string) => ({ tier, reason, triageRan });

  if (input.override) {
    return result(input.override, `Tier set by --tier ${input.override}.`);
  }
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
  return result(input.brief.tier, `Triage: ${input.brief.reason}`);
}
