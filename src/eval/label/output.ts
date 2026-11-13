// The output files of the labeler, the golden rewrite, and the printers.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { POSTED_SEVERITIES } from "../../schemas/label.js";
import type { FindingEntry, FindingOutcome, QueueReason, RunResult } from "./loop.js";

/** A count over a count. The rate is null when the denominator is 0. */
type Ratio = { num: number; den: number };

const rate = (r: Ratio): number | null => (r.den === 0 ? null : r.num / r.den);

export type LabelsFile = {
  case: string;
  /** The digest of the labeling input, for --resume. */
  digest?: string;
  runs_per_finding: number;
  findings: FindingEntry[];
  first_pass_acceptance_rate: number | null;
  run_agreement_rate: number | null;
  /** The findings that the run agreement rate leaves out: a run did not converge. */
  run_agreement_excluded: number;
};

export type QueueEntry = FindingEntry & { reason: QueueReason };

export type SummaryCase = {
  case: string;
  findings: number;
  labeled: number;
  queued: number;
  failed_runs: number;
  scorer_cost_usd: number;
  /** With --resume: the indexes of the findings that kept entries served. */
  reused?: number[];
};

export type SummaryFile = {
  cases: SummaryCase[];
  first_pass_acceptance_rate: number | null;
  run_agreement_rate: number | null;
  run_agreement_excluded: number;
  scorer_cost_usd: number;
};

/** The labeled outcome of one case, with the counts behind its rates. */
export type CaseResult = {
  name: string;
  labels: LabelsFile;
  disagreements: FindingEntry[];
  queue: QueueEntry[];
  summary: SummaryCase;
  firstPass: Ratio;
  agreement: Ratio;
  /** The findings with a run that did not converge. */
  excluded: number;
};

// A run made a first judge call when one judge call of it gave a verdict.
function madeFirstJudgeCall(run: RunResult): boolean {
  return run.calls.some((c) => c.kind === "judge" && c.accept !== null);
}

function allConverged(entry: FindingEntry): boolean {
  return entry.runs.every((r) => r.converged);
}

function allAgree(entry: FindingEntry): boolean {
  return allConverged(entry) && new Set(entry.runs.map((r) => r.severity)).size === 1;
}

/** Build the files of one case from the outcomes of its findings. */
export function caseResult(
  name: string,
  runs: number,
  outcomes: FindingOutcome[],
  extra?: { digest: string; resume: boolean },
): CaseResult {
  const entries = outcomes.map((o) => o.entry);
  const allRuns = entries.flatMap((e) => e.runs);
  const firstPass: Ratio = {
    num: allRuns.filter((r) => madeFirstJudgeCall(r) && r.first_pass_accepted).length,
    den: allRuns.filter(madeFirstJudgeCall).length,
  };
  const agreement: Ratio = {
    num: entries.filter(allAgree).length,
    den: entries.filter(allConverged).length,
  };
  const queue = outcomes.flatMap((o): QueueEntry[] =>
    o.queueReason === null ? [] : [{ ...o.entry, reason: o.queueReason }],
  );
  const labeled = entries.filter(
    (e) => e.chosen !== null && POSTED_SEVERITIES.includes(e.chosen.severity),
  ).length;
  return {
    name,
    labels: {
      case: name,
      ...(extra ? { digest: extra.digest } : {}),
      runs_per_finding: runs,
      findings: entries,
      first_pass_acceptance_rate: rate(firstPass),
      run_agreement_rate: rate(agreement),
      run_agreement_excluded: entries.length - agreement.den,
    },
    disagreements: entries.filter((e) => !allAgree(e)),
    queue,
    summary: {
      case: name,
      findings: entries.length,
      labeled,
      queued: queue.length,
      failed_runs: allRuns.filter((r) => r.failed).length,
      scorer_cost_usd: outcomes.reduce((sum, o) => sum + o.scorerCostUsd, 0),
      ...(extra?.resume
        ? { reused: outcomes.filter((o) => o.reused).map((o) => o.entry.index) }
        : {}),
    },
    firstPass,
    agreement,
    excluded: entries.length - agreement.den,
  };
}

function sum(ratios: Ratio[]): Ratio {
  return ratios.reduce((a, r) => ({ num: a.num + r.num, den: a.den + r.den }), { num: 0, den: 0 });
}

/** The summary over every case. The rates pool the counts of the cases. */
export function summaryOf(results: CaseResult[]): SummaryFile {
  return {
    cases: results.map((r) => r.summary),
    first_pass_acceptance_rate: rate(sum(results.map((r) => r.firstPass))),
    run_agreement_rate: rate(sum(results.map((r) => r.agreement))),
    run_agreement_excluded: results.reduce((total, r) => total + r.excluded, 0),
    scorer_cost_usd: results.reduce((total, r) => total + r.summary.scorer_cost_usd, 0),
  };
}

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Write labels.json alone into "dir". A running case calls it after each finding. */
export async function writeLabels(dir: string, result: CaseResult): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, "labels.json"), json(result.labels));
}

/** Write labels.json, disagreements.json and human-queue.json into "dir". */
export async function writeCaseFiles(dir: string, result: CaseResult): Promise<void> {
  await writeLabels(dir, result);
  await writeFileAtomic(join(dir, "disagreements.json"), json({ findings: result.disagreements }));
  await writeFileAtomic(join(dir, "human-queue.json"), json({ findings: result.queue }));
}

/** The lines that name the findings that a resumed run reused, one for each case. */
export function reusedLines(results: CaseResult[]): string[] {
  return results.flatMap((r) => {
    const reused = r.summary.reused;
    if (reused === undefined) return [];
    return [
      `resume ${r.name}: reused findings ${reused.length === 0 ? "none" : reused.join(", ")}`,
    ];
  });
}

/**
 * Rewrite golden.json in "caseDir" with the chosen labels, all six of them.
 * The category and every other field and the order of the keys stay. A
 * finding with no chosen label keeps its entry. The file does not change
 * when no finding changes.
 */
export async function writeGolden(caseDir: string, entries: FindingEntry[]): Promise<void> {
  const path = join(caseDir, "golden.json");
  const golden = JSON.parse(await readFile(path, "utf8")) as {
    findings: Record<string, unknown>[];
  };
  let changed = false;
  for (const e of entries) {
    const target = golden.findings[e.index];
    if (!target || e.chosen === null) continue;
    if (target.severity !== e.chosen.severity) {
      target.severity = e.chosen.severity;
      changed = true;
    }
  }
  if (changed) await writeFileAtomic(path, json(golden));
}

const ratio = (value: number | null): string => (value === null ? "-" : value.toFixed(3));
const usd = (value: number): string => `$${value.toFixed(4)}`;

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

export const TABLE_HEADER = [
  "case",
  "findings",
  "labeled",
  "queued",
  "failed runs",
  "first-pass acceptance",
  "run agreement",
  "scorer cost",
];

/** The totals as a table: one row per case and a totals row. */
export function renderLabelTable(results: CaseResult[], summary: SummaryFile): string {
  const row = (
    name: string,
    s: Omit<SummaryCase, "case">,
    firstPass: number | null,
    agreement: number | null,
  ): string[] => [
    name,
    String(s.findings),
    String(s.labeled),
    String(s.queued),
    String(s.failed_runs),
    ratio(firstPass),
    ratio(agreement),
    usd(s.scorer_cost_usd),
  ];
  const total = (key: "findings" | "labeled" | "queued" | "failed_runs"): number =>
    summary.cases.reduce((n, c) => n + c[key], 0);
  const rows = [
    TABLE_HEADER,
    ...results.map((r) =>
      row(r.name, r.summary, r.labels.first_pass_acceptance_rate, r.labels.run_agreement_rate),
    ),
    row(
      "total",
      {
        findings: total("findings"),
        labeled: total("labeled"),
        queued: total("queued"),
        failed_runs: total("failed_runs"),
        scorer_cost_usd: summary.scorer_cost_usd,
      },
      summary.first_pass_acceptance_rate,
      summary.run_agreement_rate,
    ),
  ];
  return `${columns(rows).join("\n")}\n`;
}
