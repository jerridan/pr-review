// Gather: the three-dot diff between two commits, with rename detection,
// the changed files with their hunk counts, the exclusions, the merge
// base, the description of the change and the history block.
import { diffSections, parseNameStatus } from "./diff.js";
import { applyExclusions } from "./exclusions.js";
import { gatherHistory, oldSideRanges } from "./history.js";
import { runGit } from "./worktree.js";

export interface GatherResult {
  base: string;
  head: string;
  changedFiles: { path: string; hunks: number }[];
  excluded: { path: string; reason: "rename-only" | "generated" }[];
  sensitive: string[];
  diff: string;
  totalHunks: number;
  /** The merge base of base and head. The diff's old side is this commit. */
  mergeBase: string;
  /**
   * The description of the change: the subject and body of each commit in
   * base..head, oldest first, joined with a blank line.
   */
  description: string;
  /** Blame and log at the merge base for the changed lines, or null when none. */
  history: { text: string; truncated: boolean } | null;
}

/** Give the full sha of the commit that "rev" names. Throw when it is not a commit. */
export async function resolveCommit(repo: string, rev: string): Promise<string> {
  const sha = (
    await runGit(repo, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`"${rev}" is not a commit in ${repo}.`);
  return sha;
}

// The same options go to both diff commands, so their paths agree.
const DIFF_OPTIONS = [
  "--find-renames",
  "--no-relative",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
];

/**
 * Gather the diff of base...head. "globs" are the sensitive and generated
 * globs: the defaults with the repo config's globs added. "globs.history"
 * is true by default. When it is false, gather builds no history block.
 * A git failure in the history block gives a null history. It does not
 * stop the run, because the history is only extra context.
 */
export async function gather(
  repo: string,
  base: string,
  head: string,
  globs: { sensitive: readonly string[]; generated: readonly string[]; history?: boolean },
): Promise<GatherResult> {
  const baseSha = await resolveCommit(repo, base);
  const headSha = await resolveCommit(repo, head);
  const range = `${baseSha}...${headSha}`;
  const nameStatus = await runGit(repo, ["diff", ...DIFF_OPTIONS, "--name-status", "-z", range]);
  const patch = await runGit(repo, [
    "diff",
    ...DIFF_OPTIONS,
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--unified=3",
    range,
  ]);
  const entries = parseNameStatus(nameStatus);
  const result = applyExclusions(entries, patch, globs);
  const wantHistory = globs.history !== false;
  const mergeBase = (
    await runGit(repo, ["merge-base", "--end-of-options", baseSha, headSha])
  ).trim();

  // The old side of each kept file is at the merge base, under its old
  // path. An added file has no old side.
  const sections = diffSections(result.diff);
  const kept = new Set(result.changedFiles.map((f) => f.path));
  const hunks = entries
    .filter((e) => kept.has(e.path) && e.status !== "A")
    .map((e) => ({ path: e.oldPath ?? e.path, ranges: oldSideRanges(sections.get(e.path) ?? "") }))
    .filter((h) => h.ranges.length > 0);

  return {
    base: baseSha,
    head: headSha,
    ...result,
    mergeBase,
    description: await describeChange(repo, baseSha, headSha),
    history: wantHistory ? await tryGatherHistory(repo, mergeBase, hunks) : null,
  };
}

// The history block is extra context. A git failure gives no block.
async function tryGatherHistory(
  repo: string,
  mergeBase: string,
  hunks: Parameters<typeof gatherHistory>[2],
): Promise<GatherResult["history"]> {
  try {
    return await gatherHistory(repo, mergeBase, hunks);
  } catch {
    return null;
  }
}

/**
 * The subject and body of each commit in base..head, oldest first, each
 * trimmed, joined with one blank line.
 */
export async function describeChange(repo: string, base: string, head: string): Promise<string> {
  const out = await runGit(repo, [
    "log",
    "--reverse",
    "--no-show-signature",
    "--format=%B%x00",
    "--end-of-options",
    `${base}..${head}`,
  ]);
  return out
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "")
    .join("\n\n");
}
