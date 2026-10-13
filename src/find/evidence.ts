// Checks on a reviewer finding: the evidence quote and the line range.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Finding } from "../schemas/finding.js";

/** Collapse each run of whitespace to one space, and trim the ends. */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Return true when the evidence is a substring of the head file or of the
 * diff, after whitespace collapse in both. The match is case-sensitive.
 * An empty quote never matches.
 */
export function evidenceMatches(
  evidence: string,
  headFileText: string | null,
  diff: string,
): boolean {
  const quote = normalizeWs(evidence);
  if (quote === "") return false;
  if (headFileText !== null && normalizeWs(headFileText).includes(quote)) return true;
  return normalizeWs(diff).includes(quote);
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
