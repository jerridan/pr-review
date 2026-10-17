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
    recall: number | null;
    precision: number | null;
    findings_per_case: number | null;
    cost_per_case: number | null;
  }[];
  aggregate: {
    recall: Spread;
    precision: Spread;
    findings_per_case: Spread;
    cost_per_case: Spread;
  };
  judge: { calls: number; unknown: number; cost_usd: number };
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
 * Build the report. A failed repeat has no metric values, so it is not in
 * any mean. The judge counts are sums over every repeat.
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
      recall: mean(ok.map((r) => r.recall)),
      precision: pooledPrecision(ok),
      findings_per_case: mean(ok.map((r) => r.posted)),
      cost_per_case: mean(ok.map((r) => r.cost_usd)),
    };
  });
  return {
    cases,
    repeats,
    aggregate: {
      recall: spread(repeats.map((r) => r.recall)),
      precision: spread(repeats.map((r) => r.precision)),
      findings_per_case: spread(repeats.map((r) => r.findings_per_case)),
      cost_per_case: spread(repeats.map((r) => r.cost_per_case)),
    },
    judge: {
      calls: all.reduce((sum, { r }) => sum + r.judge_calls, 0),
      unknown: all.reduce((sum, { r }) => sum + r.judge_unknown, 0),
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
 * Render the report as text: one table for each case, with a row for each
 * repeat, then the summary with the mean, the minimum and the maximum.
 */
export function renderTable(report: Report): string {
  const lines: string[] = [];
  for (const c of report.cases) {
    lines.push(`Case: ${c.name}`);
    const rows = [["repeat", "recall", "precision", "posted", "cost"]];
    for (const r of c.repeats) {
      rows.push(
        r.failed
          ? [String(r.repeat), `failed: ${r.error ?? ""}`]
          : [
              String(r.repeat),
              ratio(r.recall),
              ratio(r.precision),
              String(r.posted),
              usd(r.cost_usd),
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
      ["recall", ratio(a.recall.mean), ratio(a.recall.min), ratio(a.recall.max)],
      ["precision", ratio(a.precision.mean), ratio(a.precision.min), ratio(a.precision.max)],
      [
        "findings per case",
        ratio(a.findings_per_case.mean),
        ratio(a.findings_per_case.min),
        ratio(a.findings_per_case.max),
      ],
      [
        "cost per case",
        usd(a.cost_per_case.mean),
        usd(a.cost_per_case.min),
        usd(a.cost_per_case.max),
      ],
    ]),
  );
  lines.push(
    "",
    `Judge: ${report.judge.calls} calls, ${report.judge.unknown} unknown, ${usd(report.judge.cost_usd)}`,
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
  lines.push(`Cases ref: ${report.cases_ref ?? "unknown"}`);
  return `${lines.join("\n")}\n`;
}
