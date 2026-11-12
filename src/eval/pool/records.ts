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
  value: unknown;
};

/** A finding of a record, with the name of its reviewer. */
export type ReviewerFinding = { reviewer: string; finding: PoolFinding };

const RecordHeadSchema = z.object({
  identity: z.object({ pr: z.int().nullable().optional() }),
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
  return { path, name: basename(path), pr: head.data.identity.pr ?? null, value };
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

/** The PR number of a case: the trailing number of its name, as in "walle-14". */
export function casePrNumber(name: string): number | null {
  const match = /-(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}
