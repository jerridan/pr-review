// The cap on non-blocking findings per run. Blocking findings have no cap.
import type { RepoConfig } from "../config/repo-config.js";
import type { PostedFinding } from "../schemas/record.js";

export type CapConfig = RepoConfig["caps"];

/** The cap keys of a repo with no config. */
export const DEFAULT_CAPS: CapConfig = {
  non_blocking_base: 3,
  non_blocking_per_hunks: 4,
  non_blocking_max: 20,
};

/**
 * base + ceil(hunks / per_hunks), at most max. The defaults give
 * 3 + ceil(hunks / 4), at most 20.
 */
export function nonBlockingCap(totalHunks: number, caps: CapConfig = DEFAULT_CAPS): number {
  const perHunks = Math.max(1, caps.non_blocking_per_hunks);
  return Math.min(
    caps.non_blocking_max,
    caps.non_blocking_base + Math.ceil(Math.max(0, totalHunks) / perHunks),
  );
}

/**
 * Post every blocking finding. Fill the cap with suggestions first, then
 * nits, each in ranked order. The rest go to "capped".
 */
export function applyCap(
  ranked: PostedFinding[],
  cap: number,
): { posted: PostedFinding[]; capped: PostedFinding[] } {
  const blocking = ranked.filter((p) => p.severity === "blocking");
  const nonBlocking = [
    ...ranked.filter((p) => p.severity === "suggestion"),
    ...ranked.filter((p) => p.severity === "nit"),
  ];
  const room = Math.max(0, cap);
  return {
    posted: [...blocking, ...nonBlocking.slice(0, room)],
    capped: nonBlocking.slice(room),
  };
}
