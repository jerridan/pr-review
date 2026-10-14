// Apply the gather exclusions. A rename with no content change leaves the
// run. A generated or lock file leaves the diff and the hunk counts. A
// sensitive file only gets a flag.
import { DEFAULT_GLOBS, matchesAny, type GatherGlobs } from "../config/globs.js";
import { countHunks, filterDiff, type NameStatusEntry } from "./diff.js";
import type { GatherResult } from "./index.js";

export function applyExclusions(
  files: NameStatusEntry[],
  diff: string,
  globs: GatherGlobs = DEFAULT_GLOBS,
): Pick<GatherResult, "changedFiles" | "excluded" | "sensitive" | "diff" | "totalHunks"> {
  const excluded: GatherResult["excluded"] = [];
  const kept: NameStatusEntry[] = [];
  for (const file of files) {
    if (file.status === "R" && file.similarity === 100) {
      excluded.push({ path: file.path, reason: "rename-only" });
    } else if (matchesAny(file.path, globs.generated)) {
      excluded.push({ path: file.path, reason: "generated" });
    } else {
      kept.push(file);
    }
  }

  // Remove the sections of excluded files only. A section that the
  // name-status list does not name stays in the diff, so no change is lost.
  const excludedPaths = new Set(excluded.map((e) => e.path));
  const filtered = filterDiff(diff, (path) => !excludedPaths.has(path));
  const hunks = countHunks(filtered);

  const changedFiles = kept.map((file) => ({ path: file.path, hunks: hunks.get(file.path) ?? 0 }));
  const sensitive = kept
    .filter(
      (file) =>
        matchesAny(file.path, globs.sensitive) ||
        (file.oldPath !== undefined && matchesAny(file.oldPath, globs.sensitive)),
    )
    .map((file) => file.path);
  const totalHunks = changedFiles.reduce((sum, file) => sum + file.hunks, 0);

  return { changedFiles, excluded, sensitive, diff: filtered, totalHunks };
}
