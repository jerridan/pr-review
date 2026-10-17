// The deterministic match pass of the eval: classify one pair of a posted
// finding and a golden finding.
import type { Finding } from "../schemas/finding.js";
import type { GoldenFinding } from "./case.js";

export type PairKind = "exact" | "ambiguous" | "none";

/** The largest distance in lines at which two spans are near. */
const NEAR_LINES = 10;

/**
 * Classify a pair. The same file, overlapping spans and the same category
 * give "exact". The same file and spans within 10 lines give "ambiguous"
 * when the spans do not overlap or the categories differ. Every other pair
 * gives "none".
 */
export function classifyPair(posted: Finding, golden: GoldenFinding): PairKind {
  if (posted.file !== golden.file) return "none";
  // Two spans overlap when each starts on or before the end of the other.
  const overlap = posted.start_line <= golden.end_line && golden.start_line <= posted.end_line;
  if (overlap && posted.category === golden.category) return "exact";
  if (overlap) return "ambiguous";
  // The start of the later span minus the end of the earlier span.
  const distance =
    posted.start_line > golden.end_line
      ? posted.start_line - golden.end_line
      : golden.start_line - posted.end_line;
  return distance <= NEAR_LINES ? "ambiguous" : "none";
}
