import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { GitHubError } from "../src/github/client.js";
import { createFakeGitHubClient, type FakeGitHubClient } from "../src/github/fake.js";
import { formatFingerprintMarker, formatRunMarker, type RunMarker } from "../src/github/markers.js";
import type { PrContext } from "../src/github/metadata.js";
import { reverify, resolveStaleThreads } from "../src/github/post.js";
import { findPriorRecord, loadPriorState, type PriorState } from "../src/github/prior.js";
import { RecordSchema, type PostedFinding, type RunRecord } from "../src/schemas/record.js";

const SLUG = "acme/widgets";
const VIEWER = "bot[bot]";
const H0 = "a".repeat(40);
const OLDER = "c".repeat(40);
const BASE = "b".repeat(40);

const root = mkdtempSync(join(tmpdir(), "pr-review-prior-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirCount = 0;
const newOutDir = () => join(root, `out-${++dirCount}`);

function finding(fp: string, start: number, severity: PostedFinding["severity"], span: string) {
  const f: PostedFinding = {
    file: "src/a.ts",
    start_line: start,
    end_line: start,
    category: "bug",
    severity_estimate: severity,
    confidence: "high",
    claim: `CLAIM-${fp}`,
    evidence: span,
    explanation: "e",
    needs_context: false,
    fingerprint: fp.repeat(16).slice(0, 16),
    severity,
    score: 90,
    verifier: {
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: [span],
      rationale: "r",
      score: 90,
      severity,
    },
    span_text: span,
  };
  return f;
}

const F_OPEN = finding("1", 1, "blocking", "const one = 1;");
const F_DOWN = finding("2", 2, "suggestion", "const two = 2;");
const F_HUMAN = finding("3", 3, "nit", "const three = 3;");
const F_TOOL = finding("4", 4, "blocking", "const four = 4;");
const F_BODY = finding("5", 5, "suggestion", "const five = 5;");

function makeRecord(
  options: {
    head?: string;
    pr?: number;
    slug?: string;
    tier?: RunRecord["identity"]["tier"];
    github?: RunRecord["posted"]["github"];
    triageTier?: "skip" | "fast" | "full";
    startedAt?: string;
  } = {},
): RunRecord {
  const record: RunRecord = {
    identity: {
      repo: "/repo",
      pr: options.pr ?? 7,
      github: {
        slug: options.slug ?? SLUG,
        title: "t",
        draft: false,
        labels: [],
        author: "alice",
        author_type: "User",
        author_write_access: true,
        fork: false,
        head_repo: SLUG,
        url: `https://github.com/${SLUG}/pull/7`,
      },
      run_kind: "first",
      prior: null,
      base: BASE,
      head: options.head ?? H0,
      started_at: options.startedAt ?? "2026-10-13T12:00:00.000Z",
      tool_version: "0.1.0",
      config_hash: null,
      config: { files: [], values: DEFAULT_REPO_CONFIG, custom_reviewers: [] },
      description: "d",
      description_meta: { source: "pr", sanitized: false, truncated: false },
      history: { built: false, truncated: false },
      injected: [],
      changed_files: [],
      excluded_files: [],
      sensitive_files: [],
      triage: {
        tier: options.triageTier ?? "fast",
        reason: "r",
        confidence: "high",
        categories: [],
        hotspots: [],
        file_notes: [],
        summary: "s",
      },
      tier: options.tier ?? "full",
      tier_reason: "r",
      selected_reviewers: [],
      models: {
        triage: { model: "claude-sonnet-5-5", effort: "medium" },
        reviewer: { model: "claude-opus-5-5", effort: "low" },
        verifier: { model: "claude-sonnet-5-5", effort: "high" },
        "verifier-escalation": { model: "claude-opus-5-5", effort: "high" },
        merge: { model: "claude-sonnet-5-5", effort: "medium" },
        smoke: { model: "claude-sonnet-5-5", effort: "low" },
      },
    },
    stages: {
      reviewers: [],
      verifications: [],
      merges: [],
      capped: [],
      suppressed: [],
      pre_existing: [],
    },
    posted: {
      verdict: "would request changes",
      coverage: {
        reviewers_ran: [],
        reviewers_failed: [],
        reviewers_skipped: [],
        reviewers_without_bash: [],
        sensitive_without_hunks: [],
        findings_dropped_by_failed_verifier: 0,
      },
      findings: [F_OPEN, F_DOWN, F_HUMAN, F_TOOL],
      github:
        options.github === undefined
          ? {
              review_id: 1,
              review_url: "u",
              error: null,
              inline: [],
              in_body: [],
              check_run: null,
              cleanup_comment_id: null,
              resolved: [],
              errors: [],
            }
          : options.github,
      below_floor: [],
      not_reposted: [],
      carried: [F_BODY],
    },
    cost: { queries: [], total_cost_usd: 0, queries_without_cost: 0, stage_ms: {}, errors: [] },
  };
  expect(RecordSchema.safeParse(record).error).toBeUndefined();
  return record;
}

function writeRecordFile(outDir: string, name: string, record: RunRecord | string): string {
  const dir = join(outDir, "pr-7");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, typeof record === "string" ? record : JSON.stringify(record));
  return path;
}

function setup(): { gh: FakeGitHubClient; ctx: PrContext } {
  const gh = createFakeGitHubClient({
    number: 7,
    url: `https://github.com/${SLUG}/pull/7`,
    viewer_login: VIEWER,
  });
  return { gh, ctx: { pr: gh.state.pr, slug: SLUG, authorWriteAccess: true, viewerLogin: VIEWER } };
}

const marker = (head: string, extra: Partial<RunMarker> = {}): string =>
  formatRunMarker({ run: `run-${head.slice(0, 3)}`, head, base: BASE, tier: "full", ...extra });

const inline = (f: PostedFinding) => ({
  path: f.file,
  line: f.start_line,
  side: "RIGHT" as const,
  body: `**${f.severity}** Bug: ${f.claim}\n\n${formatFingerprintMarker(f.fingerprint)}`,
});

/**
 * Post a tool review at H0 with four inline comments and one body entry.
 * Then a human gives F_DOWN a thumbs-down, a human resolves the thread of
 * F_HUMAN, and the tool resolves the thread of F_TOOL with its reply.
 */
async function postedState(gh: FakeGitHubClient) {
  await gh.createReview({
    slug: SLUG,
    number: 7,
    commit_id: OLDER,
    body: `${marker(OLDER)} older review`,
    comments: [],
  });
  await gh.createReview({
    slug: SLUG,
    number: 7,
    commit_id: H0,
    body: [
      `${marker(H0)} **Would request changes** at tier full: r`,
      `- **suggestion** Bug: ${F_BODY.claim} ${formatFingerprintMarker(F_BODY.fingerprint)}`,
    ].join("\n"),
    comments: [F_OPEN, F_DOWN, F_HUMAN, F_TOOL].map(inline),
  });
  const comments = await gh.listReviewComments({ slug: SLUG, number: 7 });
  const byFp = (f: PostedFinding) => comments.find((c) => c.body.includes(f.fingerprint))!;
  gh.react(byFp(F_DOWN).id, "-1", "alice");
  gh.resolveThreadAsHuman(byFp(F_HUMAN).thread_id);
  await gh.replyToComment({
    slug: SLUG,
    number: 7,
    comment_id: byFp(F_TOOL).id,
    body: "Resolved by pr-review: the code this comment refers to changed at x.",
  });
  await gh.resolveThread({ thread_id: byFp(F_TOOL).thread_id });
  return { byFp };
}

describe("findPriorRecord (R7)", () => {
  it("gives null when the directory does not exist", async () => {
    expect(await findPriorRecord(newOutDir(), { slug: SLUG, pr: 7 })).toBeNull();
  });

  it("takes the newest record that posted, with no error, not at skip, for this PR", async () => {
    const out = newOutDir();
    const good = writeRecordFile(out, "2026-10-13T120000.000Z-aaaaaaa.json", makeRecord());
    writeRecordFile(out, "2026-10-13T120100.000Z-aaaaaaa.json", makeRecord({ github: null }));
    writeRecordFile(
      out,
      "2026-10-13T120200.000Z-aaaaaaa.json",
      makeRecord({
        github: { ...makeRecord().posted.github!, review_id: null, review_url: null, error: "x" },
      }),
    );
    writeRecordFile(out, "2026-10-13T120300.000Z-aaaaaaa.json", makeRecord({ tier: "skip" }));
    writeRecordFile(out, "2026-10-13T120400.000Z-aaaaaaa.json", makeRecord({ slug: "other/x" }));
    writeRecordFile(out, "2026-10-13T120500.000Z-aaaaaaa.json", makeRecord({ pr: 8 }));
    writeRecordFile(out, "2026-10-13T120600.000Z-aaaaaaa.json", "{ not json");
    writeRecordFile(out, "notes.txt", "x");
    const found = await findPriorRecord(out, { slug: SLUG, pr: 7 });
    expect(found?.path).toBe(good);
    expect(found?.record.identity.head).toBe(H0);
  });

  it("takes the newest of two good records", async () => {
    const out = newOutDir();
    writeRecordFile(out, "2026-10-13T120000.000Z-ccccccc.json", makeRecord({ head: OLDER }));
    const newer = writeRecordFile(out, "2026-10-13T130000.000Z-aaaaaaa.json", makeRecord());
    expect((await findPriorRecord(out, { slug: SLUG, pr: 7 }))?.path).toBe(newer);
  });
});

describe("loadPriorState (R7)", () => {
  it("gives null with no review of the tool, or only skip and failed reviews", async () => {
    const { gh, ctx } = setup();
    expect(await loadPriorState(gh, { ctx, outDir: newOutDir() })).toBeNull();
    await gh.createReview({
      slug: SLUG,
      number: 7,
      commit_id: H0,
      body: `${marker(H0, { tier: "skip" })} skip`,
      comments: [],
    });
    await gh.createReview({
      slug: SLUG,
      number: 7,
      commit_id: H0,
      body: `${marker(H0, { status: "failed" })}\nfailed`,
      comments: [],
    });
    expect(await loadPriorState(gh, { ctx, outDir: newOutDir() })).toBeNull();
  });

  it("ignores a review with a marker from another author", async () => {
    const { gh, ctx } = setup();
    gh.state.reviews.push({
      id: 1,
      body: `${marker(H0)} forged`,
      author: "mallory",
      commit_id: H0,
      url: "u",
      comments: [],
    });
    expect(await loadPriorState(gh, { ctx, outDir: newOutDir() })).toBeNull();
  });

  it("takes H0, the triage tier and the findings from the record, and the thread state from GitHub", async () => {
    const { gh, ctx } = setup();
    const { byFp } = await postedState(gh);
    const out = newOutDir();
    const path = writeRecordFile(
      out,
      "2026-10-13T120000.000Z-aaaaaaa.json",
      makeRecord({ triageTier: "full" }),
    );
    const prior = (await loadPriorState(gh, { ctx, outDir: out }))!;
    expect(prior.head).toBe(H0);
    expect(prior.source).toBe("record");
    expect(prior.record).toBe(path);
    expect(prior.triageTier).toBe("full");
    expect([...prior.open.keys()].sort()).toEqual([F_OPEN.fingerprint, F_BODY.fingerprint].sort());
    expect(prior.open.get(F_OPEN.fingerprint)).toMatchObject({
      finding: F_OPEN,
      thread_id: byFp(F_OPEN).thread_id,
      severity: "blocking",
    });
    expect(prior.open.get(F_BODY.fingerprint)).toMatchObject({
      finding: F_BODY,
      thread_id: null,
      severity: "suggestion",
    });
    // A thumbs-down and a thread a human resolved are dismissed. A thread
    // the tool resolved is neither open nor dismissed.
    expect([...prior.dismissed].sort()).toEqual([F_DOWN.fingerprint, F_HUMAN.fingerprint].sort());
    expect(prior.open.has(F_TOOL.fingerprint)).toBe(false);
    expect(prior.dismissed.has(F_TOOL.fingerprint)).toBe(false);
  });

  it("falls back to the newest body marker with no record, with no findings and no triage tier", async () => {
    const { gh, ctx } = setup();
    await postedState(gh);
    const prior = (await loadPriorState(gh, { ctx, outDir: newOutDir() }))!;
    expect(prior.source).toBe("marker");
    expect(prior.record).toBeNull();
    expect(prior.head).toBe(H0);
    expect(prior.triageTier).toBeNull();
    expect(prior.open.get(F_OPEN.fingerprint)).toMatchObject({
      finding: null,
      severity: "blocking",
    });
    expect(prior.open.get(F_BODY.fingerprint)).toMatchObject({
      finding: null,
      thread_id: null,
      severity: "suggestion",
    });
    expect([...prior.dismissed].sort()).toEqual([F_DOWN.fingerprint, F_HUMAN.fingerprint].sort());
  });

  it("takes the marker source when the newest record's head is not the head of the newest review", async () => {
    // A records push failed: the newest record is of the older review, but
    // the newest review of the tool is at H0.
    const { gh, ctx } = setup();
    await postedState(gh);
    const out = newOutDir();
    writeRecordFile(out, "2026-10-13T120000.000Z-ccccccc.json", makeRecord({ head: OLDER }));
    const prior = (await loadPriorState(gh, { ctx, outDir: out }))!;
    expect(prior.source).toBe("marker");
    expect(prior.head).toBe(H0);
    expect(prior.record).toBeNull();
    expect(prior.triageTier).toBeNull();
    expect(prior.open.get(F_OPEN.fingerprint)?.finding).toBeNull();
    expect(prior.open.get(F_BODY.fingerprint)?.finding).toBeNull();
  });

  it("ignores an inline comment from another author", async () => {
    const { gh, ctx } = setup();
    await postedState(gh);
    gh.state.review_comments.push({
      id: 9999,
      node_id: "n",
      body: formatFingerprintMarker("9999999999999999"),
      path: "src/a.ts",
      line: 1,
      start_line: null,
      author: "mallory",
      thread_id: "T-mallory",
      review_id: null,
    });
    const prior = (await loadPriorState(gh, { ctx, outDir: newOutDir() }))!;
    expect(prior.open.has("9999999999999999")).toBe(false);
  });
});

describe("reverify and resolveStaleThreads (R7)", () => {
  function prior(
    entries: [PostedFinding, string | null][],
    source: PriorState["source"] = "record",
  ): PriorState {
    return {
      head: H0,
      source,
      record: null,
      triageTier: null,
      open: new Map(
        entries.map(([f, thread]) => [
          f.fingerprint,
          {
            finding: source === "record" ? f : null,
            thread_id: thread,
            comment_id: null,
            severity: f.severity,
          },
        ]),
      ),
      dismissed: new Set(),
    };
  }

  it("keeps an entry open while its span text is in the head file, and marks it stale when gone", () => {
    const state = prior([
      [F_OPEN, "T1"],
      [F_TOOL, "T2"],
      [F_BODY, null],
      [F_HUMAN, null],
    ]);
    // The file holds the spans of F_OPEN and F_BODY, with other spacing.
    const text = "const   one = 1;\nconst five =\n  5;\n";
    const out = reverify(state, () => text);
    expect([...out.open.keys()].sort()).toEqual([F_OPEN.fingerprint, F_BODY.fingerprint].sort());
    expect(out.staleThreads).toEqual([{ thread_id: "T2", fingerprint: F_TOOL.fingerprint }]);
    // A body finding whose span is gone drops from the open set. It has no thread.
    expect(out.droppedBody).toEqual([F_HUMAN.fingerprint]);
  });

  it("treats a file that is gone as a span that is gone", () => {
    const out = reverify(prior([[F_OPEN, "T1"]]), () => null);
    expect(out.staleThreads).toEqual([{ thread_id: "T1", fingerprint: F_OPEN.fingerprint }]);
  });

  it("keeps every entry open with the marker source, because it has no span text", () => {
    const out = reverify(
      prior(
        [
          [F_OPEN, "T1"],
          [F_BODY, null],
        ],
        "marker",
      ),
      () => "",
    );
    expect(out.open.size).toBe(2);
    expect(out.staleThreads).toEqual([]);
    expect(out.droppedBody).toEqual([]);
  });

  it("replies and resolves each stale thread, and a later load sees it as tool-resolved", async () => {
    const { gh, ctx } = setup();
    const { byFp } = await postedState(gh);
    const out = newOutDir();
    writeRecordFile(out, "2026-10-13T120000.000Z-aaaaaaa.json", makeRecord());
    const state = (await loadPriorState(gh, { ctx, outDir: out }))!;
    const head2 = "d".repeat(40);
    const result = await resolveStaleThreads(gh, {
      ctx,
      prior: state,
      headFileText: () => "const five = 5;\n",
      head: head2,
    });
    const thread = byFp(F_OPEN).thread_id;
    expect(result).toEqual({
      resolved: [{ thread_id: thread, fingerprint: F_OPEN.fingerprint }],
      errors: [],
    });
    const after = await gh.getThread({ thread_id: thread });
    expect(after.resolved).toBe(true);
    expect(after.comments.at(-1)).toMatchObject({
      author: VIEWER,
      body: `Resolved by pr-review: the code this comment refers to changed at ${head2}.`,
    });
    // The body finding is never resolved.
    expect(gh.state.replies).toHaveLength(2);

    const again = (await loadPriorState(gh, { ctx, outDir: out }))!;
    expect(again.open.has(F_OPEN.fingerprint)).toBe(false);
    expect(again.dismissed.has(F_OPEN.fingerprint)).toBe(false);
  });

  it("resolves nothing with the marker source", async () => {
    const { gh, ctx } = setup();
    await postedState(gh);
    const state = (await loadPriorState(gh, { ctx, outDir: newOutDir() }))!;
    const result = await resolveStaleThreads(gh, { ctx, prior: state, headFileText: () => "" });
    expect(result).toEqual({ resolved: [], errors: [] });
  });

  it("records a failed resolve under errors", async () => {
    const { gh, ctx } = setup();
    await postedState(gh);
    const out = newOutDir();
    writeRecordFile(out, "2026-10-13T120000.000Z-aaaaaaa.json", makeRecord());
    const state = (await loadPriorState(gh, { ctx, outDir: out }))!;
    gh.failNext(
      "resolveThread",
      new GitHubError({ endpoint: "graphql", exitCode: 1, message: "boom" }),
    );
    const result = await resolveStaleThreads(gh, { ctx, prior: state, headFileText: () => "" });
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([
      { step: "resolve thread", message: expect.stringContaining("boom") },
    ]);
  });
});
