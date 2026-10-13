// The verdict and the coverage line of a run.
import type { ReviewerRun } from "./find/index.js";
import type { PostedFinding, QueryFailure, RunRecord, SkippedReviewer } from "./schemas/record.js";
import type { VerifierResult } from "./schemas/verifier.js";
import type { Tier } from "./triage/tier.js";
import type { Verification } from "./verify/index.js";

/**
 * The first rule that matches sets the verdict: skipped for the skip
 * tier; incomplete when a reviewer failed, a verifier call failed, code
 * rejected a verifier result, a reviewer or verifier call was refused, or
 * a reviewer pass did not start because of the token ceiling; would
 * request changes with a blocking finding; else would approve.
 * "verifierFailures" counts the failed calls and the rejected results.
 * "ceilingSkips" counts the passes that the token ceiling stopped.
 */
export function decideVerdict(input: {
  tier: Tier;
  reviewerRuns: ReviewerRun[];
  verifierFailures: number;
  refusals: number;
  posted: PostedFinding[];
  ceilingSkips?: number;
}): RunRecord["posted"]["verdict"] {
  if (input.tier === "skip") return "skipped";
  const reviewerFailed = input.reviewerRuns.some((run) => run.status === "failed");
  const ceilingHit = (input.ceilingSkips ?? 0) > 0;
  if (reviewerFailed || input.verifierFailures > 0 || input.refusals > 0 || ceilingHit) {
    return "incomplete";
  }
  if (input.posted.some((p) => p.severity === "blocking")) return "would request changes";
  return "would approve";
}

function uniqueNames(runs: ReviewerRun[]): string[] {
  return [...new Set(runs.map((run) => run.name))];
}

/**
 * The reviewers that ran with no failed pass, the reviewers with a failed
 * pass, the selected reviewers or passes that did not run, the custom
 * reviewers that ran without the Bash they asked for, the sensitive paths
 * with no text hunk, and the findings dropped because their verifier call
 * failed or because code rejected their verifier result.
 */
export function coverage(
  reviewerRuns: ReviewerRun[],
  verifierFailures: number,
  skipped: SkippedReviewer[] = [],
  withoutBash: { name: string; reason: string }[] = [],
  sensitiveWithoutHunks: string[] = [],
): RunRecord["posted"]["coverage"] {
  const failed = new Set(reviewerRuns.filter((r) => r.status === "failed").map((r) => r.name));
  const names = uniqueNames(reviewerRuns);
  return {
    reviewers_ran: names.filter((name) => !failed.has(name)),
    reviewers_failed: names.filter((name) => failed.has(name)),
    reviewers_skipped: skipped,
    reviewers_without_bash: withoutBash,
    sensitive_without_hunks: sensitiveWithoutHunks,
    findings_dropped_by_failed_verifier: verifierFailures,
  };
}

type VerifierCall = VerifierResult | QueryFailure;

function failureOf(value: VerifierCall | undefined): QueryFailure | null {
  return value !== undefined && "kind" in value ? value : null;
}

/**
 * Count from the stage outputs: the findings dropped because a verifier
 * call failed or because code rejected a result that the verifier passed
 * (for coverage); every failed verifier call, first or escalation, and
 * every rejected result (for the verdict); and every reviewer or verifier
 * call that ended in a refusal.
 */
export function verificationCounts(
  reviewerRuns: ReviewerRun[],
  verifications: Verification[],
): {
  droppedByFailedVerifier: number;
  failedVerifierCalls: number;
  rejectedResults: number;
  refusals: number;
} {
  let droppedByFailedVerifier = 0;
  let failedVerifierCalls = 0;
  let rejectedResults = 0;
  let refusals = reviewerRuns.filter((r) => r.failure?.kind === "refusal").length;
  for (const v of verifications) {
    // A failed first call stops the verification, so at most one call of
    // a finding fails, and the finding is dropped.
    const failures = [failureOf(v.first), failureOf(v.escalated)].filter(
      (f): f is QueryFailure => f !== null,
    );
    // A rejected result drops a finding that the verifier confirmed.
    if (v.rejected) rejectedResults += 1;
    if (failures.length > 0 || v.rejected) droppedByFailedVerifier += 1;
    failedVerifierCalls += failures.length;
    refusals += failures.filter((f) => f.kind === "refusal").length;
  }
  return { droppedByFailedVerifier, failedVerifierCalls, rejectedResults, refusals };
}
