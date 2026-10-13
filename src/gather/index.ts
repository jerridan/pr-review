// Gather: the three-dot diff between two commits, with rename detection,
// the changed files with their hunk counts, and the exclusions.
import { parseNameStatus } from "./diff.js";
import { applyExclusions } from "./exclusions.js";
import { runGit } from "./worktree.js";

export interface GatherResult {
  base: string;
  head: string;
  changedFiles: { path: string; hunks: number }[];
  excluded: { path: string; reason: "rename-only" | "generated" }[];
  sensitive: string[];
  diff: string;
  totalHunks: number;
}

async function resolveCommit(repo: string, rev: string): Promise<string> {
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

export async function gather(repo: string, base: string, head: string): Promise<GatherResult> {
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
  const result = applyExclusions(parseNameStatus(nameStatus), patch);
  return { base: baseSha, head: headSha, ...result };
}
