// The --format json output: one JSON document.
import type { RunRecord } from "../schemas/record.js";

export function formatJson(record: RunRecord, recordPath: string): string {
  const doc = {
    record_path: recordPath,
    tier: record.identity.tier,
    verdict: record.posted.verdict,
    coverage: record.posted.coverage,
    excluded_files: record.identity.excluded_files,
    findings: record.posted.findings,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
