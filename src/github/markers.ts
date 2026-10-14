// The hidden markers in the review bodies and comments of the tool. A
// later run reads them back, so their forms must not change.

export type RunMarker = {
  run: string;
  head: string;
  base: string;
  /** "unknown" only on a failure review that posted before the tier was decided. */
  tier: "skip" | "fast" | "full" | "unknown";
  status?: "failed";
};

const TIERS: readonly RunMarker["tier"][] = ["skip", "fast", "full", "unknown"];

/** The marker of the cleanup comment (R6). */
export const CLEANUP_MARKER = "<!-- pr-review cleanup -->";

/** `<!-- pr-review run=<id> head=<sha> base=<sha> tier=<tier>[ status=failed] -->` */
export function formatRunMarker(m: RunMarker): string {
  const status = m.status === "failed" ? " status=failed" : "";
  return `<!-- pr-review run=${m.run} head=${m.head} base=${m.base} tier=${m.tier}${status} -->`;
}

const RUN_MARKER =
  /<!-- pr-review run=(\S+) head=([0-9a-f]+) base=([0-9a-f]+)((?: [a-z_]+=\S+)*) -->/;

/**
 * Read the first run marker in "body". Give null when the body has none,
 * or when its tier is absent or not known. An unknown extra key is ignored.
 */
export function parseRunMarker(body: string): RunMarker | null {
  const match = RUN_MARKER.exec(body);
  if (!match) return null;
  const [, run, head, base, rest] = match;
  if (run === undefined || head === undefined || base === undefined) return null;
  const extra = new Map<string, string>();
  for (const pair of (rest ?? "").trim().split(" ")) {
    const at = pair.indexOf("=");
    if (at > 0) extra.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const tier = TIERS.find((t) => t === extra.get("tier"));
  if (tier === undefined) return null;
  const marker: RunMarker = { run, head, base, tier };
  if (extra.get("status") === "failed") marker.status = "failed";
  return marker;
}

/** `<!-- pr-review fp=<fingerprint> -->` */
export function formatFingerprintMarker(fp: string): string {
  return `<!-- pr-review fp=${fp} -->`;
}

const FP_MARKER = /<!-- pr-review fp=([0-9a-f]+) -->/g;

/** Read every fingerprint marker in "body", in order. */
export function parseFingerprintMarkers(body: string): string[] {
  return [...body.matchAll(FP_MARKER)].map((m) => m[1] ?? "").filter((fp) => fp !== "");
}

/** Read the first bold severity word in "body": **blocking**, **suggestion** or **nit**. */
export function parseSeverity(body: string): "blocking" | "suggestion" | "nit" | null {
  const match = /\*\*(blocking|suggestion|nit)\*\*/i.exec(body);
  return match ? (match[1]?.toLowerCase() as "blocking" | "suggestion" | "nit") : null;
}
