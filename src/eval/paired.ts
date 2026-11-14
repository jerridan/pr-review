// The paired report (D8): one run of the two-pass arm gives two sets of
// findings. The one-pass set holds what pass 1 raised. The all set holds
// every finding. The two sets share every other source of noise, so their
// difference shows what the passes after pass 1 add. The one-pass set
// filters the posted findings of the run: it does not model the merge or
// the cap that a one-pass run would form.
import type { FindingSource, RunRecord } from "../schemas/record.js";
import type { GoldenFinding } from "./case.js";
import type { RepeatMetrics } from "./metrics.js";
import { columns, mean, ratio, spread, usd, type Spread } from "./report.js";
import { scoreRecord, type ScoreJudge, type ScoreResult } from "./score.js";

/** The figures of one set of one repeat of one case. */
export type SetFigures = {
  /** The reviewer findings of the set that match a posted golden, over the posted goldens. */
  raw_recall: number | null;
  /** The posted findings of the set that match a posted golden, over the posted goldens. */
  recall: number | null;
  /** Strict: the matched posted findings of the set, over its posted findings. */
  precision: number | null;
  /** The cost of the run, less the queries that only the left-out passes needed. */
  cost_usd: number | null;
  posted: number;
  matched: number;
};

/** The one-pass set of one scope, and what the all set adds to it. */
export type ScopeFigures = {
  one_pass: SetFigures;
  /** The posted goldens that the all set matches and the one-pass set does not. */
  added_goldens: number;
  /**
   * The false posted findings of the all set that are not in the one-pass
   * set. A false finding matches no golden, or a golden that does not post.
   */
  added_false: number;
  /** The added cost over the added goldens. Null with no added golden or no cost. */
  added_cost_per_golden: number | null;
};

/**
 * The paired figures of one repeat of one case. "one_pass" leaves out the
 * passes after pass 1 of every reviewer. Each entry of "reviewers" leaves
 * out the passes after pass 1 of that reviewer only. A reviewer is there
 * when it ran more than one pass.
 */
export type RepeatPaired = {
  all: SetFigures;
  one_pass: ScopeFigures;
  reviewers: Record<string, ScopeFigures>;
};

/** A set of a repeat over all cases. */
export type PairedSetSummary = {
  raw_recall: number | null;
  recall: number | null;
  precision: number | null;
  cost_per_case: number | null;
};

/** The paired figures of one scope: every reviewer (null), or one reviewer. */
export type PairedScope = {
  reviewer: string | null;
  cases: {
    case: string;
    repeats: ({ repeat: number; all: SetFigures } & ScopeFigures)[];
  }[];
  repeats: {
    repeat: number;
    one_pass: PairedSetSummary;
    all: PairedSetSummary;
    added_goldens: number;
    added_false: number;
    added_cost_per_golden: number | null;
    /** The posted recall of the all set less that of the one-pass set. */
    recall_diff: number | null;
    /** The precision of the all set less that of the one-pass set. */
    precision_diff: number | null;
  }[];
  aggregate: { recall_diff: Spread; precision_diff: Spread };
};

/** The paired section of a report. */
export type PairedSection = {
  /** The repeats that did not fail and that have no paired figures, with the reason. */
  missing: { case: string; repeat: number; reason: string }[];
  /**
   * The repeats of an offline report with judge questions that had no
   * cached answer. The figures of such a repeat are not valid.
   */
  uncached: { case: string; repeat: number; pairs: number }[];
  scopes: PairedScope[];
};

/** The reason of a repeat whose record has no source fields. */
export const NO_SOURCES = "no source fields";
/** The reason of a repeat that the eval scored without --paired. */
export const NOT_PAIRED = "not scored with --paired";

/** The roles of the queries that serve one verification. */
export const VERIFIER_ROLES = new Set(["verifier", "verifier-escalation"]);

/**
 * True when the record names the sources of each verification and posted
 * finding, the pass of each reviewer query and the verification of each
 * verifier query. A record from before D8 does not.
 */
export function hasSources(record: RunRecord): boolean {
  return (
    record.stages.verifications.every((v) => v.sources !== undefined) &&
    record.posted.findings.every((f) => f.sources !== undefined) &&
    record.cost.queries.every((q) =>
      q.role === "reviewer"
        ? q.pass !== undefined
        : VERIFIER_ROLES.has(q.role)
          ? q.verification !== undefined
          : true,
    )
  );
}

/** True for each source that a set keeps. */
export type Keep = (source: FindingSource) => boolean;

/** True when "keep" keeps one of the sources. */
export const keepsAny = (sources: FindingSource[] | undefined, keep: Keep): boolean =>
  (sources ?? []).some(keep);

/**
 * The record with only the reviewer entries and the posted findings of
 * the set. Every other part stays.
 */
export function setRecord(record: RunRecord, keep: Keep): RunRecord {
  return {
    ...record,
    stages: {
      ...record.stages,
      reviewers: record.stages.reviewers.filter((r) => keep({ reviewer: r.name, pass: r.pass })),
    },
    posted: {
      ...record.posted,
      findings: record.posted.findings.filter((f) => keepsAny(f.sources, keep)),
    },
  };
}

// The run cost less the reviewer queries of the passes that the set
// leaves out, and less the verifier queries of each verification that
// none of its sources keeps.
function setCost(record: RunRecord, keep: Keep): number | null {
  const total = record.cost.total_cost_usd;
  if (total === null) return null;
  const verifications = record.stages.verifications;
  const left = record.cost.queries.filter((q) => {
    if (q.role === "reviewer" && q.pass !== undefined) {
      return !keep({ reviewer: q.reviewer ?? "", pass: q.pass });
    }
    if (VERIFIER_ROLES.has(q.role) && q.verification !== undefined) {
      return !keepsAny(verifications[q.verification]?.sources, keep);
    }
    return false;
  });
  return left.reduce((sum, q) => sum - (q.cost_usd ?? 0), total);
}

function figures(record: RunRecord, score: ScoreResult, cost: number | null): SetFigures {
  const goldens = score.postedGoldenCount;
  const posted = record.posted.findings.length;
  const matched = score.matched.length;
  return {
    raw_recall: goldens === 0 ? null : score.raw.matched.length / goldens,
    recall: goldens === 0 ? null : matched / goldens,
    precision: posted === 0 ? null : matched / posted,
    cost_usd: cost,
    posted,
    matched,
  };
}

const oneIn = (scope: string | null): Keep =>
  scope === null ? (s) => s.pass === 1 : (s) => s.reviewer !== scope || s.pass === 1;

/** The result of pairedRepeat: the figures, and what the judge did for them. */
export type PairedResult = {
  paired: RepeatPaired;
  judgeCalls: number;
  judgeCostUsd: number;
  uncached: number;
};

/**
 * The paired figures of one record. "all" is the score of the whole
 * record. Each one-pass set gets its own score with the same judge and
 * cache, so a pair that the all set already asked about costs no query.
 * The record must have source fields (see hasSources).
 */
export async function pairedRepeat(
  record: RunRecord,
  golden: GoldenFinding[],
  headDir: string,
  judge: ScoreJudge,
  opts: { rawJudge?: boolean },
  all: ScoreResult,
): Promise<PairedResult> {
  const allFigures = figures(record, all, record.cost.total_cost_usd);
  const allMatched = new Set(all.matched.map((m) => m.golden));
  const truePosted = new Set(all.matched.map((m) => m.posted));
  let judgeCalls = 0;
  let judgeCostUsd = 0;
  let uncached = 0;

  const scope = async (name: string | null): Promise<ScopeFigures> => {
    const keep = oneIn(name);
    const view = setRecord(record, keep);
    const score = await scoreRecord(view, golden, headDir, judge, {
      extras: false,
      rawJudge: opts.rawJudge === true,
    });
    judgeCalls += score.judgeCalls;
    judgeCostUsd += score.judgeCostUsd;
    uncached += score.uncached;
    const one = figures(view, score, setCost(record, keep));
    const oneMatched = new Set(score.matched.map((m) => m.golden));
    const added = [...allMatched].filter((g) => !oneMatched.has(g)).length;
    const addedFalse = record.posted.findings.filter(
      (f, p) => !truePosted.has(p) && !keepsAny(f.sources, keep),
    ).length;
    const addedCost =
      allFigures.cost_usd === null || one.cost_usd === null
        ? null
        : allFigures.cost_usd - one.cost_usd;
    return {
      one_pass: one,
      added_goldens: added,
      added_false: addedFalse,
      added_cost_per_golden: added === 0 || addedCost === null ? null : addedCost / added,
    };
  };

  const multi = [
    ...new Set(record.stages.reviewers.filter((r) => r.pass >= 2).map((r) => r.name)),
  ].sort();
  const onePass = await scope(null);
  const reviewers: Record<string, ScopeFigures> = {};
  for (const name of multi) reviewers[name] = await scope(name);
  return {
    paired: { all: allFigures, one_pass: onePass, reviewers },
    judgeCalls,
    judgeCostUsd,
    uncached,
  };
}

function summary(sets: SetFigures[]): PairedSetSummary {
  const posted = sets.reduce((sum, s) => sum + s.posted, 0);
  return {
    raw_recall: mean(sets.map((s) => s.raw_recall)),
    recall: mean(sets.map((s) => s.recall)),
    // Pooled over the cases, as the precision of the main report.
    precision: posted === 0 ? null : sets.reduce((sum, s) => sum + s.matched, 0) / posted,
    cost_per_case: mean(sets.map((s) => s.cost_usd)),
  };
}

const diff = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a - b;

// The figures of "scope" for one repeat. A reviewer that ran one pass in
// this repeat adds nothing, so its one-pass set is the all set.
function scopeOf(paired: RepeatPaired, scope: string | null): ScopeFigures {
  if (scope === null) return paired.one_pass;
  return (
    paired.reviewers[scope] ?? {
      one_pass: paired.all,
      added_goldens: 0,
      added_false: 0,
      added_cost_per_golden: null,
    }
  );
}

/**
 * Build the paired section from the metrics of each case. A failed repeat
 * is not in it. A repeat with no paired figures is in "missing" only.
 */
export function buildPaired(
  cases: { name: string; repeats: RepeatMetrics[] }[],
  uncached: PairedSection["uncached"] = [],
): PairedSection {
  const missing: PairedSection["missing"] = [];
  const scored: { name: string; repeat: number; paired: RepeatPaired }[] = [];
  for (const c of cases) {
    for (const r of c.repeats) {
      if (r.failed) continue;
      if (r.paired === undefined)
        missing.push({ case: c.name, repeat: r.repeat, reason: NOT_PAIRED });
      else if (r.paired === null)
        missing.push({ case: c.name, repeat: r.repeat, reason: NO_SOURCES });
      else scored.push({ name: c.name, repeat: r.repeat, paired: r.paired });
    }
  }
  const names = [...new Set(scored.flatMap((s) => Object.keys(s.paired.reviewers)))].sort();
  const numbers = [...new Set(scored.map((s) => s.repeat))].sort((a, b) => a - b);

  const scopes = [null, ...names].map((scope): PairedScope => {
    const caseRows = cases
      .map((c) => ({
        case: c.name,
        repeats: scored
          .filter((s) => s.name === c.name)
          .map((s) => ({ repeat: s.repeat, all: s.paired.all, ...scopeOf(s.paired, scope) })),
      }))
      .filter((c) => c.repeats.length > 0);
    const repeats = numbers.map((repeat) => {
      const rows = scored
        .filter((s) => s.repeat === repeat)
        .map((s) => ({ all: s.paired.all, ...scopeOf(s.paired, scope) }));
      const all = summary(rows.map((r) => r.all));
      const one = summary(rows.map((r) => r.one_pass));
      const addedGoldens = rows.reduce((sum, r) => sum + r.added_goldens, 0);
      const costed = rows.filter((r) => r.all.cost_usd !== null && r.one_pass.cost_usd !== null);
      const addedCost = costed.reduce(
        (sum, r) => sum + (r.all.cost_usd ?? 0) - (r.one_pass.cost_usd ?? 0),
        0,
      );
      return {
        repeat,
        one_pass: one,
        all,
        added_goldens: addedGoldens,
        added_false: rows.reduce((sum, r) => sum + r.added_false, 0),
        added_cost_per_golden:
          addedGoldens === 0 || costed.length === 0 ? null : addedCost / addedGoldens,
        recall_diff: diff(all.recall, one.recall),
        precision_diff: diff(all.precision, one.precision),
      };
    });
    return {
      reviewer: scope,
      cases: caseRows,
      repeats,
      aggregate: {
        recall_diff: spread(repeats.map((r) => r.recall_diff)),
        precision_diff: spread(repeats.map((r) => r.precision_diff)),
      },
    };
  });
  return { missing, uncached, scopes };
}

const signed = (value: number | null): string =>
  value === null ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

/** The not-valid lines of an offline report, one per repeat with uncached questions. */
export function notValidLines(section: PairedSection): string[] {
  return section.uncached.map(
    (u) =>
      `Not valid: ${u.case} repeat ${u.repeat}: ${u.pairs} judge ${u.pairs === 1 ? "pair" : "pairs"} ` +
      "had no cached answer, and each counts as no match.",
  );
}

/** Render the paired section as text, for the end of the table report. */
export function renderPaired(section: PairedSection): string[] {
  const lines = ["", "Paired: pass 1 against all passes"];
  for (const m of section.missing) {
    const reason = m.reason.charAt(0).toUpperCase() + m.reason.slice(1);
    lines.push(`${reason}: ${m.case} repeat ${m.repeat}`);
  }
  for (const scope of section.scopes) {
    lines.push(
      "",
      `Scope: ${scope.reviewer === null ? "every reviewer" : `reviewer ${scope.reviewer}`}`,
    );
    const rows = [
      [
        "repeat",
        "set",
        "raw recall",
        "recall",
        "precision",
        "cost per PR",
        "added goldens",
        "added false",
        "cost per added golden",
      ],
    ];
    for (const r of scope.repeats) {
      for (const [name, set] of [
        ["pass 1", r.one_pass],
        ["all", r.all],
      ] as const) {
        rows.push([
          String(r.repeat),
          name,
          ratio(set.raw_recall),
          ratio(set.recall),
          ratio(set.precision),
          usd(set.cost_per_case),
          ...(name === "all"
            ? [String(r.added_goldens), String(r.added_false), usd(r.added_cost_per_golden)]
            : []),
        ]);
      }
    }
    lines.push(...columns(rows));
    const a = scope.aggregate;
    lines.push(
      ...columns([
        ["difference (all less pass 1)", "mean", "min", "max"],
        [
          "recall",
          signed(a.recall_diff.mean),
          signed(a.recall_diff.min),
          signed(a.recall_diff.max),
        ],
        [
          "precision",
          signed(a.precision_diff.mean),
          signed(a.precision_diff.min),
          signed(a.precision_diff.max),
        ],
      ]),
    );
  }
  return lines;
}
