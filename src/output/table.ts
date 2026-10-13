// The --format table output: a short terminal summary.
import type { PostedFinding, RunRecord } from "../schemas/record.js";

function list(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

function location(f: PostedFinding): string {
  return f.start_line === f.end_line
    ? `${f.file}:${f.start_line}`
    : `${f.file}:${f.start_line}-${f.end_line}`;
}

function table(rows: string[][], rightAligned: Set<number>): string[] {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, col) => {
        // The last column has no padding, so lines have no trailing spaces.
        if (col === row.length - 1) return cell;
        const width = widths[col] ?? 0;
        return rightAligned.has(col) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  "),
  );
}

// The files that the diff does not hold, so no reviewer saw them.
function excluded(files: RunRecord["identity"]["excluded_files"]): string {
  return list(files.map((f) => `${f.path} (${f.reason})`));
}

// The total is a lower bound when a query has no cost, so say that.
function costLine(cost: RunRecord["cost"]): string {
  const missing = cost.queries_without_cost;
  const note = `(${missing} ${missing === 1 ? "query" : "queries"} without a cost)`;
  if (cost.total_cost_usd === null) return missing > 0 ? `unknown ${note}` : "unknown";
  const total = `$${cost.total_cost_usd.toFixed(4)}`;
  return missing > 0 ? `at least ${total} ${note}` : total;
}

export function formatTable(record: RunRecord): string {
  const { identity, posted, cost } = record;
  const coverage = posted.coverage;
  const lines = [
    `Tier: ${identity.tier}`,
    `Reason: ${identity.tier_reason}`,
    `Verdict: ${posted.verdict}`,
    `Coverage: reviewers ran: ${list(coverage.reviewers_ran)}; reviewers failed: ${list(coverage.reviewers_failed)}; findings dropped by failed verifier calls: ${coverage.findings_dropped_by_failed_verifier}`,
    `Excluded files: ${excluded(identity.excluded_files)}`,
    `Cost: ${costLine(cost)}`,
    "",
  ];
  if (posted.findings.length === 0) {
    lines.push("Findings: none posted.");
  } else {
    lines.push(`Findings (${posted.findings.length}):`);
    const rows = [
      ["SEVERITY", "SCORE", "LOCATION", "CATEGORY", "CLAIM"],
      ...posted.findings.map((f) => [
        f.severity,
        String(f.score),
        location(f),
        f.category,
        f.claim,
      ]),
    ];
    lines.push(...table(rows, new Set([1])).map((line) => `  ${line}`));
  }
  return `${lines.join("\n")}\n`;
}
