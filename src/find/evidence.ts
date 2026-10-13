// Checks on a reviewer finding: the evidence quote and the line range.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Finding } from "../schemas/finding.js";

/** Collapse each run of whitespace to one space, and trim the ends. */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Return the text in a file's diff section that a quote can match: the
 * added and context lines, each with its "+" or " " prefix, after
 * whitespace collapse. Removed lines, file headers and hunk headers are
 * not in it.
 */
export function diffEvidenceText(section: string): string {
  const kept: string[] = [];
  let inHunk = false;
  for (const line of section.split("\n")) {
    // A hunk body line starts with " ", "+", "-" or "\", so these two
    // prefixes always start a file header or a hunk header.
    if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && (line.startsWith("+") || line.startsWith(" "))) {
      kept.push(line);
    }
  }
  return normalizeWs(kept.join("\n"));
}

/**
 * Return true when the evidence is a substring of the head file or of the
 * diff text of the finding's file, after whitespace collapse. The two
 * texts must be normalized already (normalizeWs for the head file,
 * diffEvidenceText for the diff), so a run normalizes each text once. The
 * match is case-sensitive. An empty quote never matches.
 */
export function evidenceMatches(
  evidence: string,
  normalizedHeadFile: string | null,
  normalizedFileDiff: string,
): boolean {
  const quote = normalizeWs(evidence);
  if (quote === "") return false;
  if (normalizedHeadFile !== null && normalizedHeadFile.includes(quote)) return true;
  return normalizedFileDiff.includes(quote);
}

/**
 * Normalize the path of a finding: remove "./" and empty segments, so
 * "./src//a.ts" becomes "src/a.ts". Return null for an absolute path, a
 * path with a ".." segment, or an empty path. The path comes from model
 * output, so it is not trusted.
 */
export function normalizeFindingPath(file: string): string | null {
  if (isAbsolute(file)) return null;
  const parts = file.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}

/** The number of lines in a file. A final newline does not start a line. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/**
 * Return true when start_line is 1 or more, end_line is not below
 * start_line, and end_line is not past the last line of the head file.
 * A file that the head does not have has no valid range.
 */
export function lineRangeValid(f: Finding, headLineCount: number | null): boolean {
  if (headLineCount === null) return false;
  if (!Number.isInteger(f.start_line) || !Number.isInteger(f.end_line)) return false;
  return f.start_line >= 1 && f.end_line >= f.start_line && f.end_line <= headLineCount;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Read a file of the head checkout. Return null when the file does not
 * exist, or when the path (also through a symlink) goes outside "cwd".
 * The path comes from model output, so it is not trusted.
 */
export function readHeadFile(cwd: string, file: string): string | null {
  if (isAbsolute(file)) return null;
  try {
    const root = realpathSync(cwd);
    const full = resolve(root, file);
    if (!inside(root, full)) return null;
    const real = realpathSync(full);
    if (!inside(root, real)) return null;
    return readFileSync(real, "utf8");
  } catch {
    return null;
  }
}
