// Post a run to GitHub: the review, the check run and the cleanup comment
// (R5, R6), and the failure review (R5a).
import type { PostedGitHub, PostedFinding, RunRecord } from "../schemas/record.js";
import type { GitHubClient, Review } from "./client.js";
import {
  CLEANUP_MARKER,
  parseFingerprintMarkers,
  parseRunMarker,
  type RunMarker,
} from "./markers.js";
import type { PrContext } from "./metadata.js";
import {
  placeFindings,
  renderCheckRun,
  renderCleanupComment,
  renderFailureBody,
  renderInlineComment,
  renderReviewBody,
  renderSkipLine,
} from "./review-body.js";

/** The name of the check run. */
export const CHECK_RUN_NAME = "pr-review";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// GitHub compares logins without regard to case.
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Update the cleanup comment of the viewer, or create one when it does
 * not exist and a finding exists. Give the comment id, or null. A comment
 * with the marker from another author is ignored.
 */
async function postCleanup(
  client: GitHubClient,
  ctx: PrContext,
  findings: PostedFinding[],
): Promise<number | null> {
  const number = ctx.pr.number;
  const comments = await client.listIssueComments({ slug: ctx.slug, number });
  const own = comments.find(
    (c) => sameLogin(c.author, ctx.viewerLogin) && c.body.includes(CLEANUP_MARKER),
  );
  const body = renderCleanupComment(findings);
  if (own) {
    await client.updateIssueComment({ slug: ctx.slug, comment_id: own.id, body });
    return own.id;
  }
  if (findings.length === 0) return null;
  return (await client.createIssueComment({ slug: ctx.slug, number, body })).id;
}

/**
 * Post the review, then the check run, then the cleanup comment. When the
 * review fails, retry once with every finding in the body and no inline
 * comment. When the retry fails too, give the error and post nothing more.
 * A failed check run goes under "check_run.error". A failed later step goes
 * under "errors", and the next steps still run.
 */
export async function postRun(
  client: GitHubClient,
  input: {
    ctx: PrContext;
    record: RunRecord;
    runId: string;
    diff: string;
    carriedMarkers: string[];
    sinceHead?: string;
  },
): Promise<PostedGitHub> {
  const { ctx, record } = input;
  const { identity } = record;
  const slug = ctx.slug;
  const number = ctx.pr.number;
  const marker: RunMarker = {
    run: input.runId,
    head: identity.head,
    base: identity.base,
    tier: identity.tier,
  };
  const findings = identity.tier === "skip" ? [] : record.posted.findings;
  const placed = placeFindings(findings, input.diff);
  const bodyWith = (bodyFindings: PostedFinding[]): string =>
    renderReviewBody({
      marker,
      record,
      slug,
      bodyFindings,
      carriedMarkers: input.carriedMarkers,
      ...(input.sinceHead !== undefined ? { sinceHead: input.sinceHead } : {}),
    });

  const result: PostedGitHub = {
    review_id: null,
    review_url: null,
    error: null,
    inline: [],
    in_body: [],
    check_run: null,
    cleanup_comment_id: null,
    resolved: [],
    errors: [],
  };

  let review: { id: number; url: string };
  let inline = placed.inline;
  let inBody = placed.body;
  try {
    review = await client.createReview({
      slug,
      number,
      commit_id: identity.head,
      body: bodyWith(inBody),
      comments: inline.map(renderInlineComment),
    });
  } catch (first) {
    // An inline comment on a line that GitHub does not take fails the
    // whole call, so the retry puts every finding in the body.
    inline = [];
    inBody = findings;
    try {
      review = await client.createReview({
        slug,
        number,
        commit_id: identity.head,
        body: bodyWith(inBody),
        comments: [],
      });
    } catch (second) {
      result.error = `The review did not post: ${messageOf(first)}. The body-only retry failed too: ${messageOf(second)}`;
      return result;
    }
  }
  result.review_id = review.id;
  result.review_url = review.url;
  result.in_body = inBody.map((f) => f.fingerprint);

  // The comment ids of the inline comments come from the new review.
  if (inline.length > 0) {
    try {
      const comments = await client.listReviewComments({ slug, number });
      for (const c of comments.filter((c) => c.review_id === review.id)) {
        const [fp] = parseFingerprintMarkers(c.body);
        if (fp !== undefined) result.inline.push({ fingerprint: fp, comment_id: c.id });
      }
    } catch (err) {
      result.errors.push({ step: "list review comments", message: messageOf(err) });
    }
  }

  try {
    const run = await client.createCheckRun({
      slug,
      head_sha: identity.head,
      name: CHECK_RUN_NAME,
      ...renderCheckRun(record),
      conclusion: "neutral",
    });
    result.check_run = { id: run.id };
  } catch (err) {
    result.check_run = { error: messageOf(err) };
  }

  if (identity.config.values.pre_existing === "comment") {
    try {
      result.cleanup_comment_id = await postCleanup(client, ctx, record.stages.pre_existing);
    } catch (err) {
      result.errors.push({ step: "cleanup comment", message: messageOf(err) });
    }
  }
  return result;
}

/** Post the short failure review of R5a. It has no inline comment. */
export async function postFailure(
  client: GitHubClient,
  input: { ctx: PrContext; marker: RunMarker; stage: string; message: string },
): Promise<void> {
  await client.createReview({
    slug: input.ctx.slug,
    number: input.ctx.pr.number,
    commit_id: input.marker.head,
    body: renderFailureBody(input.marker, input.stage, input.message),
    comments: [],
  });
}

/**
 * True when the viewer already posted a skip review with this reason. A
 * failure review does not count.
 */
export function skipReviewAlreadyPosted(
  reviews: Review[],
  viewerLogin: string,
  reason: string,
): boolean {
  const line = renderSkipLine(reason);
  return reviews.some((r) => {
    if (!sameLogin(r.author, viewerLogin)) return false;
    const marker = parseRunMarker(r.body);
    if (marker?.tier !== "skip" || marker.status === "failed") return false;
    const end = r.body.indexOf("-->");
    return r.body.slice(end + 3).trim() === line;
  });
}
