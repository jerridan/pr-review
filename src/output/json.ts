// The --format json output: one JSON document.
import type { RunRecord } from "../schemas/record.js";

/**
 * The JSON document. With "reviewUrl" in "options" (--format github), the
 * document also holds "review_url", which is null when no review posted.
 */
export function formatJson(
  record: RunRecord,
  recordPath: string,
  options?: { reviewUrl: string | null },
): string {
  const doc = {
    record_path: recordPath,
    tier: record.identity.tier,
    verdict: record.posted.verdict,
    coverage: record.posted.coverage,
    excluded_files: record.identity.excluded_files,
    // The total is a lower bound when queries_without_cost is above 0.
    total_cost_usd: record.cost.total_cost_usd,
    queries_without_cost: record.cost.queries_without_cost,
    findings: record.posted.findings,
    ...(options ? { review_url: options.reviewUrl } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
