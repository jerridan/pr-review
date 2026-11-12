// Read the findings of a run record for the pool. The reader is lenient:
// it reads only the parts that the pool needs, so a record of an older
// version also works.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { InputFindingSchema, type PoolFinding } from "./schemas.js";

/** A record file or a finding file that the pool cannot use. */
export class PoolInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PoolInputError";
  }
}

/** A run record, as the pool reads it. */
export type PoolRecord = {
  path: string;
  /** The file name of the record, for the source label. */
  name: string;
  pr: number | null;
  /** The identity.head of the record, or null. */
  head: string | null;
  /** The owner/repo of the record: its slug, else its identity.repo when that has this form. */
  repo: string | null;
  value: unknown;
};

const OWNER_REPO = /^[^/\s]+\/[^/\s]+$/;

/** A finding of a record, with the name of its reviewer. */
export type ReviewerFinding = { reviewer: string; finding: PoolFinding };

const RecordHeadSchema = z.object({
  identity: z.object({
    pr: z.int().nullable().optional(),
    head: z.string().optional(),
    repo: z.string().optional(),
    github: z.object({ slug: z.string() }).nullable().optional(),
  }),
});

const ReviewersSchema = z.object({
  stages: z.object({
    reviewers: z.array(z.object({ name: z.string(), findings: z.array(z.unknown()) })),
  }),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Read a JSON file. Throw a PoolInputError when it cannot be read or is not JSON. */
export async function readJsonFile(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PoolInputError(`cannot read the ${what} ${path}: ${reason}`, { cause: err });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PoolInputError(`the ${what} ${path} is not JSON: ${reason}`, { cause: err });
  }
}

/** Read a run record. Throw a PoolInputError when it has no identity. */
export async function readRecord(path: string): Promise<PoolRecord> {
  const value = await readJsonFile(path, "record");
  const head = RecordHeadSchema.safeParse(value);
  if (!head.success) {
    throw new PoolInputError(`the record ${path} is invalid: ${describeIssues(head.error)}`);
  }
  const { repo, github } = head.data.identity;
  const slug = github?.slug ?? repo ?? null;
  return {
    path,
    name: basename(path),
    pr: head.data.identity.pr ?? null,
    head: head.data.identity.head ?? null,
    repo: slug !== null && OWNER_REPO.test(slug) ? slug : null,
    value,
  };
}

/** Check one finding of a record or a file. Throw a PoolInputError when it is invalid. */
export function inputFinding(value: unknown, where: string): PoolFinding {
  const parsed = InputFindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new PoolInputError(`${where} is not a valid finding: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Every finding in stages.reviewers[].findings of a record: every reviewer and every pass. */
export function reviewerFindings(record: PoolRecord): ReviewerFinding[] {
  const parsed = ReviewersSchema.safeParse(record.value);
  if (!parsed.success) {
    throw new PoolInputError(
      `the record ${record.path} has no reviewer findings: ${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data.stages.reviewers.flatMap((r, i) =>
    r.findings.map((f, j) => ({
      reviewer: r.name,
      finding: inputFinding(f, `stages.reviewers.${i}.findings.${j} of ${record.path}`),
    })),
  );
}

/** The labels with which the verifier dismisses a finding. */
export const DISMISS_LABELS = ["dont_post", "not_real"] as const;
export type DismissLabel = (typeof DISMISS_LABELS)[number];

/** A finding that the verifier dismissed, with its label. */
export type DismissedFinding = { finding: PoolFinding; label: DismissLabel };

const VerificationsSchema = z.object({
  stages: z.object({
    verifications: z
      .array(
        z.object({
          finding: z.unknown(),
          passed: z.boolean(),
          final: z.object({ severity: z.string() }).nullable().optional(),
        }),
      )
      .optional(),
  }),
});

/**
 * Every finding in stages.verifications of a record with passed false and a
 * final severity of dont_post or not_real. A record with no verifications
 * gives none.
 */
export function dismissedFindings(record: PoolRecord): DismissedFinding[] {
  const parsed = VerificationsSchema.safeParse(record.value);
  if (!parsed.success) {
    throw new PoolInputError(
      `the record ${record.path} has no valid verifications: ${describeIssues(parsed.error)}`,
    );
  }
  return (parsed.data.stages.verifications ?? []).flatMap((v, i) => {
    const label = DISMISS_LABELS.find((l) => l === v.final?.severity);
    if (v.passed || label === undefined) return [];
    return [
      {
        finding: inputFinding(v.finding, `stages.verifications.${i}.finding of ${record.path}`),
        label,
      },
    ];
  });
}

/** The lists of a record that hold fingerprinted findings. */
const FINGERPRINT_LISTS = [
  ["posted", "findings"],
  ["posted", "below_floor"],
  ["posted", "carried"],
  ["stages", "capped"],
  ["stages", "pre_existing"],
] as const;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The finding with "fingerprint" in a record, or null when no list holds it. */
export function findFingerprint(record: PoolRecord, fingerprint: string): PoolFinding | null {
  for (const [part, list] of FINGERPRINT_LISTS) {
    const items = field(field(record.value, part), list);
    if (!Array.isArray(items)) continue;
    const n = items.findIndex((f) => field(f, "fingerprint") === fingerprint);
    if (n >= 0) return inputFinding(items[n], `${part}.${list}.${n} of ${record.path}`);
  }
  return null;
}

/**
 * The owner/repo of a case, from the pull request URL in its "origin", as in
 * "https://github.com/owner/repo/pull/14". Null when "origin" has another form.
 */
export function caseRepo(origin: string): string | null {
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/.exec(origin);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The PR number of a case: the trailing number of its name, as in "walle-14". */
export function casePrNumber(name: string): number | null {
  const match = /-(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}
