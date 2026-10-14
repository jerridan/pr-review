import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { GitHubError, type Review } from "../src/github/client.js";
import { createFakeGitHubClient, type FakeGitHubClient } from "../src/github/fake.js";
import {
  CLEANUP_MARKER,
  formatFingerprintMarker,
  formatRunMarker,
  parseFingerprintMarkers,
  parseRunMarker,
  type RunMarker,
} from "../src/github/markers.js";
import type { PrContext } from "../src/github/metadata.js";
import { postFailure, postRun, skipReviewAlreadyPosted } from "../src/github/post.js";
import { renderCheckRun, renderReviewBody } from "../src/github/review-body.js";
import type { PostedFinding, RunRecord } from "../src/schemas/record.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SLUG = "acme/widgets";
const RUN_ID = "2026-10-13T120000.000Z-aaaaaaa";

function finding(
  start: number,
  end: number,
  fp: string,
  overrides: Partial<PostedFinding> = {},
): PostedFinding {
  return {
    file: "src/a.ts",
    start_line: start,
    end_line: end,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: `CLAIM-${fp}`,
    evidence: "x",
    explanation: "e",
    needs_context: false,
    fingerprint: fp.repeat(16).slice(0, 16),
    severity: "blocking",
    score: 90,
    span_text: "x",
    verifier: {
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: ["x"],
      rationale: "r",
      score: 90,
      severity: "blocking",
    },
    ...overrides,
  };
}

const INLINE_A = finding(6, 6, "a");
const INLINE_B = finding(8, 9, "b");
const OUTSIDE = finding(1, 1, "c");
const PRE = finding(2, 2, "d", { severity: "suggestion" });

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -5,3 +5,6 @@",
  " l5",
  " l6",
  " l7",
  "+l8",
  "+l9",
  "+l10",
  "",
].join("\n");

function makeRecord(
  options: {
    findings?: PostedFinding[];
    preExisting?: PostedFinding[];
    mode?: "off" | "comment";
    tier?: RunRecord["identity"]["tier"];
    runKind?: RunRecord["identity"]["run_kind"];
  } = {},
): RunRecord {
  return {
    identity: {
      repo: "/repo",
      pr: 7,
      github: null,
      run_kind: options.runKind ?? "first",
      prior: null,
      base: BASE,
      head: HEAD,
      started_at: "2026-10-13T12:00:00.000Z",
      tool_version: "0.1.0",
      config_hash: null,
      config: {
        files: [],
        values: { ...DEFAULT_REPO_CONFIG, pre_existing: options.mode ?? "off" },
        custom_reviewers: [],
      },
      description: "d",
      description_meta: { source: "pr", sanitized: false, truncated: false },
      history: { built: false, truncated: false },
      injected: [],
      changed_files: [],
      excluded_files: [],
      sensitive_files: [],
      triage: null,
      tier: options.tier ?? "full",
      tier_reason: "Reason.",
      selected_reviewers: [],
      models: {} as RunRecord["identity"]["models"],
    },
    stages: {
      reviewers: [],
      verifications: [],
      merges: [],
      capped: [],
      suppressed: [],
      pre_existing: options.preExisting ?? [],
    },
    posted: {
      verdict: "would request changes",
      coverage: {
        reviewers_ran: ["diff-bugs"],
        reviewers_failed: [],
        reviewers_skipped: [],
        reviewers_without_bash: [],
        sensitive_without_hunks: [],
        findings_dropped_by_failed_verifier: 0,
      },
      findings: options.findings ?? [INLINE_A, INLINE_B, OUTSIDE],
      github: null,
      below_floor: [],
      not_reposted: [],
      carried: [],
    },
    cost: { queries: [], total_cost_usd: 0, queries_without_cost: 0, stage_ms: {}, errors: [] },
  };
}

function setup(): { gh: FakeGitHubClient; ctx: PrContext } {
  const gh = createFakeGitHubClient({
    number: 7,
    head_sha: HEAD,
    base_sha: BASE,
    url: `https://github.com/${SLUG}/pull/7`,
    viewer_login: "bot[bot]",
  });
  return {
    gh,
    ctx: { pr: gh.state.pr, slug: SLUG, authorWriteAccess: true, viewerLogin: "bot[bot]" },
  };
}

function post(gh: FakeGitHubClient, ctx: PrContext, record: RunRecord = makeRecord()) {
  return postRun(gh, { ctx, record, runId: RUN_ID, diff: DIFF, carriedMarkers: [] });
}

const boom = (endpoint: string) =>
  new GitHubError({ endpoint, exitCode: 1, message: `gh api ${endpoint} failed: boom` });

describe("postRun: the review (R5)", () => {
  it("posts one COMMENT review on the head, with inline comments and a body", async () => {
    const { gh, ctx } = setup();
    const record = makeRecord();
    const out = await post(gh, ctx, record);

    const creates = gh.calls.filter((c) => c.method === "createReview");
    expect(creates).toHaveLength(1);
    const input = creates[0]?.input as { commit_id: string; body: string; comments: unknown[] };
    expect(input.commit_id).toBe(HEAD);
    expect(gh.state.reviews).toHaveLength(1);
    const marker: RunMarker = { run: RUN_ID, head: HEAD, base: BASE, tier: "full" };
    expect(input.body).toBe(
      renderReviewBody({ marker, record, slug: SLUG, bodyFindings: [OUTSIDE], carriedMarkers: [] }),
    );
    expect(parseRunMarker(input.body)).toEqual(marker);
    expect(input.comments).toHaveLength(2);

    const comments = gh.state.review_comments;
    expect(comments.map((c) => parseFingerprintMarkers(c.body))).toEqual([
      [INLINE_A.fingerprint],
      [INLINE_B.fingerprint],
    ]);
    expect(out).toEqual({
      review_id: gh.state.reviews[0]?.id,
      review_url: gh.state.reviews[0]?.url,
      error: null,
      inline: [
        { fingerprint: INLINE_A.fingerprint, comment_id: comments[0]?.id },
        { fingerprint: INLINE_B.fingerprint, comment_id: comments[1]?.id },
      ],
      in_body: [OUTSIDE.fingerprint],
      check_run: { id: gh.state.check_runs[0]?.id },
      cleanup_comment_id: null,
      resolved: [],
      errors: [],
    });
  });

  it("passes carried markers and the earlier head to the body", async () => {
    const { gh, ctx } = setup();
    const carried = formatFingerprintMarker("eeeeeeeeeeeeeeee");
    await postRun(gh, {
      ctx,
      record: makeRecord(),
      runId: RUN_ID,
      diff: DIFF,
      carriedMarkers: [carried],
      sinceHead: "c".repeat(40),
    });
    const body = gh.state.reviews[0]?.body ?? "";
    expect(body).toContain(carried);
    expect(body).toContain("Review of changes since ccccccc");
  });

  it("retries once with every finding in the body and no inline comment", async () => {
    const { gh, ctx } = setup();
    gh.failNext("createReview", boom("repos/acme/widgets/pulls/7/reviews"));
    const out = await post(gh, ctx);
    const creates = gh.calls.filter((c) => c.method === "createReview");
    expect(creates).toHaveLength(2);
    const retry = creates[1]?.input as { body: string; comments: unknown[] };
    expect(retry.comments).toEqual([]);
    expect(parseFingerprintMarkers(retry.body)).toEqual([
      INLINE_A.fingerprint,
      INLINE_B.fingerprint,
      OUTSIDE.fingerprint,
    ]);
    expect(out.review_id).toBe(gh.state.reviews[0]?.id);
    expect(out.error).toBeNull();
    expect(out.inline).toEqual([]);
    expect(out.in_body).toEqual([INLINE_A.fingerprint, INLINE_B.fingerprint, OUTSIDE.fingerprint]);
    expect(gh.state.check_runs).toHaveLength(1);
  });

  it("records the error, and posts no check run and no cleanup comment, when both calls fail", async () => {
    const { gh, ctx } = setup();
    gh.failNext("createReview", boom("repos/acme/widgets/pulls/7/reviews"));
    gh.failNext("createReview", boom("repos/acme/widgets/pulls/7/reviews"));
    const out = await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [PRE] }));
    expect(out.review_id).toBeNull();
    expect(out.review_url).toBeNull();
    expect(out.error).toContain("boom");
    expect(out.check_run).toBeNull();
    expect(out.cleanup_comment_id).toBeNull();
    expect(gh.state.reviews).toEqual([]);
    expect(gh.calls.map((c) => c.method)).not.toContain("createCheckRun");
    expect(gh.calls.map((c) => c.method)).not.toContain("createIssueComment");
  });
});

describe("postRun: the check run (R6)", () => {
  it("creates the check run pr-review on the head, neutral, with the rendered text", async () => {
    const { gh, ctx } = setup();
    const record = makeRecord();
    await post(gh, ctx, record);
    expect(gh.state.check_runs).toEqual([
      {
        id: expect.any(Number),
        head_sha: HEAD,
        name: "pr-review",
        conclusion: "neutral",
        ...renderCheckRun(record),
      },
    ]);
  });

  it("records a check run error under check_run.error only, and still posts the rest", async () => {
    const { gh, ctx } = setup();
    gh.failNext("createCheckRun", boom("repos/acme/widgets/check-runs"));
    const out = await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [PRE] }));
    expect(out.review_id).not.toBeNull();
    expect(out.check_run).toEqual({ error: expect.stringContaining("boom") });
    expect(out.errors).toEqual([]);
    expect(out.cleanup_comment_id).not.toBeNull();
  });
});

describe("postRun: the cleanup comment (R6)", () => {
  it("creates one comment on the first run and updates it on the second", async () => {
    const { gh, ctx } = setup();
    const first = await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [PRE] }));
    expect(gh.state.issue_comments).toHaveLength(1);
    const comment = gh.state.issue_comments[0];
    expect(comment?.body).toContain(CLEANUP_MARKER);
    expect(comment?.body).toContain("Cleanup opportunities");
    expect(comment?.body).toContain(PRE.claim);
    expect(first.cleanup_comment_id).toBe(comment?.id);

    const other = finding(3, 3, "f", { severity: "nit" });
    const second = await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [other] }));
    expect(gh.state.issue_comments).toHaveLength(1);
    expect(gh.state.issue_comments[0]?.body).toContain(other.claim);
    expect(gh.state.issue_comments[0]?.body).not.toContain(PRE.claim);
    expect(second.cleanup_comment_id).toBe(comment?.id);
    expect(gh.calls.filter((c) => c.method === "updateIssueComment")).toHaveLength(1);
  });

  it("ignores a comment with the marker from another author", async () => {
    const { gh, ctx } = setup();
    gh.state.issue_comments.push({ id: 5, body: `${CLEANUP_MARKER}\nfake`, author: "mallory" });
    const out = await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [PRE] }));
    expect(gh.state.issue_comments).toHaveLength(2);
    expect(gh.state.issue_comments[0]?.body).toBe(`${CLEANUP_MARKER}\nfake`);
    expect(out.cleanup_comment_id).toBe(gh.state.issue_comments[1]?.id);
    expect(gh.calls.map((c) => c.method)).not.toContain("updateIssueComment");
  });

  it("posts no comment with pre_existing: off", async () => {
    const { gh, ctx } = setup();
    const out = await post(gh, ctx, makeRecord({ mode: "off", preExisting: [PRE] }));
    expect(gh.state.issue_comments).toEqual([]);
    expect(out.cleanup_comment_id).toBeNull();
    const methods = gh.calls.map((c) => c.method);
    expect(methods).not.toContain("createIssueComment");
    expect(methods).not.toContain("listIssueComments");
  });

  it("posts no comment when no pre-existing finding exists and no comment exists", async () => {
    const { gh, ctx } = setup();
    await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [] }));
    expect(gh.state.issue_comments).toEqual([]);
  });

  it("does not create or update the comment on a later run (R7)", async () => {
    // A later run holds only the pre-existing findings near its new hunks,
    // so it must not replace the comment of the first run.
    const { gh, ctx } = setup();
    await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [PRE] }));
    const before = gh.state.issue_comments[0]?.body;
    expect(before).toContain(PRE.claim);
    const callsBefore = gh.calls.length;

    const later = makeRecord({ mode: "comment", preExisting: [], runKind: "later" });
    const out = await post(gh, ctx, later);
    expect(out.review_id).not.toBeNull();
    expect(out.cleanup_comment_id).toBeNull();
    expect(gh.state.issue_comments).toHaveLength(1);
    expect(gh.state.issue_comments[0]?.body).toBe(before);
    const methods = gh.calls.slice(callsBefore).map((c) => c.method);
    expect(methods).not.toContain("listIssueComments");
    expect(methods).not.toContain("updateIssueComment");
    expect(methods).not.toContain("createIssueComment");

    // With no comment yet, a later run does not create one.
    const fresh = setup();
    const other = finding(3, 3, "f", { severity: "nit" });
    await post(
      fresh.gh,
      fresh.ctx,
      makeRecord({ mode: "comment", preExisting: [other], runKind: "later" }),
    );
    expect(fresh.gh.state.issue_comments).toEqual([]);
  });

  it("records a failed cleanup comment under errors, and exits the step", async () => {
    const { gh, ctx } = setup();
    gh.failNext("createIssueComment", boom("repos/acme/widgets/issues/7/comments"));
    const out = await post(gh, ctx, makeRecord({ mode: "comment", preExisting: [PRE] }));
    expect(out.errors).toEqual([
      { step: "cleanup comment", message: expect.stringContaining("boom") },
    ]);
    expect(out.cleanup_comment_id).toBeNull();
    expect(out.review_id).not.toBeNull();
    expect(out.check_run).toEqual({ id: expect.any(Number) });
  });
});

describe("postFailure (R5a)", () => {
  it("posts one short COMMENT review with the failed marker and no inline comment", async () => {
    const { gh, ctx } = setup();
    const marker: RunMarker = {
      run: RUN_ID,
      head: HEAD,
      base: BASE,
      tier: "unknown",
      status: "failed",
    };
    await postFailure(gh, { ctx, marker, stage: "find_verify", message: "boom" });
    expect(gh.state.reviews).toHaveLength(1);
    const input = gh.calls.find((c) => c.method === "createReview")?.input as {
      commit_id: string;
      body: string;
      comments: unknown[];
    };
    expect(input.commit_id).toBe(HEAD);
    expect(input.comments).toEqual([]);
    expect(input.body).toBe(`${formatRunMarker(marker)}\npr-review failed at find_verify: boom`);
    expect(gh.state.check_runs).toEqual([]);
    expect(gh.state.issue_comments).toEqual([]);
  });
});

describe("skipReviewAlreadyPosted (R5)", () => {
  function review(body: string, author = "bot[bot]"): Review {
    return { id: 1, body, author, commit_id: HEAD, url: "u" };
  }
  const skipBody = (reason: string, extra: Partial<RunMarker> = {}) =>
    renderReviewBody({
      marker: { run: "r", head: HEAD, base: BASE, tier: "skip", ...extra },
      record: {
        ...makeRecord({ tier: "skip" }),
        identity: { ...makeRecord().identity, tier: "skip", tier_reason: reason },
      },
      slug: SLUG,
      bodyFindings: [],
      carriedMarkers: [],
    });

  it("is true for a skip review of the viewer with the same reason", () => {
    expect(skipReviewAlreadyPosted([review(skipBody("Draft."))], "bot[bot]", "Draft.")).toBe(true);
  });

  it("is false for another reason, another author, a failed review or another tier", () => {
    expect(skipReviewAlreadyPosted([review(skipBody("Draft."))], "bot[bot]", "Label.")).toBe(false);
    expect(skipReviewAlreadyPosted([review(skipBody("Draft."), "eve")], "bot[bot]", "Draft.")).toBe(
      false,
    );
    expect(
      skipReviewAlreadyPosted(
        [review(skipBody("Draft.", { status: "failed" }))],
        "bot[bot]",
        "Draft.",
      ),
    ).toBe(false);
    expect(
      skipReviewAlreadyPosted([review(skipBody("Draft.", { tier: "full" }))], "bot[bot]", "Draft."),
    ).toBe(false);
    expect(skipReviewAlreadyPosted([], "bot[bot]", "Draft.")).toBe(false);
  });
});
