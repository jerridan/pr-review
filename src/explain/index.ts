// Explain a run record: one row for each finding that the record holds,
// with the last stage it reached, the outcome, and the check that decided it.
import type { Category, Finding } from "../schemas/finding.js";
import type { PostedFinding, QueryFailure, RunRecord } from "../schemas/record.js";
import type { VerifierResult } from "../schemas/verifier.js";
import {
  findingKey,
  firstFree,
  reviewerRefs,
  sameLocation,
  tieVerifications,
  type ReviewerRef,
} from "./tie.js";

export type ExplainRow = {
  reviewer: string | null;
  pass: number | null;
  file: string | null;
  span: [number, number] | null;
  category: Category | null;
  claim: string | null;
  fingerprint: string | null;
  stage: string;
  outcome: "kept" | "dropped";
  reason: string;
  finding: Finding | PostedFinding | null;
};

type Verification = RunRecord["stages"]["verifications"][number];

/** The state of one verification while the later stages of the record tie to it. */
type Unit = {
  refs: ReviewerRef[];
  finding: Finding | PostedFinding;
  stage: string;
  outcome: "kept" | "dropped";
  reason: string;
  /** The text that a failed or rejected merge appends to the final reason. */
  suffix: string;
};

function isFailure<T extends object>(value: T | QueryFailure): value is QueryFailure {
  return "kind" in value;
}

function rowOf(
  parts: Omit<ExplainRow, "file" | "span" | "category" | "claim" | "fingerprint">,
): ExplainRow {
  const f = parts.finding;
  return {
    ...parts,
    file: f?.file ?? null,
    span: f ? [f.start_line, f.end_line] : null,
    category: f?.category ?? null,
    claim: f?.claim ?? null,
    fingerprint: f && "fingerprint" in f ? f.fingerprint : null,
  };
}

function reviewerOf(refs: ReviewerRef[]): { reviewer: string | null; pass: number | null } {
  if (refs.length === 0) return { reviewer: null, pass: null };
  return {
    reviewer: [...new Set(refs.map((r) => r.name))].join(", "),
    pass: refs[0]?.pass ?? null,
  };
}

/**
 * The threshold of a reviewer as the record shows it. The record holds
 * reviewers.<name>.threshold of the config, but not the threshold in the
 * frontmatter of the reviewer. Without the config value, the true
 * threshold is at least thresholds.default.
 */
function thresholdOf(record: RunRecord, name: string | undefined): { t: number; exact: boolean } {
  const values = record.identity.config.values;
  const set = name === undefined ? undefined : values.reviewers[name]?.threshold;
  return set === undefined
    ? { t: values.thresholds.default, exact: false }
    : { t: set, exact: true };
}

/**
 * The reason that a verification did not pass. The checks go in the order
 * of the code: a failed call, then scope, then the claim, then the score,
 * then the quote. An escalated result decides when the record holds one.
 */
function verifyReason(v: Verification, threshold: { t: number; exact: boolean }): string {
  const one = (r: VerifierResult | QueryFailure): string => {
    if (isFailure(r)) return `verifier call failed: ${r.kind}`;
    if (!r.in_scope) return `verifier: out of scope, scored ${r.score}`;
    if (!r.claim_holds) return `verifier: the claim does not hold, scored ${r.score}`;
    if (r.score < threshold.t) {
      return threshold.exact
        ? `verifier scored ${r.score}, below the threshold ${threshold.t}`
        : `verifier scored ${r.score}, below a threshold of at least ${threshold.t}`;
    }
    if (v.rejected !== undefined) return `verifier rejected: ${v.rejected}`;
    return `verifier scored ${r.score}, below the threshold of the reviewer`;
  };
  return v.escalated === undefined ? one(v.first) : `escalated, ${one(v.escalated)}`;
}

// True when the first result of a verification passes every check of a
// pre-existing finding that the record can show: out of scope, a claim
// that holds, and a score at or above the threshold.
function looksPreExisting(v: Verification, threshold: { t: number }): boolean {
  if (v.passed || v.escalated !== undefined || isFailure(v.first)) return false;
  return !v.first.in_scope && v.first.claim_holds && v.first.score >= threshold.t;
}

/** Give one row for each finding that the record holds. */
export function explain(record: RunRecord): ExplainRow[] {
  const { stages, posted } = record;
  const values = record.identity.config.values;
  const refs = reviewerRefs(record);
  const ties = tieVerifications(stages.verifications, refs);
  const thresholds = ties.map((t) => thresholdOf(record, t[0]?.name));

  // The verify stage.
  const units: Unit[] = stages.verifications.map((v, i) => ({
    refs: ties[i] ?? [],
    finding: v.finding,
    stage: "verify",
    outcome: "dropped",
    reason: v.passed
      ? "no later stage in the record"
      : verifyReason(v, thresholds[i] ?? { t: 0, exact: false }),
    suffix: "",
  }));
  const all = units.map((_, i) => i);
  // Rows for entries that tie to no verification.
  const extra: ExplainRow[] = [];

  // The suppress stage. The passed verifications that no rule removed form
  // the index space of the merge groups, in record order.
  const suppressedSet = new Set<number>();
  for (const s of stages.suppressed) {
    const key = findingKey(s.finding);
    const i = firstFree(
      all,
      suppressedSet,
      (j) => stages.verifications[j]?.passed === true && findingKey(units[j]!.finding) === key,
    );
    const reason = `suppressed by rule ${s.rule.reason}`;
    if (i === -1) {
      extra.push(
        rowOf({
          reviewer: s.reviewer,
          pass: null,
          stage: "suppress",
          outcome: "dropped",
          reason,
          finding: s.finding,
        }),
      );
      continue;
    }
    suppressedSet.add(i);
    Object.assign(units[i]!, { stage: "suppress", reason });
  }
  const kept = all.filter((i) => stages.verifications[i]?.passed === true && !suppressedSet.has(i));

  // The merge stage.
  const gone = new Set<number>();
  stages.merges.forEach((m, g) => {
    const members = m.group.flatMap((index) => {
      const i = kept[index];
      return i === undefined ? [] : [i];
    });
    for (const i of members) units[i]!.stage = "merge";
    if (isFailure(m.result)) {
      for (const i of members) units[i]!.suffix = `; merge query failed: ${m.result.kind}`;
      return;
    }
    if (m.rejected !== undefined) {
      for (const i of members) units[i]!.suffix = `; merge rejected: ${m.rejected}`;
      return;
    }
    const keptMembers = new Set(m.result.merged.map((e) => members[e.member_index]));
    for (const i of members) {
      if (keptMembers.has(i)) continue;
      gone.add(i);
      units[i]!.reason = `merged into group ${g} as a duplicate`;
    }
  });
  const alive = kept.filter((i) => !gone.has(i));

  // The cap and post stages, and the carried findings. Each entry ties by
  // file, span and category, because a merge rewrites the claim.
  const tied = new Set<number>();
  const rowsByFingerprint = new Map<string, { unit: Unit | null; row: ExplainRow | null }>();
  const place = (
    entries: PostedFinding[],
    candidates: number[],
    stage: string,
    outcome: (f: PostedFinding) => "kept" | "dropped",
    reason: (f: PostedFinding) => string,
  ): void => {
    for (const f of entries) {
      const i = firstFree(candidates, tied, (j) => sameLocation(units[j]!.finding, f));
      if (i === -1) {
        const row = rowOf({
          reviewer: null,
          pass: null,
          stage,
          outcome: outcome(f),
          reason: reason(f),
          finding: f,
        });
        extra.push(row);
        rowsByFingerprint.set(f.fingerprint, { unit: null, row });
        continue;
      }
      tied.add(i);
      Object.assign(units[i]!, { finding: f, stage, outcome: outcome(f), reason: reason(f) });
      rowsByFingerprint.set(f.fingerprint, { unit: units[i]!, row: null });
    }
  };
  place(
    posted.findings,
    alive,
    "post",
    () => "kept",
    (f) => `posted as ${f.severity}`,
  );
  place(
    stages.capped,
    alive,
    "cap",
    () => "dropped",
    () => "capped: over the non-blocking cap",
  );
  place(
    posted.below_floor,
    alive,
    "post",
    () => "dropped",
    () => "not posted: below the floor of a later run",
  );
  const notPassed = all.filter((i) => stages.verifications[i]?.passed !== true);
  place(
    stages.pre_existing,
    notPassed,
    "scope",
    () => (values.pre_existing === "comment" ? "kept" : "dropped"),
    () => "pre-existing: out of scope",
  );
  place(
    posted.carried,
    alive,
    "post",
    () => "kept",
    () => "carried from an earlier run",
  );

  // A verification that looks pre-existing, but that stages.pre_existing
  // does not hold, was not kept. The record does not say which check
  // removed it, so the reason names each check that can.
  if (values.pre_existing === "comment") {
    for (const i of notPassed) {
      const v = stages.verifications[i];
      if (tied.has(i) || !v || !looksPreExisting(v, thresholds[i] ?? { t: 0 })) continue;
      Object.assign(units[i]!, {
        stage: "scope",
        reason:
          "pre-existing candidate, not kept: a failed quote, a suppression, a dismissal or a duplicate fingerprint",
      });
    }
  }

  // A fingerprint that did not post again ties to a posted-shaped entry
  // with that fingerprint, else it has its own row.
  const fingerprintRows: ExplainRow[] = [];
  for (const entry of posted.not_reposted) {
    const reason = `not posted: fingerprint ${entry.reason}`;
    const hit = rowsByFingerprint.get(entry.fingerprint);
    if (hit?.unit) hit.unit.reason += `; ${reason}`;
    else if (hit?.row) hit.row.reason += `; ${reason}`;
    else {
      fingerprintRows.push({
        reviewer: null,
        pass: null,
        file: null,
        span: null,
        category: null,
        claim: null,
        fingerprint: entry.fingerprint,
        stage: "post",
        outcome: "dropped",
        reason,
        finding: null,
      });
    }
  }

  const unitRow = (u: Unit): ExplainRow =>
    rowOf({
      ...reviewerOf(u.refs),
      stage: u.stage,
      outcome: u.outcome,
      reason: u.reason + u.suffix,
      finding: u.finding,
    });

  // The rows go in the order of the reviewer entries. A reviewer finding
  // with no verification has its own row.
  const rows: ExplainRow[] = [];
  const shown = new Set<number>();
  const verified = new Map<string, number[]>();
  ties.forEach((t, i) => {
    for (const r of t) {
      const key = findingKey(r.finding);
      verified.set(key, [...new Set([...(verified.get(key) ?? []), i])]);
    }
  });
  for (const entry of stages.reviewers) {
    for (const finding of entry.findings) {
      const indices = verified.get(findingKey(finding));
      if (indices === undefined) {
        rows.push(
          rowOf({
            reviewer: entry.name,
            pass: entry.pass,
            stage: "reviewer",
            outcome: "dropped",
            reason: "not verified: a duplicate fingerprint in the same run",
            finding,
          }),
        );
        continue;
      }
      for (const i of indices) {
        if (shown.has(i)) continue;
        shown.add(i);
        rows.push(unitRow(units[i]!));
      }
    }
    for (const d of entry.dropped) {
      rows.push(
        rowOf({
          reviewer: entry.name,
          pass: entry.pass,
          stage: "reviewer",
          outcome: "dropped",
          reason: `dropped by the reviewer quote check: ${d.reason}`,
          finding: d.finding,
        }),
      );
    }
  }
  units.forEach((u, i) => {
    if (!shown.has(i)) rows.push(unitRow(u));
  });
  return [...rows, ...extra, ...fingerprintRows];
}
