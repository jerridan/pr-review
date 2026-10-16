// The metrics of one repeat of one case: the run record and its score.
import type { RunRecord } from "../schemas/record.js";
import type { ScoreResult } from "./score.js";

export type RepeatMetrics = {
  repeat: number;
  failed: boolean;
  error: string | null;
  recall: number | null;
  precision: number | null;
  posted: number;
  cost_usd: number | null;
  run_ms: number;
  judge_calls: number;
  judge_unknown: number;
  judge_cost_usd: number;
  severity_agreement: { same: number; matched: number };
};

/**
 * The metrics of a repeat whose run gave a record. Recall is null for a
 * case with no golden finding. Precision is null when no finding posted.
 * The review cost holds no judge cost.
 */
export function metrics(
  record: RunRecord,
  score: ScoreResult,
  goldenCount: number,
  repeat: number,
): RepeatMetrics {
  const posted = record.posted.findings.length;
  // Each match holds one golden finding and one posted finding.
  const matched = score.matched.length;
  return {
    repeat,
    failed: false,
    error: null,
    recall: goldenCount === 0 ? null : matched / goldenCount,
    precision: posted === 0 ? null : matched / posted,
    posted,
    cost_usd: record.cost.total_cost_usd,
    run_ms: Object.values(record.cost.stage_ms).reduce((sum, ms) => sum + ms, 0),
    judge_calls: score.judgeCalls,
    judge_unknown: score.judgeUnknown,
    judge_cost_usd: score.judgeCostUsd,
    severity_agreement: { ...score.severityAgreement },
  };
}

/** The metrics of a repeat whose run failed: the error and no values. */
export function failedMetrics(repeat: number, error: string, run_ms: number): RepeatMetrics {
  return {
    repeat,
    failed: true,
    error,
    recall: null,
    precision: null,
    posted: 0,
    cost_usd: null,
    run_ms,
    judge_calls: 0,
    judge_unknown: 0,
    judge_cost_usd: 0,
    severity_agreement: { same: 0, matched: 0 },
  };
}
