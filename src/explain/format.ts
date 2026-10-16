// Render the rows of "pr-review explain" as a table or as a JSON document.
import type { ExplainRow } from "./index.js";

/** The most characters of a claim in the table. */
const CLAIM_WIDTH = 60;

// Put a claim on one line, and cut it to the width of its column.
function oneLine(claim: string): string {
  const flat = claim.replace(/\s+/g, " ").trim();
  return flat.length <= CLAIM_WIDTH ? flat : `${flat.slice(0, CLAIM_WIDTH - 3)}...`;
}

function location(row: ExplainRow): string {
  if (row.file === null || row.span === null) {
    return row.fingerprint === null ? "-" : `fingerprint ${row.fingerprint}`;
  }
  return `${row.file}:${row.span[0]}-${row.span[1]}`;
}

/** One table row for each finding, with a header line. */
export function renderExplainTable(rows: ExplainRow[]): string {
  const cells = [
    ["reviewer", "pass", "location", "category", "claim", "stage", "outcome", "reason"],
    ...rows.map((r) => [
      r.reviewer ?? "unknown",
      r.pass === null ? "unknown" : String(r.pass),
      location(r),
      r.category ?? "-",
      r.claim === null ? "-" : oneLine(r.claim),
      r.stage,
      r.outcome,
      r.reason,
    ]),
  ];
  const widths: number[] = [];
  for (const row of cells) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  }
  const lines = cells.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The JSON document: "findings", one entry for each row, with the raw
 * fields of the finding and the stage, the outcome, the reason, the
 * reviewer and the pass.
 */
export function renderExplainJson(rows: ExplainRow[]): string {
  const findings = rows.map((r) => ({
    ...(r.finding ?? { fingerprint: r.fingerprint }),
    reviewer: r.reviewer,
    pass: r.pass,
    stage: r.stage,
    outcome: r.outcome,
    reason: r.reason,
  }));
  return `${JSON.stringify({ findings }, null, 2)}\n`;
}
