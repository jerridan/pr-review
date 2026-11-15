// The candidates of a replay: the findings that a run sent, or would send,
// to the verifier, and the findings of a reviewer outside the pipeline.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  diffEvidenceText,
  evidenceMatches,
  lineCount,
  lineRangeValid,
  normalizeFindingPath,
  normalizeWs,
  readHeadFile,
} from "../../find/evidence.js";
import type { Finding } from "../../schemas/finding.js";
import type { FindingSource, QueryFailure, RunRecord } from "../../schemas/record.js";
import {
  ExternalCandidatesSchema,
  type CallMeta,
  type ExternalCandidates,
} from "../../schemas/replay.js";
import type { VerifierResult } from "../../schemas/verifier.js";
import { seededRandom } from "../bootstrap.js";
import { findingKey } from "../score.js";

/** What the stored arm reads of one verification of a full record. */
export type Stored = {
  first: VerifierResult | QueryFailure;
  escalated: boolean;
  /** The final decision of the run, after the escalation. */
  passed: boolean;
  /** The first verifier call, or null when the record has no entry for it. */
  call: CallMeta | null;
  /** The known cost of the escalation queries of the verification. */
  escalationCostUsd: number;
};

/** One candidate of a replay. */
export type Candidate = {
  case: string;
  repeat: number | "external";
  /** findingKey of src/eval/score.ts. */
  key: string;
  finding: Finding;
  sources: FindingSource[];
  /** The reviewer whose threshold applies: the first source in source order, or the external source. */
  reviewer: string;
  /** The stored verification, for a candidate of a full record. */
  stored?: Stored;
};

/** An input that the replay refuses before any call: the usage code. */
export class ReplayUsageError extends Error {}

/** True for a stage 1 record. A record with no mode is a full record. */
export const isStage1 = (record: RunRecord): boolean => record.identity.mode === "stage1";

// The call entry of the first verifier query of verification "index".
function storedCall(record: RunRecord, index: number): CallMeta | null {
  const q = record.cost.queries.find((e) => e.role === "verifier" && e.verification === index);
  if (!q) return null;
  return {
    model: q.model,
    // A record from before D4c has no effort in its entries.
    effort: q.effort ?? record.identity.models.verifier.effort,
    cost_usd: q.cost_usd,
    duration_ms: q.duration_ms,
  };
}

/**
 * The candidates of a record. A full record gives its verifications in
 * record order, with their sources and the stored results. A stage 1
 * record gives its stages.candidates in order. A finding with the reviewer and the key of
 * an earlier candidate is not added again.
 */
export function recordCandidates(record: RunRecord, caseName: string, repeat: number): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const add = (finding: Finding, sources: FindingSource[], fallback: string, stored?: Stored) => {
    const key = findingKey(finding);
    const reviewer = sources[0]?.reviewer ?? fallback;
    // Two reviewers with the same file, span and claim give two candidates.
    const id = JSON.stringify([reviewer, key]);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      case: caseName,
      repeat,
      key,
      finding,
      sources,
      reviewer,
      ...(stored ? { stored } : {}),
    });
  };
  if (isStage1(record)) {
    for (const c of record.stages.candidates ?? []) add(c.finding, c.sources, c.reviewer);
    return out;
  }
  record.stages.verifications.forEach((v, i) => {
    const escalationCostUsd = record.cost.queries
      .filter((q) => q.role === "verifier-escalation" && q.verification === i)
      .reduce((sum, q) => sum + (q.cost_usd ?? 0), 0);
    add(v.finding, v.sources ?? [], "", {
      first: v.first,
      escalated: v.escalated !== undefined,
      passed: v.passed,
      call: storedCall(record, i),
      escalationCostUsd,
    });
  });
  return out;
}

/** Read "<dir>/<case>.json" of --candidates, or null when the case has none. */
export async function readExternal(
  dir: string,
  caseName: string,
): Promise<ExternalCandidates | null> {
  const path = join(dir, `${caseName}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReplayUsageError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ReplayUsageError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ExternalCandidatesSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ReplayUsageError(`${path} does not fit the candidates schema: ${issues}`);
  }
  return parsed.data;
}

/** The reasons for which the pipeline drops a reviewer finding. */
export type DropReason = "out-of-range" | "bad-quote";
export type Dropped = Record<DropReason, number>;
export const noDrops = (): Dropped => ({ "out-of-range": 0, "bad-quote": 0 });

/**
 * The checks of the pipeline for a reviewer finding (src/find/index.ts),
 * for the findings of an external source: the path, the line range in the
 * head file, and the evidence in the head file or the diff of the file.
 * Give the kept findings, with a normalized path, and the drops by reason.
 */
export function checkExternal(
  findings: Finding[],
  cwd: string,
  sections: Map<string, string>,
): { kept: Finding[]; dropped: Dropped } {
  const dropped = noDrops();
  const kept: Finding[] = [];
  for (const reported of findings) {
    const file = normalizeFindingPath(reported.file);
    if (file === null) {
      dropped["out-of-range"] += 1;
      continue;
    }
    const finding = file === reported.file ? reported : { ...reported, file };
    const raw = readHeadFile(cwd, file);
    if (!lineRangeValid(finding, raw === null ? null : lineCount(raw))) {
      dropped["out-of-range"] += 1;
    } else if (
      !evidenceMatches(
        finding.evidence,
        raw === null ? null : normalizeWs(raw),
        diffEvidenceText(sections.get(file) ?? ""),
      )
    ) {
      dropped["bad-quote"] += 1;
    } else {
      kept.push(finding);
    }
  }
  return { kept, dropped };
}

/** The candidates of an external source for one case, after the checks. */
export function externalCandidates(
  caseName: string,
  source: string,
  findings: Finding[],
): Candidate[] {
  const seen = new Set<string>();
  return findings.flatMap((finding) => {
    const key = findingKey(finding);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        case: caseName,
        repeat: "external" as const,
        key,
        finding,
        sources: [{ reviewer: source, pass: 1 }],
        reviewer: source,
      },
    ];
  });
}

/** True when a candidate has a source of one of the named reviewers. */
export function fromReviewers(c: Candidate, names: ReadonlySet<string>): boolean {
  return c.sources.some((s) => names.has(s.reviewer)) || names.has(c.reviewer);
}

/** The --sample value. */
export type SampleKind = "all" | "golden-plus-equal" | number;

/** The identity of a candidate in the output: its case, its repeat, its reviewer and its key. */
export const candidateId = (c: Pick<Candidate, "case" | "repeat" | "reviewer" | "key">): string =>
  JSON.stringify([c.case, c.repeat, c.reviewer, c.key]);

// A seeded shuffle (Fisher-Yates) of a copy of "items".
function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The sample of the candidates of all cases at once. "all" keeps every
 * candidate. A number keeps that many, drawn with the seed.
 * "golden-plus-equal" keeps every candidate that matches a golden of any
 * label, and draws the same count of the others. The same input and seed
 * give the same sample. The sample keeps the input order.
 */
export function drawSample(
  candidates: Candidate[],
  kind: SampleKind,
  seed: number,
  matched: (c: Candidate) => boolean,
): Candidate[] {
  if (kind === "all") return candidates;
  const random = seededRandom(seed);
  let chosen: Candidate[];
  if (kind === "golden-plus-equal") {
    const hits = candidates.filter(matched);
    const others = candidates.filter((c) => !matched(c));
    chosen = [...hits, ...shuffled(others, random).slice(0, hits.length)];
  } else {
    chosen = shuffled(candidates, random).slice(0, kind);
  }
  const keep = new Set(chosen.map(candidateId));
  return candidates.filter((c) => keep.has(candidateId(c)));
}
