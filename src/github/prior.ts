// The prior state of a later run (R7). GitHub gives the posted fingerprints
// and the thread state. The previous record gives the last reviewed head
// and the full finding of each open fingerprint. With no record, the newest
// review marker gives the head.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RecordSchema, type PostedFinding, type RunRecord } from "../schemas/record.js";
import type { GitHubClient, Review } from "./client.js";
import { parseFingerprintMarkers, parseRunMarker, parseSeverity } from "./markers.js";
import type { PrContext } from "./metadata.js";

type Severity = "blocking" | "suggestion" | "nit";

/** An open fingerprint of an earlier run. */
export type PriorOpen = {
  /** The full finding from the prior record, or null with the marker source. */
  finding: PostedFinding | null;
  /** The review thread of an inline comment, or null for a body finding. */
  thread_id: string | null;
  /** The id of the inline comment, or null for a body finding. */
  comment_id: number | null;
  severity: Severity;
};

export type PriorState = {
  /** The last reviewed head, H0. */
  head: string;
  source: "record" | "marker";
  /** The path of the prior record, or null. */
  record: string | null;
  /** The triage tier of the prior record. Null with the marker source. */
  triageTier: "skip" | "fast" | "full" | null;
  open: Map<string, PriorOpen>;
  dismissed: Set<string>;
};

/** The first words of the reply with which the tool resolves a thread. */
export const RESOLVED_REPLY_PREFIX = "Resolved by pr-review";

// GitHub compares logins without regard to case.
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Find the newest record in "<outDir>/pr-<pr>/" that posted a review with
 * no error, whose tier is not skip, and whose slug and pr match. A file
 * that does not parse as a record is ignored.
 */
export async function findPriorRecord(
  outDir: string,
  input: { slug: string; pr: number },
): Promise<{ path: string; record: RunRecord } | null> {
  const dir = join(outDir, `pr-${input.pr}`);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  // The file names start with the time of the run, so the newest sorts last.
  const candidates = names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse();
  for (const name of candidates) {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const checked = RecordSchema.safeParse(parsed);
    if (!checked.success) continue;
    const record = checked.data;
    const github = record.posted.github;
    if (github === null || github.error !== null) continue;
    if (record.identity.tier === "skip") continue;
    if (record.identity.pr !== input.pr || record.identity.github?.slug !== input.slug) continue;
    return { path, record };
  }
  return null;
}

// The severity of a body entry: the bold word on the newest line of a tool
// review that holds the marker of the fingerprint.
function bodySeverity(reviews: Review[], fp: string): Severity | null {
  for (const review of [...reviews].reverse()) {
    for (const line of review.body.split("\n")) {
      if (!line.includes(`fp=${fp} `)) continue;
      const severity = parseSeverity(line);
      if (severity !== null) return severity;
    }
  }
  return null;
}

/**
 * Read the prior state of the pull request. Give null when the pull request
 * holds no review of the tool, apart from skip and failure reviews: the run
 * is then a first run.
 */
export async function loadPriorState(
  client: GitHubClient,
  input: { ctx: PrContext; outDir: string },
): Promise<PriorState | null> {
  const { ctx } = input;
  const slug = ctx.slug;
  const number = ctx.pr.number;
  // Read markers only from reviews of the tool's own login.
  const own = (await client.listReviews({ slug, number })).filter((r) =>
    sameLogin(r.author, ctx.viewerLogin),
  );
  const reviewed = own.filter((r) => {
    const marker = parseRunMarker(r.body);
    return marker !== null && marker.tier !== "skip" && marker.status !== "failed";
  });
  const newest = reviewed.at(-1);
  if (newest === undefined) return null;

  const found = await findPriorRecord(input.outDir, { slug, pr: number });
  const findings = new Map<string, PostedFinding>();
  if (found) {
    for (const f of [...found.record.posted.findings, ...found.record.posted.carried]) {
      findings.set(f.fingerprint, f);
    }
  }
  const state: PriorState = {
    head: found ? found.record.identity.head : (parseRunMarker(newest.body)?.head ?? ""),
    source: found ? "record" : "marker",
    record: found ? found.path : null,
    triageTier: found ? (found.record.identity.triage?.tier ?? null) : null,
    open: new Map(),
    dismissed: new Set(),
  };

  // Inline comments: the thread state and the reactions decide each one.
  const comments = (await client.listReviewComments({ slug, number })).filter((c) =>
    sameLogin(c.author, ctx.viewerLogin),
  );
  const threads = new Map<string, Awaited<ReturnType<GitHubClient["getThread"]>>>();
  for (const comment of comments) {
    const [fp] = parseFingerprintMarkers(comment.body);
    if (fp === undefined) continue;
    const reactions = await client.listReactions({ slug, comment_id: comment.id });
    if (reactions.some((r) => r.content === "-1")) {
      state.dismissed.add(fp);
      continue;
    }
    let thread = threads.get(comment.thread_id);
    if (thread === undefined) {
      thread = await client.getThread({ thread_id: comment.thread_id });
      threads.set(comment.thread_id, thread);
    }
    if (thread.resolved) {
      // A thread that the tool resolved with its reply is neither open nor
      // dismissed. A thread that someone else resolved is dismissed.
      const last = thread.comments.at(-1);
      const byTool =
        last !== undefined &&
        sameLogin(last.author, ctx.viewerLogin) &&
        last.body.startsWith(RESOLVED_REPLY_PREFIX);
      if (!byTool) state.dismissed.add(fp);
      continue;
    }
    const finding = findings.get(fp) ?? null;
    state.open.set(fp, {
      finding,
      thread_id: comment.thread_id,
      comment_id: comment.id,
      severity: finding?.severity ?? parseSeverity(comment.body) ?? "blocking",
    });
  }

  // Body findings: each marker in the newest review body is open. It has
  // no thread, so only its span text can close it later.
  for (const fp of parseFingerprintMarkers(newest.body)) {
    if (state.open.has(fp) || state.dismissed.has(fp)) continue;
    const finding = findings.get(fp) ?? null;
    state.open.set(fp, {
      finding,
      thread_id: null,
      comment_id: null,
      severity: finding?.severity ?? bodySeverity(own, fp) ?? "blocking",
    });
  }
  return state;
}
