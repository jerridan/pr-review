// The blind reviews of a case: "n" by Claude and "n" by GPT. Each review
// sees the PR title and body, the changed files, the diff and the checkout.
// No review sees a record, a golden, a PR comment or another review.
import { claudeCall, gptCall, type PoolContext } from "./calls.js";
import { reviewMessage, type ReviewInput } from "./prompts.js";
import { ReviewOutputSchema, type PoolFinding } from "./schemas.js";

export type ReviewRun =
  | { source: string; ok: true; findings: PoolFinding[] }
  | { source: string; ok: false; error: string };

/** Run the blind reviews in parallel. The runs come back Claude first, each family in order. */
export async function blindReviews(
  input: ReviewInput,
  n: number,
  ctx: PoolContext,
): Promise<ReviewRun[]> {
  const m = reviewMessage(input);
  const runs: Promise<ReviewRun>[] = [];
  for (let i = 1; i <= n; i++) {
    const source = `claude-review-${i}`;
    runs.push(
      claudeCall("pool-reviewer", m, ReviewOutputSchema, ctx).then((r) =>
        r.ok
          ? { source, ok: true, findings: r.value.findings }
          : { source, ok: false, error: r.error },
      ),
    );
  }
  for (let i = 1; i <= n; i++) {
    const source = `gpt-review-${i}`;
    runs.push(
      gptCall(m, ReviewOutputSchema, "review", ctx).then((r) =>
        r.ok
          ? { source, ok: true, findings: r.value.findings }
          : { source, ok: false, error: r.error },
      ),
    );
  }
  return Promise.all(runs);
}
