// The by-pass report (D8 phase 2). The two passes of one reviewer are two
// independent samples of one pass. For each scope, the report scores three
// sets of one run: the findings of pass 1, the findings of pass 2, and the
// findings of either pass. The mean of the two single sets is the one-pass
// arm. The set of both, less that mean, is what a second pass adds.
import type { FindingSource, RunRecord } from "../schemas/record.js";
import { TOLERANCE } from "./baseline.js";
import {
  BOOTSTRAP_LEVEL,
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  percentileInterval,
  resamples,
} from "./bootstrap.js";
import type { GoldenFinding } from "./case.js";
import { keepsAny, setRecord, VERIFIER_ROLES, type Keep } from "./paired.js";
import { columns, ratio, usd } from "./report.js";
import { scoreRecord, type ScoreJudge } from "./score.js";

/** The labels of a posted-label golden. */
const LABELS = ["blocking", "suggestion", "nit"] as const;
type Label = (typeof LABELS)[number];

/** The figures of one set: of one case, or summed over the cases. */
export type PassSet = {
  /** The posted-label goldens that the posted findings of the set match. */
  goldens: number;
  by_label: Record<Label, number>;
  posted: number;
  /** The posted findings of the set that match no posted-label golden. */
  false_posted: number;
  /** goldens over posted. Null with no posted finding. */
  precision: number | null;
  /**
   * The reviewer queries of the set's passes, and the verifier and
   * escalation queries of each verification with a source in the set.
   */
  cost_usd: number;
  /** The posted-label goldens that the reviewer findings of the set's passes match. */
  raw_goldens: number;
  /** The judge questions with no cached answer. Each counts as no match. */
  uncached: number;
};

/** The three sets of one scope, and what only one pass has. */
export type ByPassRow = {
  pass_1: PassSet;
  pass_2: PassSet;
  both: PassSet;
  /** The posted-label goldens that pass 2 matched and pass 1 did not. */
  only_pass_2_goldens: number;
  /** The posted-label goldens that pass 1 matched and pass 2 did not. */
  only_pass_1_goldens: number;
  /** The false posted findings whose sources in the scope are all pass 2. */
  only_pass_2_false: number;
  /** The false posted findings whose sources in the scope are all pass 1. */
  only_pass_1_false: number;
};

/** What the set of both adds to the mean of the two single sets. */
type Added = { added_goldens: number; added_false: number; added_cost_usd: number };

/** One row of a scope: one case, or the sum over the cases. */
export type ByPassCase = { case: string } & ByPassRow & Added;

/** A percentile interval. A null end is unbounded, or there is no value. */
export type Interval = { lower: number | null; upper: number | null };

/** The figures and the decision of one scope: one reviewer, or every reviewer (null). */
export type ByPassScope = {
  reviewer: string | null;
  cases: ByPassCase[];
  total: ByPassRow & Added;
  /** The one-pass arm: the mean of pass 1 and pass 2. */
  one_pass: {
    goldens: number;
    /** Pooled over the two single sets. */
    precision: number | null;
    cost_usd: number;
    cost_per_golden: number | null;
  };
  /** Pass 1 less pass 2: the noise of one pass. */
  noise: { goldens: number; false_posted: number; precision: number | null };
  /** The set of both less the one-pass arm. */
  added: {
    goldens: number;
    false_posted: number;
    cost_usd: number;
    cost_per_golden: number | null;
    goldens_per_case: { mean: number | null } & Interval;
  };
  decision: {
    /** True for the scope of every reviewer: its result is information only. */
    information_only: boolean;
    /**
     * (b): R = added cost per added golden over one-pass cost per golden.
     * Null for an unbounded R: no added golden, or no one-pass golden.
     */
    ratio: {
      value: number | null;
      unbounded_resamples: number;
      limit: number;
      passed: boolean;
    } & Interval;
    /** (c): the precision of both is at most 0.05 below the one-pass precision. */
    precision: {
      both: number | null;
      one_pass: number | null;
      limit: number | null;
      passed: boolean;
    };
    result: "passes 2" | "stays at 1";
  };
};

/** The by-pass section of an offline report. */
export type ByPassSection = {
  bootstrap: { seed: number; resamples: number; level: number };
  /** The repeats with no by-pass figures, with the reason. */
  missing: { case: string; repeat: number; reason: string }[];
  /** The judge queries of --ask-missing. Null without it. */
  ask_missing: { questions: number; cost_usd: number } | null;
  repeats: { repeat: number; scopes: ByPassScope[] }[];
};

/** The limit of R in test (b). */
export const RATIO_LIMIT = 2;
/** How far the precision of both can go below the one-pass precision in test (c). */
export const PRECISION_MARGIN = 0.05;

/** The text of the cost rule. */
export const COST_RULE =
  "Cost of a set: the reviewer queries of its passes, and the verifier and escalation queries " +
  "of each verification with a source in the set. Triage, merge and the other run-wide queries " +
  "are in no set.";

/** The reviewers of a record that ran two passes or more, in name order. */
export function multiPassReviewers(record: RunRecord): string[] {
  return [...new Set(record.stages.reviewers.filter((r) => r.pass >= 2).map((r) => r.name))].sort();
}

// The sources of a scope: one reviewer, or every reviewer in "multi".
function inScope(scope: string | null, multi: Set<string>): Keep {
  return scope === null ? (s) => multi.has(s.reviewer) : (s) => s.reviewer === scope;
}

function setCost(record: RunRecord, keep: Keep): number {
  const verifications = record.stages.verifications;
  return record.cost.queries.reduce((sum, q) => {
    const kept =
      q.role === "reviewer" && q.pass !== undefined
        ? keep({ reviewer: q.reviewer ?? "", pass: q.pass })
        : VERIFIER_ROLES.has(q.role) && q.verification !== undefined
          ? keepsAny(verifications[q.verification]?.sources, keep)
          : false;
    return kept ? sum + (q.cost_usd ?? 0) : sum;
  }, 0);
}

type Scored = {
  set: PassSet;
  goldens: Set<number>;
  /** The sources of each false posted finding of the set. */
  falseSources: FindingSource[][];
};

const emptyLabels = (): Record<Label, number> => ({ blocking: 0, suggestion: 0, nit: 0 });

/** The result of byPassRecord. */
export type ByPassRecord = { rows: ByPassRow[]; judgeCalls: number; judgeCostUsd: number };

/**
 * Score the three sets of each scope of one record. "scopes" holds the
 * scope names: a reviewer, or null for every reviewer in "multi". The
 * rows come in the order of "scopes". The record must have source fields.
 */
export async function byPassRecord(
  record: RunRecord,
  golden: GoldenFinding[],
  headDir: string,
  judge: ScoreJudge,
  scopes: (string | null)[],
  multi: string[],
  rawJudge: boolean,
): Promise<ByPassRecord> {
  const multiSet = new Set(multi);
  let judgeCalls = 0;
  let judgeCostUsd = 0;

  const score = async (keep: Keep): Promise<Scored> => {
    const view = setRecord(record, keep);
    const s = await scoreRecord(view, golden, headDir, judge, { extras: false, rawJudge });
    judgeCalls += s.judgeCalls;
    judgeCostUsd += s.judgeCostUsd;
    const byLabel = emptyLabels();
    for (const m of s.matched) {
      const severity = golden[m.golden]?.severity;
      if (severity !== undefined && (LABELS as readonly string[]).includes(severity)) {
        byLabel[severity as Label] += 1;
      }
    }
    const matchedPosted = new Set(s.matched.map((m) => m.posted));
    const posted = view.posted.findings;
    const falseSources = posted.flatMap((f, i) => (matchedPosted.has(i) ? [] : [f.sources ?? []]));
    return {
      set: {
        goldens: s.matched.length,
        by_label: byLabel,
        posted: posted.length,
        false_posted: posted.length - s.matched.length,
        precision: posted.length === 0 ? null : s.matched.length / posted.length,
        cost_usd: setCost(record, keep),
        raw_goldens: s.raw.matched.length,
        uncached: s.uncached,
      },
      goldens: new Set(s.matched.map((m) => m.golden)),
      falseSources,
    };
  };

  const rows: ByPassRow[] = [];
  for (const scope of scopes) {
    const ours = inScope(scope, multiSet);
    const one = await score((s) => ours(s) && s.pass === 1);
    const two = await score((s) => ours(s) && s.pass === 2);
    const both = await score(ours);
    // The false findings of a single set whose sources in the scope are
    // all of that pass.
    const onlyFalse = (scored: Scored, pass: number): number =>
      scored.falseSources.filter((sources) => sources.filter(ours).every((s) => s.pass === pass))
        .length;
    rows.push({
      pass_1: one.set,
      pass_2: two.set,
      both: both.set,
      only_pass_2_goldens: [...two.goldens].filter((g) => !one.goldens.has(g)).length,
      only_pass_1_goldens: [...one.goldens].filter((g) => !two.goldens.has(g)).length,
      only_pass_2_false: onlyFalse(two, 2),
      only_pass_1_false: onlyFalse(one, 1),
    });
  }
  return { rows, judgeCalls, judgeCostUsd };
}

function sumSets(sets: PassSet[]): PassSet {
  const sum = (pick: (s: PassSet) => number): number => sets.reduce((t, s) => t + pick(s), 0);
  const by_label = emptyLabels();
  for (const label of LABELS) by_label[label] = sum((s) => s.by_label[label]);
  const goldens = sum((s) => s.goldens);
  const posted = sum((s) => s.posted);
  return {
    goldens,
    by_label,
    posted,
    false_posted: sum((s) => s.false_posted),
    // Pooled over the cases.
    precision: posted === 0 ? null : goldens / posted,
    cost_usd: sum((s) => s.cost_usd),
    raw_goldens: sum((s) => s.raw_goldens),
    uncached: sum((s) => s.uncached),
  };
}

const meanOf = (a: number, b: number): number => (a + b) / 2;

function addedOf(row: ByPassRow): Added {
  return {
    added_goldens: row.both.goldens - meanOf(row.pass_1.goldens, row.pass_2.goldens),
    added_false: row.both.false_posted - meanOf(row.pass_1.false_posted, row.pass_2.false_posted),
    added_cost_usd: row.both.cost_usd - meanOf(row.pass_1.cost_usd, row.pass_2.cost_usd),
  };
}

// R of some rows, from their sums. Infinity when the summed added goldens
// are at most zero or the one-pass goldens or cost are zero: such a ratio
// is above any limit.
function ratioOf(rows: ByPassRow[]): number {
  let addedGoldens = 0;
  let addedCost = 0;
  let oneGoldens = 0;
  let oneCost = 0;
  for (const row of rows) {
    const a = addedOf(row);
    addedGoldens += a.added_goldens;
    addedCost += a.added_cost_usd;
    oneGoldens += meanOf(row.pass_1.goldens, row.pass_2.goldens);
    oneCost += meanOf(row.pass_1.cost_usd, row.pass_2.cost_usd);
  }
  if (addedGoldens <= TOLERANCE || oneGoldens <= TOLERANCE || oneCost <= 0) return Infinity;
  return addedCost / addedGoldens / (oneCost / oneGoldens);
}

const finite = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : value;

const diff = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a - b;

/**
 * The figures and the decision of one scope, from the rows of its cases.
 * The bootstrap draws the cases with replacement, with the fixed seed and
 * count of bootstrap.ts.
 */
export function summarizeScope(
  reviewer: string | null,
  rows: ({ case: string } & ByPassRow)[],
): ByPassScope {
  const cases: ByPassCase[] = rows.map((r) => ({ ...r, ...addedOf(r) }));
  const totalRow: ByPassRow = {
    pass_1: sumSets(rows.map((r) => r.pass_1)),
    pass_2: sumSets(rows.map((r) => r.pass_2)),
    both: sumSets(rows.map((r) => r.both)),
    only_pass_2_goldens: rows.reduce((t, r) => t + r.only_pass_2_goldens, 0),
    only_pass_1_goldens: rows.reduce((t, r) => t + r.only_pass_1_goldens, 0),
    only_pass_2_false: rows.reduce((t, r) => t + r.only_pass_2_false, 0),
    only_pass_1_false: rows.reduce((t, r) => t + r.only_pass_1_false, 0),
  };
  const total = { ...totalRow, ...addedOf(totalRow) };
  const { pass_1: p1, pass_2: p2, both } = totalRow;

  const onePosted = p1.posted + p2.posted;
  const oneGoldens = meanOf(p1.goldens, p2.goldens);
  const oneCost = meanOf(p1.cost_usd, p2.cost_usd);
  const one_pass = {
    goldens: oneGoldens,
    precision: onePosted === 0 ? null : (p1.goldens + p2.goldens) / onePosted,
    cost_usd: oneCost,
    cost_per_golden: oneGoldens === 0 ? null : oneCost / oneGoldens,
  };

  const draws = resamples(rows.length);
  const means = draws.map(
    (d) => d.reduce((t, i) => t + (cases[i]?.added_goldens ?? 0), 0) / d.length,
  );
  const ratios = draws.map((d) => ratioOf(d.map((i) => rows[i] as ByPassRow)));
  const goldensInterval = percentileInterval(means);
  const ratioInterval = percentileInterval(ratios);
  const upper = finite(ratioInterval.upper);

  const precisionLimit = one_pass.precision === null ? null : one_pass.precision - PRECISION_MARGIN;
  const precisionPassed =
    both.precision !== null &&
    precisionLimit !== null &&
    both.precision >= precisionLimit - TOLERANCE;
  const ratioPassed = upper !== null && upper <= RATIO_LIMIT + TOLERANCE;

  return {
    reviewer,
    cases,
    total,
    one_pass,
    noise: {
      goldens: p1.goldens - p2.goldens,
      false_posted: p1.false_posted - p2.false_posted,
      precision: diff(p1.precision, p2.precision),
    },
    added: {
      goldens: total.added_goldens,
      false_posted: total.added_false,
      cost_usd: total.added_cost_usd,
      cost_per_golden:
        total.added_goldens <= TOLERANCE ? null : total.added_cost_usd / total.added_goldens,
      goldens_per_case: {
        mean: cases.length === 0 ? null : total.added_goldens / cases.length,
        lower: finite(goldensInterval.lower),
        upper: finite(goldensInterval.upper),
      },
    },
    decision: {
      information_only: reviewer === null,
      ratio: {
        value: rows.length === 0 ? null : finite(ratioOf(rows)),
        lower: finite(ratioInterval.lower),
        upper,
        unbounded_resamples: ratios.filter((r) => !Number.isFinite(r)).length,
        limit: RATIO_LIMIT,
        passed: ratioPassed,
      },
      precision: {
        both: both.precision,
        one_pass: one_pass.precision,
        limit: precisionLimit,
        passed: precisionPassed,
      },
      result: ratioPassed && precisionPassed ? "passes 2" : "stays at 1",
    },
  };
}

/** The section with no repeat yet: the bootstrap settings and the missing repeats. */
export function emptySection(
  missing: ByPassSection["missing"],
  askMissing: ByPassSection["ask_missing"],
): ByPassSection {
  return {
    bootstrap: { seed: BOOTSTRAP_SEED, resamples: BOOTSTRAP_RESAMPLES, level: BOOTSTRAP_LEVEL },
    missing,
    ask_missing: askMissing,
    repeats: [],
  };
}

// A count that can be a half, such as a mean of two passes.
const count = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

const signed = (value: number | null, show: (v: number) => string): string =>
  value === null ? "-" : `${value >= 0 ? "+" : ""}${show(value)}`;

const end = (value: number | null, show: (v: number) => string): string =>
  value === null ? "unbounded" : show(value);

const passFail = (passed: boolean): string => (passed ? "pass" : "fail");

/** Render the by-pass section as text, for the end of the table report. */
export function renderByPass(section: ByPassSection): string[] {
  const b = section.bootstrap;
  const lines = [
    "",
    "By pass: pass 1, pass 2 and both",
    `Bootstrap: seed ${b.seed}, ${b.resamples} resamples of the cases, ${Math.round(b.level * 100)}% percentile intervals.`,
    COST_RULE,
  ];
  for (const m of section.missing) {
    lines.push(`No by-pass figures: ${m.case} repeat ${m.repeat}: ${m.reason}`);
  }
  if (section.ask_missing !== null) {
    const a = section.ask_missing;
    lines.push(
      `--ask-missing: ${a.questions} judge ${a.questions === 1 ? "question" : "questions"}, ${usd(a.cost_usd)}.`,
    );
  }
  for (const r of section.repeats) {
    for (const scope of r.scopes) {
      lines.push(
        "",
        `Repeat ${r.repeat}, scope: ${scope.reviewer === null ? "every reviewer with two passes" : `reviewer ${scope.reviewer}`}`,
      );
      const rows = [
        [
          "case",
          "set",
          "goldens",
          "blocking",
          "suggestion",
          "nit",
          "posted",
          "false",
          "precision",
          "cost",
          "raw goldens",
          "only goldens",
          "only false",
        ],
      ];
      for (const c of [...scope.cases, { case: "total", ...scope.total }]) {
        for (const [name, set] of [
          ["pass 1", c.pass_1],
          ["pass 2", c.pass_2],
          ["both", c.both],
        ] as const) {
          const only =
            name === "pass 1"
              ? [String(c.only_pass_1_goldens), String(c.only_pass_1_false)]
              : name === "pass 2"
                ? [String(c.only_pass_2_goldens), String(c.only_pass_2_false)]
                : ["-", "-"];
          rows.push([
            c.case,
            name,
            String(set.goldens),
            String(set.by_label.blocking),
            String(set.by_label.suggestion),
            String(set.by_label.nit),
            String(set.posted),
            String(set.false_posted),
            ratio(set.precision),
            usd(set.cost_usd),
            String(set.raw_goldens),
            ...only,
          ]);
        }
      }
      lines.push(...columns(rows));
      const t = scope.total;
      const o = scope.one_pass;
      const a = scope.added;
      const d = scope.decision;
      lines.push(
        `Unanswered judge questions: pass 1 ${t.pass_1.uncached}, pass 2 ${t.pass_2.uncached}, both ${t.both.uncached} (each counts as no match).`,
        `One pass: goldens ${count(o.goldens)}, precision ${ratio(o.precision)}, cost ${usd(o.cost_usd)}, cost per golden ${usd(o.cost_per_golden)}.`,
        `Noise of one pass (pass 1 less pass 2): goldens ${signed(scope.noise.goldens, count)}, false ${signed(scope.noise.false_posted, count)}, precision ${signed(scope.noise.precision, (v) => v.toFixed(3))}.`,
        `Added by both: goldens ${count(a.goldens)}, false ${count(a.false_posted)}, cost ${usd(a.cost_usd)}, cost per added golden ${usd(a.cost_per_golden)}.`,
        `Added goldens per case: ${ratio(a.goldens_per_case.mean)} (interval ${end(a.goldens_per_case.lower, (v) => v.toFixed(3))} to ${end(a.goldens_per_case.upper, (v) => v.toFixed(3))}), information only.`,
        `(b) R ${end(d.ratio.value, (v) => v.toFixed(3))} (interval ${end(d.ratio.lower, (v) => v.toFixed(3))} to ${end(d.ratio.upper, (v) => v.toFixed(3))}; ` +
          `${d.ratio.unbounded_resamples} resamples with no added golden or no one-pass golden), limit ${d.ratio.limit}: ${passFail(d.ratio.passed)}.`,
        `(c) precision of both ${ratio(d.precision.both)}, limit ${ratio(d.precision.limit)} (one pass ${ratio(d.precision.one_pass)} less ${PRECISION_MARGIN}): ${passFail(d.precision.passed)}.`,
        `Result${d.information_only ? " (information only)" : ""}: ${d.result}.`,
      );
    }
  }
  return lines;
}
