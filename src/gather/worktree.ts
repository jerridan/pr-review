// Run git, and give each stage a detached checkout of the head commit.
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Git settings for every command: no hooks run, paths are not quoted, and
// no colour or pager is used.
const GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=never",
];

// These variables point git at another repo, so remove them.
const GIT_REDIRECT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];

/** Run one git command in "repo" and return its stdout. */
export async function runGit(repo: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_REDIRECT_VARS) delete env[name];
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...GIT_CONFIG, ...args], {
      env,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const reason = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`git ${args.join(" ")} failed: ${reason}`, { cause: err });
  }
}

/**
 * Make a detached worktree of "head" in a new temporary directory, run
 * "fn" with its path, and remove the worktree after, also when "fn" throws.
 */
export async function withHeadWorktree<T>(
  repo: string,
  head: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pr-review-head-")));
  const path = join(root, "head");
  try {
    await runGit(repo, ["worktree", "add", "--detach", "--quiet", path, `${head}^{commit}`]);
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
  try {
    return await fn(path);
  } finally {
    // A cleanup error must not hide the error from "fn".
    await runGit(repo, ["worktree", "remove", "--force", path]).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await runGit(repo, ["worktree", "prune"]).catch(() => undefined);
  }
}
