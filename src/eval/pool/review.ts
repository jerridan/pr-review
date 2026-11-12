// The blind reviews of a case: "n" by Claude and "n" by GPT. Each review
// sees the PR title and body, the changed files, the diff and the checkout.
// No review sees a record, a golden, a PR comment or another review.
import { createHash } from "node:crypto";
import { z } from "zod";
import { claudeCall, gptCall, type PoolContext } from "./calls.js";
import { reviewMessage, type ReviewInput } from "./prompts.js";
import { PoolFindingSchema, ReviewOutputSchema, type PoolFinding } from "./schemas.js";

/** One blind review. "costUsd" is the cost of a Claude review, with its retry. */
export type ReviewRun = { source: string; costUsd?: number } & (
  { ok: true; findings: PoolFinding[] } | { ok: false; error: string }
);

const KeptReviewSchema = z.object({
  findings: z.array(PoolFindingSchema),
  costUsd: z.number().optional(),
});

/** Run the blind reviews in parallel. The runs come back Claude first, each family in order. */
export async function blindReviews(
  input: ReviewInput,
  n: number,
  ctx: PoolContext,
): Promise<ReviewRun[]> {
  const m = reviewMessage(input);
  // A kept review is for the same source and the same input. The request
  // text holds random tags, so the key hashes the input.
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const keyOf = (source: string) => `${source}:${digest}`;
  const kept = (source: string): ReviewRun | undefined => {
    const k = ctx.memo?.get("review", keyOf(source), KeptReviewSchema);
    return k === undefined ? undefined : { source, ok: true, ...k };
  };
  const keep = (run: ReviewRun): void => {
    if (run.ok) {
      ctx.memo?.set("review", keyOf(run.source), { findings: run.findings, costUsd: run.costUsd });
    }
  };
  const runs: Promise<ReviewRun>[] = [];
  for (let i = 1; i <= n; i++) {
    const source = `claude-review-${i}`;
    const old = kept(source);
    if (old) {
      runs.push(Promise.resolve(old));
      continue;
    }
    // Each Claude review counts its own cost, then adds it to the case cost.
    const own: PoolContext = { ...ctx, cost: { usd: 0 } };
    runs.push(
      claudeCall("pool-reviewer", m, ReviewOutputSchema, own).then((r): ReviewRun => {
        ctx.cost.usd += own.cost.usd;
        const costUsd = own.cost.usd;
        const run: ReviewRun = r.ok
          ? { source, costUsd, ok: true, findings: r.value.findings }
          : { source, costUsd, ok: false, error: r.error };
        keep(run);
        return run;
      }),
    );
  }
  for (let i = 1; i <= n; i++) {
    const source = `gpt-review-${i}`;
    const old = kept(source);
    if (old) {
      runs.push(Promise.resolve(old));
      continue;
    }
    runs.push(
      gptCall(m, ReviewOutputSchema, "review", ctx).then((r): ReviewRun => {
        const run: ReviewRun = r.ok
          ? { source, ok: true, findings: r.value.findings }
          : { source, ok: false, error: r.error };
        keep(run);
        return run;
      }),
    );
  }
  return Promise.all(runs);
}
