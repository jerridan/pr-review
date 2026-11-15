// The figures of a replay report, for one case and one scope (one source,
// or all sources), and their sums over the cases.
import { isPostedSeverity } from "../../schemas/verifier.js";
import type { LabelSeverity } from "../../schemas/label.js";
import { BANDS, type ReplayEntry, type ReplayResult } from "../../schemas/replay.js";
import { isQueryFailure } from "../../verify/index.js";
import type { GoldenFinding } from "../case.js";
import { noDrops, type Dropped } from "./candidates.js";

const POSTED_LABELS = ["blocking", "suggestion", "nit"] as const;
type PostedLabel = (typeof POSTED_LABELS)[number];
type ByLabel = Record<PostedLabel, number>;
const emptyLabels = (): ByLabel => ({ blocking: 0, suggestion: 0, nit: 0 });

/** The posted figures, scored by scoreRecord as the eval does. */
export type PostedFigures = {
  posted: number;
  /** The posted-label goldens that the posted findings match. */
  goldens: number;
  by_label: ByLabel;
  /** The posted findings that match no posted-label golden. */
  false_posted: number;
  recall: number | null;
  precision: number | null;
};

/** A count, the part of it that a rule takes, and the share. Null share for no count. */
type Share<K extends string> = { count: number; share: number | null } & Record<K, number>;

export type Figures = {
  candidates: number;
  /** The posted-label goldens of the case: the base of the posted recall. */
  posted_goldens: number;
  /** The posted-label goldens that the candidates match, before the verifier. */
  before: { goldens: number; by_label: ByLabel };
  /** Null when the arm gives no label: the truth prompt with no severity step. */
  posted: PostedFigures | null;
  truth: {
    /** The candidates that match a golden with a posting or dont_post label. */
    real: Share<"held">;
    /** The candidates that match a not_real golden or no golden. */
    false: Share<"rejected">;
    /** The candidates that match an unsure golden: in neither share. */
    unsure_goldens: number;
  };
  /** Over the candidates that hold and match a golden. Null when the arm gives no label. */
  severity: {
    count: number;
    same: number;
    agreement: number | null;
    post_same: number;
    post_agreement: number | null;
    /** The candidates that match a blocking golden and got a label that does not post. */
    blocking_not_posted: number;
  } | null;
  by_score: { bucket: string; count: number; real: number; real_share: number | null }[];
  in_band: number;
  /** The decisions that ended unsure. */
  unsure: number;
  /** The verifier calls that stopped on their limit. Each is also in "unsure". */
  capped: number;
  /** The verifier and severity calls that failed. */
  failed: number;
  verifications: number;
  /** The known cost of the verifier calls. */
  cost_usd: number;
  cost_per_verification: number | null;
  /** The known cost of the severity calls, a call of the pr mode split over its candidates. */
  severity_cost_usd: number;
  /** The verifier and the severity step together, per verification. */
  cost_per_finding: number | null;
  /** The tokens of the calls that give them (codex). */
  tokens: number;
  /** The external findings that the checks of the pipeline dropped, by reason. */
  dropped: Dropped;
};

const REAL_LABELS: readonly LabelSeverity[] = ["blocking", "suggestion", "nit", "dont_post"];
const isReal = (label: LabelSeverity | undefined): boolean =>
  label !== undefined && REAL_LABELS.includes(label);

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** The label that the decision and the severity figures use: the step, else the verifier. */
export const labelOf = (e: ReplayEntry): LabelSeverity | null =>
  e.severity?.label ?? (isQueryFailure(e.result) ? null : e.result.severity);

// The bucket of a result: its band, or its score range of 10.
function bucketOf(r: ReplayResult): string {
  if (r.band !== undefined) return r.band;
  if (r.score >= 90) return "90-100";
  const low = Math.max(0, Math.floor(r.score / 10) * 10);
  return `${low}-${low + 9}`;
}

// The order of the buckets: the bands from the lowest, or the score ranges.
function bucketRank(bucket: string): number {
  const band = (BANDS as readonly string[]).indexOf(bucket);
  return band >= 0 ? band : Number(bucket.split("-")[0]);
}

/**
 * The figures of the entries of one scope of one case. "posted" is the
 * scoring of the passed entries, or null. "hasLabels" is false for the
 * truth prompt with no severity step.
 */
export function caseFigures(
  entries: ReplayEntry[],
  golden: GoldenFinding[],
  posted: PostedFigures | null,
  hasLabels: boolean,
  dropped: Dropped,
): Figures {
  const before = emptyLabels();
  const matchedPosted = new Set<number>();
  for (const e of entries) {
    if (e.golden === null) continue;
    const label = e.golden.label;
    if (
      (POSTED_LABELS as readonly string[]).includes(label) &&
      !matchedPosted.has(e.golden.index)
    ) {
      matchedPosted.add(e.golden.index);
      before[label as PostedLabel] += 1;
    }
  }
  const results = entries.filter(
    (e): e is ReplayEntry & { result: ReplayResult } => !isQueryFailure(e.result),
  );
  const real = results.filter((e) => isReal(e.golden?.label));
  const fake = results.filter((e) => e.golden === null || e.golden.label === "not_real");
  const held = results.filter((e) => e.result.claim_holds && e.golden !== null);
  const labeled = held.flatMap((e) => {
    const label = labelOf(e);
    return label === null || e.golden === null ? [] : [{ label, golden: e.golden.label }];
  });
  const buckets = new Map<string, { count: number; real: number }>();
  for (const e of results) {
    const bucket = bucketOf(e.result);
    const b = buckets.get(bucket) ?? { count: 0, real: 0 };
    b.count += 1;
    if (isReal(e.golden?.label)) b.real += 1;
    buckets.set(bucket, b);
  }
  const verified = entries.filter((e) => e.call !== null);
  const cost = verified.reduce((sum, e) => sum + (e.call?.cost_usd ?? 0), 0);
  const severityCost = entries.reduce(
    (sum, e) => sum + (e.severity?.call?.cost_usd ?? 0) / Math.max(1, e.severity?.shared_by ?? 1),
    0,
  );
  const same = labeled.filter((l) => l.label === l.golden).length;
  const postSame = labeled.filter(
    (l) => isPostedSeverity(l.label) === isPostedSeverity(l.golden),
  ).length;
  return {
    candidates: entries.length,
    posted_goldens: golden.filter((g) => isPostedSeverity(g.severity)).length,
    before: { goldens: matchedPosted.size, by_label: before },
    posted,
    truth: {
      real: {
        count: real.length,
        held: real.filter((e) => e.result.claim_holds).length,
        share: ratio(real.filter((e) => e.result.claim_holds).length, real.length),
      },
      false: {
        count: fake.length,
        rejected: fake.filter((e) => !e.result.claim_holds).length,
        share: ratio(fake.filter((e) => !e.result.claim_holds).length, fake.length),
      },
      unsure_goldens: results.filter((e) => e.golden?.label === "unsure").length,
    },
    severity: hasLabels
      ? {
          count: labeled.length,
          same,
          agreement: ratio(same, labeled.length),
          post_same: postSame,
          post_agreement: ratio(postSame, labeled.length),
          blocking_not_posted: entries.filter((e) => {
            const label = labelOf(e);
            return e.golden?.label === "blocking" && label !== null && !isPostedSeverity(label);
          }).length,
        }
      : null,
    by_score: [...buckets.entries()]
      .sort(([a], [b]) => bucketRank(a) - bucketRank(b))
      .map(([bucket, b]) => ({
        bucket,
        count: b.count,
        real: b.real,
        real_share: ratio(b.real, b.count),
      })),
    in_band: entries.filter((e) => e.in_band).length,
    unsure: entries.filter((e) => e.decision?.unsure !== undefined).length,
    capped: entries.filter((e) => isQueryFailure(e.result) && e.result.kind === "limit").length,
    failed:
      entries.filter((e) => isQueryFailure(e.result)).length +
      entries.filter((e) => e.severity?.failure !== undefined).length,
    verifications: verified.length,
    cost_usd: cost,
    cost_per_verification: ratio(cost, verified.length),
    severity_cost_usd: severityCost,
    cost_per_finding: ratio(cost + severityCost, verified.length),
    tokens: entries.reduce((sum, e) => sum + (e.call?.tokens ?? 0), 0),
    dropped,
  };
}

/** The sum of the figures of the cases of one scope. Each share comes from the sums. */
export function sumFigures(rows: Figures[]): Figures {
  const sum = (pick: (f: Figures) => number): number => rows.reduce((t, f) => t + pick(f), 0);
  const labels = (pick: (f: Figures) => ByLabel | undefined): ByLabel => {
    const out = emptyLabels();
    for (const label of POSTED_LABELS) out[label] = sum((f) => pick(f)?.[label] ?? 0);
    return out;
  };
  const hasPosted = rows.length > 0 && rows.every((f) => f.posted !== null);
  const postedGoldens = sum((f) => f.posted_goldens);
  const posted = sum((f) => f.posted?.posted ?? 0);
  const matched = sum((f) => f.posted?.goldens ?? 0);
  const hasSeverity = rows.length > 0 && rows.every((f) => f.severity !== null);
  const sevCount = sum((f) => f.severity?.count ?? 0);
  const sevSame = sum((f) => f.severity?.same ?? 0);
  const sevPost = sum((f) => f.severity?.post_same ?? 0);
  const buckets = new Map<string, { count: number; real: number }>();
  for (const f of rows) {
    for (const b of f.by_score) {
      const t = buckets.get(b.bucket) ?? { count: 0, real: 0 };
      t.count += b.count;
      t.real += b.real;
      buckets.set(b.bucket, t);
    }
  }
  const realCount = sum((f) => f.truth.real.count);
  const realHeld = sum((f) => f.truth.real.held);
  const falseCount = sum((f) => f.truth.false.count);
  const falseRejected = sum((f) => f.truth.false.rejected);
  const verifications = sum((f) => f.verifications);
  const cost = sum((f) => f.cost_usd);
  const severityCost = sum((f) => f.severity_cost_usd);
  const dropped = noDrops();
  for (const f of rows) {
    for (const reason of Object.keys(dropped) as (keyof Dropped)[])
      dropped[reason] += f.dropped[reason];
  }
  return {
    candidates: sum((f) => f.candidates),
    posted_goldens: postedGoldens,
    before: { goldens: sum((f) => f.before.goldens), by_label: labels((f) => f.before.by_label) },
    posted: hasPosted
      ? {
          posted,
          goldens: matched,
          by_label: labels((f) => f.posted?.by_label),
          false_posted: sum((f) => f.posted?.false_posted ?? 0),
          recall: ratio(matched, postedGoldens),
          precision: ratio(matched, posted),
        }
      : null,
    truth: {
      real: { count: realCount, held: realHeld, share: ratio(realHeld, realCount) },
      false: {
        count: falseCount,
        rejected: falseRejected,
        share: ratio(falseRejected, falseCount),
      },
      unsure_goldens: sum((f) => f.truth.unsure_goldens),
    },
    severity: hasSeverity
      ? {
          count: sevCount,
          same: sevSame,
          agreement: ratio(sevSame, sevCount),
          post_same: sevPost,
          post_agreement: ratio(sevPost, sevCount),
          blocking_not_posted: sum((f) => f.severity?.blocking_not_posted ?? 0),
        }
      : null,
    by_score: [...buckets.entries()]
      .sort(([a], [b]) => bucketRank(a) - bucketRank(b))
      .map(([bucket, b]) => ({
        bucket,
        count: b.count,
        real: b.real,
        real_share: ratio(b.real, b.count),
      })),
    in_band: sum((f) => f.in_band),
    unsure: sum((f) => f.unsure),
    capped: sum((f) => f.capped),
    failed: sum((f) => f.failed),
    verifications,
    cost_usd: cost,
    cost_per_verification: ratio(cost, verifications),
    severity_cost_usd: severityCost,
    cost_per_finding: ratio(cost + severityCost, verifications),
    tokens: sum((f) => f.tokens),
    dropped,
  };
}
