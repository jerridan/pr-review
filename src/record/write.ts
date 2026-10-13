// Write the run record: one JSON file per run.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RecordSchema, type RunRecord } from "../schemas/record.js";

/** "<ISO-8601 UTC timestamp with colons removed>-<7-char head sha>.json" */
export function recordFileName(startedAt: Date, head: string): string {
  return `${startedAt.toISOString().replace(/:/g, "")}-${head.slice(0, 7)}.json`;
}

/**
 * Check the record against the schema, then write it to "outDir". Never
 * overwrite a file. Return the absolute path of the file.
 */
export async function writeRecord(outDir: string, record: RunRecord): Promise<string> {
  const checked = RecordSchema.safeParse(record);
  if (!checked.success) {
    throw new Error(`The run record is not valid: ${checked.error.message}`);
  }
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const name = recordFileName(new Date(record.identity.started_at), record.identity.head);
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}
