// The report of an eval: the metrics of each repeat of each case, the
// mean of each repeat over the cases, and the spread of those means.
import type { Gate } from "./baseline.js";
import type { RepeatMetrics } from "./metrics.js";

export type Spread = { mean: number | null; min: number | null; max: number | null };

type CaseMetrics = { name: string; repeats: RepeatMetrics[] };

export type Report = {
  cases: CaseMetrics[];
  repeats: {
    repeat: number;
    raw_recall: number | null;
    recall: number | null;
    precision: number | null;
    findings_per_case: number | null;
    cost_per_case: number | null;
    /** The drops of the repeat, summed over its cases. */
    drops: Record<string, number>;
    /** Pooled like the precision. Null when no case of the repeat has a value. */
    adjudicated_precision: number | null;
    /** The mean over the cases of the judge cost: the judge cost per PR. */
    judge_cost_per_case: number | null;
  }[];
  aggregate: {
    raw_recall: Spread;
    recall: Spread;
    precision: Spread;
    findings_per_case: Spread;
    cost_per_case: Spread;
    /** The drops of every repeat that did not fail, summed. */
    drops: Record<string, number>;
    adjudicated_precision: Spread;
    judge_cost_per_case: Spread;
  };
  /**
   * "calls" and "cost_usd" hold both judges. "unknown" holds the match
   * judge only, and "extras_unknown" the extras judge only.
   */
  judge: { calls: number; unknown: number; extras_unknown: number; cost_usd: number };
  failed_repeats: { case: string; repeat: number; error: string }[];
  gate: Gate | null;
  cases_ref: string | null;
};

/** The mean of the values that are not null. A mean of no value is null. */
function mean(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, v) => sum + v, 0) / known.length;
}

function spread(values: (number | null)[]): Spread {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return { mean: null, min: null, max: null };
  return { mean: mean(known), min: Math.min(...known), max: Math.max(...known) };
}

/**
 * The precision of a repeat, pooled over its cases: the matched posted
 * findings divided by the posted findings. Null when no case posted a
 * finding. One case with one wrong finding then moves the repeat by its
 * share of the findings, not by a whole case.
 */
function pooledPrecision(repeats: RepeatMetrics[]): number | null {
  const posted = repeats.reduce((sum, r) => sum + r.posted, 0);
  if (posted === 0) return null;
  return repeats.reduce((sum, r) => sum + r.matched, 0) / posted;
}

/**
 * The adjudicated precision of a repeat, pooled over its cases like the
 * precision: the matched and the accepted posted findings, over the posted
 * findings. Only the cases with a value count. Null when no case has one,
 * for example when extras are off.
 */
function pooledAdjudicated(repeats: RepeatMetrics[]): number | null {
  const judged = repeats.filter((r) => r.adjudicated_precision !== null);
  const posted = judged.reduce((sum, r) => sum + r.posted, 0);
  if (posted === 0) return null;
  return judged.reduce((sum, r) => sum + r.matched + r.extras_accepted, 0) / posted;
}

/** Add the drop counts of "parts" by stage. A failed repeat has none. */
function sumDrops(parts: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const drops of parts) {
    for (const [stage, n] of Object.entries(drops)) total[stage] = (total[stage] ?? 0) + n;
  }
  return total;
}

/** The stages in pipeline order. The drops print in this order. */
const STAGE_ORDER = ["reviewer", "verify", "suppress", "merge", "cap", "scope", "post"];

/**
 * The drops as text, such as "verify 7, merge 1", or "-" for none. The
 * stages go in pipeline order. A stage outside that order goes last, by
 * name.
 */
function dropsText(drops: Record<string, number>): string {
  const rank = (stage: string): number => {
    const i = STAGE_ORDER.indexOf(stage);
    return i === -1 ? STAGE_ORDER.length : i;
  };
  const stages = Object.keys(drops).sort(
    (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  if (stages.length === 0) return "-";
  return stages.map((s) => `${s} ${drops[s]}`).join(", ");
}

/**
 * Build the report. A failed repeat has no metric values, so it is not in
 * any mean or drop sum. The judge counts are sums over every repeat.
 */
export function buildReport(
  cases: CaseMetrics[],
  gate: Gate | null,
  casesRef: string | null,
): Report {
  const all = cases.flatMap((c) => c.repeats.map((r) => ({ name: c.name, r })));
  const numbers = [...new Set(all.map(({ r }) => r.repeat))].sort((a, b) => a - b);
  const repeats = numbers.map((repeat) => {
    const ok = all.filter(({ r }) => r.repeat === repeat && !r.failed).map(({ r }) => r);
    return {
      repeat,
      raw_recall: mean(ok.map((r) => r.raw_recall)),
      recall: mean(ok.map((r) => r.recall)),
      precision: pooledPrecision(ok),
      findings_per_case: mean(ok.map((r) => r.posted)),
      cost_per_case: mean(ok.map((r) => r.cost_usd)),
      drops: sumDrops(ok.map((r) => r.drops)),
      adjudicated_precision: pooledAdjudicated(ok),
      judge_cost_per_case: mean(ok.map((r) => r.judge_cost_usd)),
    };
  });
  return {
    cases,
    repeats,
    aggregate: {
      raw_recall: spread(repeats.map((r) => r.raw_recall)),
      recall: spread(repeats.map((r) => r.recall)),
      precision: spread(repeats.map((r) => r.precision)),
      findings_per_case: spread(repeats.map((r) => r.findings_per_case)),
      cost_per_case: spread(repeats.map((r) => r.cost_per_case)),
      drops: sumDrops(repeats.map((r) => r.drops)),
      adjudicated_precision: spread(repeats.map((r) => r.adjudicated_precision)),
      judge_cost_per_case: spread(repeats.map((r) => r.judge_cost_per_case)),
    },
    judge: {
      calls: all.reduce((sum, { r }) => sum + r.judge_calls, 0),
      unknown: all.reduce((sum, { r }) => sum + r.judge_unknown, 0),
      extras_unknown: all.reduce((sum, { r }) => sum + r.extras_unknown, 0),
      cost_usd: all.reduce((sum, { r }) => sum + r.judge_cost_usd, 0),
    },
    failed_repeats: all
      .filter(({ r }) => r.failed)
      .map(({ name, r }) => ({ case: name, repeat: r.repeat, error: r.error ?? "" })),
    gate,
    cases_ref: casesRef,
  };
}

const ratio = (value: number | null): string => (value === null ? "-" : value.toFixed(3));
const usd = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(4)}`);

// Pad each column to its widest cell, and join the columns with two spaces.
function columns(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * Render the report as text: a heading that names the costs per PR, one
 * table for each case, with a row for each repeat, then the summary with
 * the mean, the minimum and the maximum. "baselineCasesRef" is the cases
 * ref of the baseline that the gate used. When it and the cases ref of the
 * report are both known and differ, the "Cases ref" line names both, so
 * the step summary shows the mismatch.
 */
export function renderTable(report: Report, baselineCasesRef: string | null = null): string {
  const lines: string[] = [
    "cost per PR: in each case table, cost is the cost of the review run and judge cost is the cost of the judge, for that PR.",
    "",
  ];
  const header = [
    "repeat",
    "raw recall",
    "recall",
    "precision",
    "adj precision",
    "posted",
    "drops",
    "cost",
    "judge cost",
  ];
  for (const c of report.cases) {
    lines.push(`Case: ${c.name}`);
    const rows = [header];
    for (const r of c.repeats) {
      rows.push(
        r.failed
          ? [String(r.repeat), `failed: ${r.error ?? ""}`]
          : [
              String(r.repeat),
              ratio(r.raw_recall),
              ratio(r.recall),
              ratio(r.precision),
              ratio(r.adjudicated_precision),
              String(r.posted),
              dropsText(r.drops),
              usd(r.cost_usd),
              usd(r.judge_cost_usd),
            ],
      );
    }
    lines.push(...columns(rows), "");
  }

  const { aggregate: a } = report;
  lines.push(`Summary over ${report.repeats.length} repeats`);
  lines.push(
    ...columns([
      ["metric", "mean", "min", "max"],
      ["raw recall", ratio(a.raw_recall.mean), ratio(a.raw_recall.min), ratio(a.raw_recall.max)],
      ["recall", ratio(a.recall.mean), ratio(a.recall.min), ratio(a.recall.max)],
      ["precision", ratio(a.precision.mean), ratio(a.precision.min), ratio(a.precision.max)],
      [
        "adj precision",
        ratio(a.adjudicated_precision.mean),
        ratio(a.adjudicated_precision.min),
        ratio(a.adjudicated_precision.max),
      ],
      [
        "findings per case",
        ratio(a.findings_per_case.mean),
        ratio(a.findings_per_case.min),
        ratio(a.findings_per_case.max),
      ],
      [
        "cost per PR",
        usd(a.cost_per_case.mean),
        usd(a.cost_per_case.min),
        usd(a.cost_per_case.max),
      ],
      [
        "judge cost per PR",
        usd(a.judge_cost_per_case.mean),
        usd(a.judge_cost_per_case.min),
        usd(a.judge_cost_per_case.max),
      ],
      // The drops are one sum over the eval, not a spread.
      ["drops", dropsText(a.drops)],
    ]),
  );
  lines.push(
    "",
    `Judge: ${report.judge.calls} calls, ${report.judge.unknown} unknown, ` +
      `${report.judge.extras_unknown} extras unknown, ${usd(report.judge.cost_usd)}`,
  );
  for (const f of report.failed_repeats) {
    lines.push(`Failed: ${f.case} repeat ${f.repeat}: ${f.error}`);
  }
  if (report.gate) {
    const g = report.gate;
    lines.push(
      `Gate: ${g.passed ? "passed" : "failed"} (recall drop ${ratio(g.recall_drop)}, precision drop ${ratio(g.precision_drop)})`,
    );
  }
  const mismatch =
    baselineCasesRef !== null && report.cases_ref !== null && baselineCasesRef !== report.cases_ref;
  lines.push(
    `Cases ref: ${report.cases_ref ?? "unknown"}` +
      (mismatch ? `; the baseline has ${baselineCasesRef}` : ""),
  );
  return `${lines.join("\n")}\n`;
}
