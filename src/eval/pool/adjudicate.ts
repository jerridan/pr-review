// The adjudication of one finding: one Claude call and one GPT call, with
// the same prompt. Each answers if the claim is true at the case head and
// belongs to the PR. The finding is kept when both scores reach the
// threshold. "pr-review pool" and "pr-review adjudicate" both use it.
import { sixFields } from "./schemas.js";
import {
  claudeCall,
  claudeModelId,
  GPT_MODEL_ID,
  gptCall,
  type CallResult,
  type Check,
  type PoolContext,
} from "./calls.js";
import { adjudicateMessage, promptDigest } from "./prompts.js";
import { AdjudicationOutputSchema, type AdjudicationOutput, type PoolFinding } from "./schemas.js";

/** The lowest score of each family that keeps a finding. */
export const KEEP_SCORE = 75;

/**
 * A score below this value means that the claim is false at the head, or
 * that it rests on lines the PR does not change or expose.
 */
export const DISMISS_BELOW = 50;

/** The result of one family: its answer, or the error of a failed call. */
export type FamilyResult = AdjudicationOutput | { failed: string };

export type Adjudication = { claude: FamilyResult; gpt: FamilyResult; kept: boolean };

const checkScore: Check<AdjudicationOutput> = (v) =>
  v.score >= 0 && v.score <= 100 ? null : `the score ${v.score} is not from 0 to 100`;

/** Give the score of "r", or null for a failed call. */
export function scoreOf(r: FamilyResult): number | null {
  return "failed" in r ? null : r.score;
}

/**
 * Adjudicate one finding in the case checkout of "ctx". "diff" is the
 * diff of the case. The two calls go in parallel. A failed call gives
 * "failed" for its family, and the finding is not kept.
 */
export async function adjudicateFinding(
  finding: PoolFinding,
  diff: string,
  ctx: PoolContext,
): Promise<Adjudication> {
  const m = adjudicateMessage(finding, diff);
  // A kept result is for the same family and the same item text.
  const text = JSON.stringify(sixFields(finding));
  const run = async (
    family: "claude" | "gpt",
    call: () => ReturnType<typeof gptCall<AdjudicationOutput>>,
  ): Promise<CallResult<AdjudicationOutput>> => {
    const model = family === "claude" ? claudeModelId("adjudicator") : GPT_MODEL_ID;
    const key = `${family}:${model}:${promptDigest("pool-adjudicate.md")}:${text}`;
    const old = ctx.memo?.get("adjudication", key, AdjudicationOutputSchema, checkScore);
    if (old !== undefined) return { ok: true, value: old };
    const r = await call();
    if (r.ok) ctx.memo?.set("adjudication", key, r.value);
    return r;
  };
  const [claude, gpt] = await Promise.all([
    run("claude", () => claudeCall("adjudicator", m, AdjudicationOutputSchema, ctx, checkScore)),
    run("gpt", () => gptCall(m, AdjudicationOutputSchema, "adjudication", ctx, checkScore)),
  ]);
  const result = (r: typeof claude): FamilyResult =>
    r.ok
      ? {
          score: r.value.score,
          reason: r.value.reason,
          start_line: r.value.start_line,
          end_line: r.value.end_line,
        }
      : { failed: r.error };
  const c = result(claude);
  const g = result(gpt);
  const cs = scoreOf(c);
  const gs = scoreOf(g);
  const kept = cs !== null && gs !== null && cs >= KEEP_SCORE && gs >= KEEP_SCORE;
  return { claude: c, gpt: g, kept };
}
