// The fingerprint of a finding: the file, the normalized text of its line
// span in the head file, and the category.
import { createHash } from "node:crypto";
import { normalizeWs } from "../find/evidence.js";
import type { Finding } from "../schemas/finding.js";

function spanText(f: Finding, headFileText: string | null): string | null {
  if (headFileText === null) return null;
  const lines = headFileText.split("\n");
  if (f.start_line < 1 || f.end_line < f.start_line || f.end_line > lines.length) return null;
  return lines.slice(f.start_line - 1, f.end_line).join("\n");
}

/**
 * Give the text that the fingerprint hashes: the span of the finding in the
 * head file, with each run of whitespace collapsed. When the head file or
 * the span is missing, the evidence quote takes the place of the span.
 */
export function fingerprintSpanText(f: Finding, headFileText: string | null): string {
  return normalizeWs(spanText(f, headFileText) ?? f.evidence);
}

/**
 * Give a stable fingerprint. When the head file or the span is missing,
 * the evidence quote takes the place of the span text.
 */
export function fingerprint(f: Finding, headFileText: string | null): string {
  const span = fingerprintSpanText(f, headFileText);
  return createHash("sha256")
    .update([f.file, span, f.category].join("\0"))
    .digest("hex")
    .slice(0, 16);
}
