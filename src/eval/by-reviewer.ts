// The figures of each reviewer (D4c E1). For each reviewer of a record, and
// for all reviewers together, the scoring matches the raw candidates to
// the posted-label goldens with the raw match of scoreRecord, with the raw
// judge always on. The view of a scope holds the reviewer entries of the
// scope and no posted finding, so a stage 1 record and a full record with
// the same reviewer findings give the same figures. The eval with --stage1
// and eval-report --by-reviewer both use these functions.
import type { RunRecord } from "../schemas/record.js";
import type { GoldenFinding } from "./case.js";
import { columns, usd } from "./report.js";
import { scoreRecord, type ScoreJudge } from "./score.js";

/** The labels of a posted-label golden. */
const LABELS = ["blocking", "suggestion", "nit"] as const;
type Label = (typeof LABELS)[number];

/** The figures of one scope: of one case, or summed over the cases. */
export type ReviewerFigures = {
  /** The raw candidates: the reviewer findings, with the same file, span and claim counted once. */
  candidates: number;
  /** The posted-label goldens that the raw candidates match. */
  goldens: number;
  by_label: Record<Label, number>;
  /** The known cost of the reviewer queries of the scope. */
  cost_usd: number;
  /** cost_usd over goldens. Null with no golden. */
  cost_per_golden: number | null;
  /** The judge questions with no cached answer. Each counts as no match. */
  uncached: number;
  /** The judge answers "unknown": a failed query. Each counts as no match. */
  unknown: number;
};

/** The figures of one scope of one record. "reviewer" is null for all reviewers. */
export type ReviewerRow = { reviewer: string | null } & ReviewerFigures;

/** The figures of one scope over the cases of one repeat. */
export type ByReviewerScope = {
  reviewer: string | null;
  cases: ({ case: string } & ReviewerFigures)[];
  total: ReviewerFigures;
};

/** The by-reviewer section of a report. */
export type ByReviewerSection = {
  /** The judge queries of --ask-missing. Null without it. */
  ask_missing: { questions: number; cost_usd: number } | null;
  repeats: { repeat: number; scopes: ByReviewerScope[] }[];
};

/** The text of the match and cost rule. */
export const BY_REVIEWER_RULE =
  "Raw candidates of each reviewer against the posted-label goldens, with the judge on the ambiguous pairs. " +
  "Cost: the reviewer queries of the scope.";

const emptyLabels = (): Record<Label, number> => ({ blocking: 0, suggestion: 0, nit: 0 });

const perGolden = (cost: number, goldens: number): number | null =>
  goldens === 0 ? null : cost / goldens;

/** The reviewers of a record, by name: every reviewer entry. */
export function recordReviewers(record: RunRecord): string[] {
  return [...new Set(record.stages.reviewers.map((r) => r.name))].sort();
}

// The record with the reviewer entries of the scope only, and no posted
// finding: the scoring then matches the raw candidates only.
function viewOf(record: RunRecord, scope: string | null): RunRecord {
  return {
    ...record,
    stages: {
      ...record.stages,
      reviewers: record.stages.reviewers.filter((r) => scope === null || r.name === scope),
    },
    posted: { ...record.posted, findings: [] },
  };
}

/** The result of byReviewerRecord. */
export type ByReviewerRecord = { rows: ReviewerRow[]; judgeCalls: number; judgeCostUsd: number };

/**
 * Score the raw candidates of each scope of one record: all reviewers
 * (null), then each reviewer in "reviewers" in order. "reviewers" defaults
 * to the reviewers of the record. Give one "asked" set in "judge", so that
 * one failed question gets one new query, not one per scope.
 */
export async function byReviewerRecord(
  record: RunRecord,
  golden: GoldenFinding[],
  headDir: string,
  judge: ScoreJudge,
  reviewers: string[] = recordReviewers(record),
): Promise<ByReviewerRecord> {
  let judgeCalls = 0;
  let judgeCostUsd = 0;
  const rows: ReviewerRow[] = [];
  for (const scope of [null, ...reviewers]) {
    const s = await scoreRecord(viewOf(record, scope), golden, headDir, judge, {
      extras: false,
      rawJudge: true,
    });
    judgeCalls += s.judgeCalls;
    judgeCostUsd += s.judgeCostUsd;
    const byLabel = emptyLabels();
    for (const m of s.raw.matched) {
      const severity = golden[m.golden]?.severity;
      if (severity !== undefined && (LABELS as readonly string[]).includes(severity)) {
        byLabel[severity as Label] += 1;
      }
    }
    const cost = record.cost.queries.reduce(
      (sum, q) =>
        q.role === "reviewer" && (scope === null || q.reviewer === scope)
          ? sum + (q.cost_usd ?? 0)
          : sum,
      0,
    );
    rows.push({
      reviewer: scope,
      candidates: s.raw.candidates,
      goldens: s.raw.matched.length,
      by_label: byLabel,
      cost_usd: cost,
      cost_per_golden: perGolden(cost, s.raw.matched.length),
      uncached: s.uncached,
      unknown: s.judgeUnknown,
    });
  }
  return { rows, judgeCalls, judgeCostUsd };
}

const NO_FIGURES = (): ReviewerFigures => ({
  candidates: 0,
  goldens: 0,
  by_label: emptyLabels(),
  cost_usd: 0,
  cost_per_golden: null,
  uncached: 0,
  unknown: 0,
});

const figuresOf = (row: ReviewerRow): ReviewerFigures => {
  const { reviewer: _reviewer, ...figures } = row;
  return figures;
};

function sumFigures(rows: ReviewerFigures[]): ReviewerFigures {
  const sum = (pick: (f: ReviewerFigures) => number): number =>
    rows.reduce((t, f) => t + pick(f), 0);
  const by_label = emptyLabels();
  for (const label of LABELS) by_label[label] = sum((f) => f.by_label[label]);
  const goldens = sum((f) => f.goldens);
  const cost = sum((f) => f.cost_usd);
  return {
    candidates: sum((f) => f.candidates),
    goldens,
    by_label,
    cost_usd: cost,
    cost_per_golden: perGolden(cost, goldens),
    uncached: sum((f) => f.uncached),
    unknown: sum((f) => f.unknown),
  };
}

/** The rows of one record of one case, for buildByReviewer. */
export type ByReviewerInput = { case: string; repeat: number; rows: ReviewerRow[] };

/**
 * The by-reviewer section: for each repeat, a scope for all reviewers and
 * one for each reviewer that ran in a case of the repeat, in name order.
 * Each scope has a row for each case of the repeat; a case where the
 * reviewer did not run has zero figures. The total sums the cases.
 */
export function buildByReviewer(
  inputs: ByReviewerInput[],
  askMissing: ByReviewerSection["ask_missing"] = null,
): ByReviewerSection {
  const numbers = [...new Set(inputs.map((i) => i.repeat))].sort((a, b) => a - b);
  const repeats = numbers.map((repeat) => {
    const ours = inputs.filter((i) => i.repeat === repeat);
    const names = [
      ...new Set(
        ours.flatMap((i) => i.rows.flatMap((r) => (r.reviewer === null ? [] : [r.reviewer]))),
      ),
    ].sort();
    const scopes = [null, ...names].map((reviewer): ByReviewerScope => {
      const cases = ours.map((i) => {
        const row = i.rows.find((r) => r.reviewer === reviewer);
        return { case: i.case, ...(row ? figuresOf(row) : NO_FIGURES()) };
      });
      return { reviewer, cases, total: sumFigures(cases) };
    });
    return { repeat, scopes };
  });
  return { ask_missing: askMissing, repeats };
}

/** Render the by-reviewer section as text, for the end of the table report. */
export function renderByReviewer(section: ByReviewerSection): string[] {
  const lines = ["", "By reviewer: the raw candidates of each reviewer", BY_REVIEWER_RULE];
  if (section.ask_missing !== null) {
    const a = section.ask_missing;
    lines.push(
      `--ask-missing: ${a.questions} judge ${a.questions === 1 ? "question" : "questions"}, ${usd(a.cost_usd)}.`,
    );
  }
  for (const r of section.repeats) {
    lines.push("", `Repeat ${r.repeat}`);
    const rows = [
      [
        "case",
        "reviewer",
        "candidates",
        "goldens",
        "blocking",
        "suggestion",
        "nit",
        "cost",
        "cost per golden",
        "unanswered",
        "unknown",
      ],
    ];
    for (const scope of r.scopes) {
      const name = scope.reviewer ?? "all";
      for (const c of [...scope.cases, { case: "total", ...scope.total }]) {
        rows.push([
          c.case,
          name,
          String(c.candidates),
          String(c.goldens),
          String(c.by_label.blocking),
          String(c.by_label.suggestion),
          String(c.by_label.nit),
          usd(c.cost_usd),
          usd(c.cost_per_golden),
          String(c.uncached),
          String(c.unknown),
        ]);
      }
    }
    lines.push(...columns(rows));
  }
  return lines;
}
