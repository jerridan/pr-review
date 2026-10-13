// The cap on non-blocking findings per run. Blocking findings have no cap.
import type { PostedFinding } from "../schemas/record.js";

/** 3 + ceil(hunks / 4), at most 20. */
export function nonBlockingCap(totalHunks: number): number {
  return Math.min(20, 3 + Math.ceil(Math.max(0, totalHunks) / 4));
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
