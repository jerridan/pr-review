// Read files from the git objects of one commit. The run reads its config
// this way, so a file in the working tree or the head checkout never counts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The same git settings as runGit in worktree.ts: no hooks, no quoted
// paths, no colour. Paths are literal, not patterns.
const GIT_CONFIG = [
  "--literal-pathspecs",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=never",
];

// These variables point git at another repo, so remove them.
const GIT_REDIRECT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];

// A regular file. A symlink (120000) or a submodule (160000) is not a file
// that the run reads.
const FILE_MODES = new Set(["100644", "100755"]);

async function gitBytes(repo: string, args: string[]): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_REDIRECT_VARS) delete env[name];
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...GIT_CONFIG, ...args], {
      env,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString("utf8").trim();
    const reason = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`git ${args.join(" ")} failed: ${reason}`, { cause: err });
  }
}

type TreeEntry = { mode: string; type: string; oid: string; path: string };

// Parse "git ls-tree -z" output: "<mode> <type> <oid>\t<path>\0" per entry.
function parseTree(out: Buffer): TreeEntry[] {
  return out
    .toString("utf8")
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", oid = ""] = line.slice(0, tab).split(" ");
      return { mode, type, oid, path: line.slice(tab + 1) };
    });
}

function isFile(entry: TreeEntry): boolean {
  return entry.type === "blob" && FILE_MODES.has(entry.mode);
}

/**
 * Give the bytes of the file at "path" in "commit", or null when the
 * commit has no regular file at that path.
 */
export async function readBlobBytesAt(
  repo: string,
  commit: string,
  path: string,
): Promise<Buffer | null> {
  const entries = parseTree(
    await gitBytes(repo, ["ls-tree", "-z", "--full-tree", `${commit}^{commit}`, "--", path]),
  );
  const entry = entries.find((e) => e.path === path);
  if (!entry || !isFile(entry)) return null;
  return gitBytes(repo, ["cat-file", "blob", entry.oid]);
}

/**
 * Give the git mode of the entry at "path" in "commit" (for example
 * "100644", "120000" for a symlink or "160000" for a submodule), or null
 * when the commit has no entry at that path. The loader uses it to tell an
 * absent file from an entry that is not a regular file.
 */
export async function readEntryModeAt(
  repo: string,
  commit: string,
  path: string,
): Promise<string | null> {
  const entries = parseTree(
    await gitBytes(repo, ["ls-tree", "-z", "--full-tree", `${commit}^{commit}`, "--", path]),
  );
  return entries.find((e) => e.path === path)?.mode ?? null;
}

/**
 * Give the target path that the symlink at "path" in "commit" holds, or
 * null when the entry is absent or is not a symlink. A symlink is a blob
 * whose content is the target path. The function does not follow the link.
 */
export async function readSymlinkTargetAt(
  repo: string,
  commit: string,
  path: string,
): Promise<string | null> {
  const entries = parseTree(
    await gitBytes(repo, ["ls-tree", "-z", "--full-tree", `${commit}^{commit}`, "--", path]),
  );
  const entry = entries.find((e) => e.path === path);
  if (!entry || entry.type !== "blob" || entry.mode !== "120000") return null;
  return (await gitBytes(repo, ["cat-file", "blob", entry.oid])).toString("utf8");
}

/**
 * Give the text of the file at "path" in "commit", or null when the
 * commit has no regular file at that path.
 */
export async function readBlobAt(
  repo: string,
  commit: string,
  path: string,
): Promise<string | null> {
  const bytes = await readBlobBytesAt(repo, commit, path);
  return bytes === null ? null : bytes.toString("utf8");
}

/**
 * List the paths of the entries that are not directories, directly in the
 * directory "dir" of "commit", in git's order. A regular file, a symlink
 * and a submodule all count, so the caller can reject the last two. Give an
 * empty list when the directory is absent.
 */
export async function listFilesAt(repo: string, commit: string, dir: string): Promise<string[]> {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const entries = parseTree(
    await gitBytes(repo, ["ls-tree", "-z", "--full-tree", `${commit}^{commit}`, "--", prefix]),
  );
  return entries
    .filter(
      (e) =>
        e.type !== "tree" &&
        e.path.startsWith(prefix) &&
        !e.path.slice(prefix.length).includes("/"),
    )
    .map((e) => e.path);
}
