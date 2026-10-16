// Tie the places of a run record that hold one finding. The record holds
// no id for a finding, so the ties use the fields that each place keeps.
import type { Finding } from "../schemas/finding.js";
import type { RunRecord } from "../schemas/record.js";

type Verification = RunRecord["stages"]["verifications"][number];

/** A finding of a reviewer entry: the reviewer, the pass and the finding. */
export type ReviewerRef = { name: string; pass: number; finding: Finding };

// The fields of a finding, in a fixed order, so two equal findings give
// the same key whatever the key order of their JSON.
const FINDING_FIELDS: readonly (keyof Finding)[] = [
  "file",
  "start_line",
  "end_line",
  "category",
  "severity_estimate",
  "confidence",
  "claim",
  "evidence",
  "suggested_fix",
  "explanation",
  "needs_context",
];

/** A key that is equal for two findings when all their finding fields are equal. */
export function findingKey(f: Finding): string {
  return JSON.stringify(FINDING_FIELDS.map((field) => f[field] ?? null));
}

/** True when two findings have the same file, span and category. */
export function sameLocation(
  a: Pick<Finding, "file" | "start_line" | "end_line" | "category">,
  b: Pick<Finding, "file" | "start_line" | "end_line" | "category">,
): boolean {
  return (
    a.file === b.file &&
    a.start_line === b.start_line &&
    a.end_line === b.end_line &&
    a.category === b.category
  );
}

/** Every finding of every reviewer entry, in record order. */
export function reviewerRefs(record: RunRecord): ReviewerRef[] {
  return record.stages.reviewers.flatMap((entry) =>
    entry.findings.map((finding) => ({ name: entry.name, pass: entry.pass, finding })),
  );
}

/**
 * Give the reviewer findings that each verification ties to. A
 * verification ties to the reviewer findings with equal fields. When
 * several verifications have equal findings, and as many reviewers gave
 * that finding, each verification gets the findings of one reviewer, in
 * order. Otherwise each such verification ties to all of them.
 */
export function tieVerifications(
  verifications: Verification[],
  refs: ReviewerRef[],
): ReviewerRef[][] {
  const byKey = new Map<string, number[]>();
  verifications.forEach((v, i) => {
    const key = findingKey(v.finding);
    byKey.set(key, [...(byKey.get(key) ?? []), i]);
  });
  const ties: ReviewerRef[][] = verifications.map(() => []);
  for (const [key, indices] of byKey) {
    const equal = refs.filter((r) => findingKey(r.finding) === key);
    const names = [...new Set(equal.map((r) => r.name))];
    indices.forEach((index, j) => {
      const name = names[j];
      ties[index] =
        indices.length > 1 && indices.length === names.length && name !== undefined
          ? equal.filter((r) => r.name === name)
          : equal;
    });
  }
  return ties;
}

/**
 * Give the index of the first candidate that "matches", or -1. A candidate
 * is the index of an item that no earlier tie took.
 */
export function firstFree(
  candidates: number[],
  taken: Set<number>,
  matches: (index: number) => boolean,
): number {
  return candidates.find((i) => !taken.has(i) && matches(i)) ?? -1;
}
