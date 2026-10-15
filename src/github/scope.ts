// The scope of a later run (R7): the hunks that are new since the last
// reviewed head, and the fetch of that head when the store lacks it.
import { diffSections } from "../gather/diff.js";
import { runGit } from "../gather/worktree.js";

type Hunk = { text: string; key: string };

// Split the text of one file section into its header lines and its hunks.
// The key of a hunk is its added and removed lines. Context lines and the
// line numbers are not in the key, so a hunk that only moved keeps its key.
function splitHunks(section: string): { header: string; hunks: Hunk[] } {
  const lines = section.split("\n");
  // The section ends with a newline, so the last item is empty.
  if (lines.at(-1) === "") lines.pop();
  const first = lines.findIndex((line) => line.startsWith("@@"));
  if (first === -1) return { header: lines.map((l) => `${l}\n`).join(""), hunks: [] };
  const header = lines
    .slice(0, first)
    .map((l) => `${l}\n`)
    .join("");
  const hunks: Hunk[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const changed = current.filter((l) => l.startsWith("+") || l.startsWith("-"));
    hunks.push({ text: current.map((l) => `${l}\n`).join(""), key: changed.join("\n") });
    current = [];
  };
  for (const line of lines.slice(first)) {
    if (line.startsWith("@@")) flush();
    current.push(line);
  }
  flush();
  return { header, hunks };
}

/**
 * Give the hunks of "headDiff" that are new against "priorDiff". The prior
 * diff holds each key (path plus added and removed lines) a number of times.
 * Walk the head hunks in order. A head hunk is not new when the prior count
 * of its key is more than zero. Then take one from that count. Thus a second
 * hunk with the same changed lines as one prior hunk is new. The diff holds,
 * per file with a new hunk, the header lines of the file and its new hunks
 * only. "files" lists those files.
 */
export function newHunks(headDiff: string, priorDiff: string): { diff: string; files: string[] } {
  const priorCounts = new Map<string, Map<string, number>>();
  for (const [path, section] of diffSections(priorDiff)) {
    const counts = new Map<string, number>();
    for (const h of splitHunks(section).hunks) counts.set(h.key, (counts.get(h.key) ?? 0) + 1);
    priorCounts.set(path, counts);
  }
  let diff = "";
  const files: string[] = [];
  for (const [path, section] of diffSections(headDiff)) {
    const { header, hunks } = splitHunks(section);
    const remaining = priorCounts.get(path) ?? new Map<string, number>();
    const fresh = hunks.filter((h) => {
      const left = remaining.get(h.key) ?? 0;
      if (left === 0) return true;
      remaining.set(h.key, left - 1);
      return false;
    });
    if (fresh.length === 0) continue;
    diff += header + fresh.map((h) => h.text).join("");
    files.push(path);
  }
  return { diff, files };
}

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    await runGit(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure that "sha" is a commit in the store of "repo". When it is not,
 * fetch it from the remote "origin" through git. This is not a call to the
 * GitHub API. Give false when the commit is still missing.
 */
export async function ensureCommit(repo: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return false;
  if (await hasCommit(repo, sha)) return true;
  try {
    await runGit(repo, ["fetch", "--quiet", "--no-tags", "origin", sha]);
  } catch {
    return false;
  }
  return hasCommit(repo, sha);
}
