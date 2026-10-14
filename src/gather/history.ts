// The history block: git blame and git log for the lines that a change
// touches, read at the merge base of base and head. The history reviewer
// gets it as data, so no reviewer needs Bash.
import { readBlobAt } from "./blob.js";
import { runGit } from "./worktree.js";

/** The most bytes of the history block. A longer block is cut at a line end. */
export const HISTORY_CAP_BYTES = 65536;

/** The most commits that the log of one file shows. */
export const HISTORY_LOG_LIMIT = 10;

export type LineRange = { start: number; end: number };

// A hunk header: "@@ -start,count +start,count @@". A count that is not
// there is 1. A hunk body line starts with " ", "+", "-" or "\", so a line
// that starts with "@@" is always a header.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/**
 * The old-side line range of each hunk in the diff section of one file,
 * context lines included. A hunk with no old lines (a pure addition) gives
 * the line before the addition, or nothing at the start of the file.
 */
export function oldSideRanges(section: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of section.split("\n")) {
    const m = HUNK_HEADER.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
    else if (start > 0) ranges.push({ start, end: start });
  }
  return ranges;
}

// Keep the ranges inside lines 1 to "lines", sort them, and join ranges
// that overlap or touch.
function clampRanges(ranges: LineRange[], lines: number): LineRange[] {
  const kept = ranges
    .map((r) => ({ start: Math.max(1, r.start), end: Math.min(lines, r.end) }))
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start - b.start);
  const out: LineRange[] = [];
  for (const r of kept) {
    const last = out.at(-1);
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

// Cut the text at a line end so that it fits in "cap" bytes.
function capText(text: string, cap: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return { text, truncated: false };
  const head = bytes.subarray(0, cap);
  const end = head.lastIndexOf(0x0a);
  return { text: head.subarray(0, Math.max(0, end)).toString("utf8"), truncated: true };
}

async function fileHistory(
  repo: string,
  mergeBase: string,
  path: string,
  ranges: LineRange[],
): Promise<string | null> {
  const text = await readBlobAt(repo, mergeBase, path);
  if (text === null) return null;
  const clamped = clampRanges(ranges, lineCount(text));
  if (clamped.length === 0) return null;

  const blameArgs = clamped.flatMap((r) => ["-L", `${r.start},${r.end}`]);
  const logArgs = clamped.flatMap((r) => ["-L", `${r.start},${r.end}:${path}`]);
  const blame = await runGit(repo, ["blame", "--date=short", ...blameArgs, mergeBase, "--", path]);
  const log = await runGit(repo, [
    "log",
    "--no-patch",
    "--format=%h %ad %an %s",
    "--date=short",
    `--max-count=${HISTORY_LOG_LIMIT}`,
    ...logArgs,
    mergeBase,
  ]);
  // Each part starts with the git command that made it, so the reader
  // knows the file, the lines and the commit.
  const short = mergeBase.slice(0, 12);
  return [
    `git blame ${blameArgs.join(" ")} ${short} -- ${path}`,
    blame.trimEnd(),
    "",
    `git log ${logArgs.join(" ")} ${short}`,
    log.trimEnd(),
  ].join("\n");
}

/**
 * Run blame and log at the merge base for the given old-side line ranges
 * of each file. A file that the merge base does not have gets no entry.
 * Give null when no file gets an entry. The block is cut at a line end to
 * fit HISTORY_CAP_BYTES, and "truncated" tells when it was cut.
 */
export async function gatherHistory(
  repo: string,
  mergeBase: string,
  hunks: { path: string; ranges: { start: number; end: number }[] }[],
): Promise<{ text: string; truncated: boolean } | null> {
  const parts: string[] = [];
  for (const { path, ranges } of hunks) {
    const part = await fileHistory(repo, mergeBase, path, ranges);
    if (part !== null) parts.push(part);
  }
  if (parts.length === 0) return null;
  return capText(parts.join("\n\n"), HISTORY_CAP_BYTES);
}
