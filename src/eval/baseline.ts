// The baseline file of the eval gate: read it, compare a report with it,
// and write a new one.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Report } from "./report.js";

export type Baseline = {
  recall: number;
  precision: number;
  margin: { recall: number; precision: number };
  cases_ref: string | null;
  repeat: number;
  written_at: string;
  tool_version: string;
};

export type Gate = {
  passed: boolean;
  recall_drop: number | null;
  precision_drop: number | null;
  margin: { recall: number; precision: number };
};

const BaselineSchema = z.strictObject({
  recall: z.number(),
  precision: z.number(),
  margin: z.strictObject({ recall: z.number().min(0), precision: z.number().min(0) }),
  cases_ref: z.string().nullable(),
  repeat: z.int().min(1),
  written_at: z.string(),
  tool_version: z.string(),
});

/** The margin of a baseline that the eval writes when no file exists. */
const DEFAULT_MARGIN = { recall: 0.05, precision: 0.05 };

// A drop equal to the margin passes. This tolerance keeps that true when
// the float sum of a mean has a small error.
const TOLERANCE = 1e-9;

/** Read and validate a baseline file. Throw when it is missing or invalid. */
export async function readBaseline(path: string): Promise<Baseline> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read the baseline ${path}: ${reason}`, { cause: err });
  }
  const parsed = BaselineSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`the baseline ${path} is invalid: ${issues}`);
  }
  return parsed.data;
}

/**
 * Compare the aggregate means of a report with a baseline. Each drop is
 * the baseline value minus the mean. The gate fails when a drop is above
 * its margin, or when a mean is null.
 */
export function compareBaseline(baseline: Baseline, report: Report): Gate {
  const recall = report.aggregate.recall.mean;
  const precision = report.aggregate.precision.mean;
  const recallDrop = recall === null ? null : baseline.recall - recall;
  const precisionDrop = precision === null ? null : baseline.precision - precision;
  const within = (drop: number | null, margin: number): boolean =>
    drop !== null && drop <= margin + TOLERANCE;
  return {
    passed:
      within(recallDrop, baseline.margin.recall) &&
      within(precisionDrop, baseline.margin.precision),
    recall_drop: recallDrop,
    precision_drop: precisionDrop,
    margin: { ...baseline.margin },
  };
}

/**
 * Write the aggregate means of a report as the baseline. Keep the margin
 * of the existing baseline, or use 0.05 for each metric. Throw, and write
 * nothing, when a mean is null.
 */
export async function writeBaseline(
  path: string,
  report: Report,
  existing: Baseline | null,
  meta: { repeat: number; tool_version: string },
): Promise<void> {
  const recall = report.aggregate.recall.mean;
  const precision = report.aggregate.precision.mean;
  if (recall === null || precision === null) {
    const missing = recall === null ? "recall" : "precision";
    throw new Error(`the eval has no mean ${missing}, so it cannot write a baseline`);
  }
  const baseline: Baseline = {
    recall,
    precision,
    margin: existing ? { ...existing.margin } : { ...DEFAULT_MARGIN },
    cases_ref: report.cases_ref,
    repeat: meta.repeat,
    written_at: new Date().toISOString(),
    tool_version: meta.tool_version,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
}
