// D8 R2: the eval keeps every judge answer it used, and a later scoring
// of the same record reuses them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import type { GoldenFinding } from "../src/eval/case.js";
import { readJudgeCache, writeJudgeCache } from "../src/eval/judge-cache.js";
import { metrics, type RepeatMetrics } from "../src/eval/metrics.js";
import { ExtrasOutputSchema, scoreRecord } from "../src/eval/score.js";
import type { PostedFinding, RunRecord } from "../src/schemas/record.js";
import type { QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const MODEL = "claude-sonnet-5-5";
const OPTIONS = { allowApiKey: false, env: {} };

let work = "";
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pr-review-judge-cache-"));
  mkdirSync(join(work, "head", "src"), { recursive: true });
  const lines = Array.from({ length: 60 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  writeFileSync(join(work, "head", "src", "a.ts"), `${lines.join("\n")}\n`);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

function posted(start: number, category: PostedFinding["category"]): PostedFinding {
  return {
    file: "src/a.ts",
    start_line: start,
    end_line: start,
    category,
    severity_estimate: "blocking",
    confidence: "high",
    claim: `CLAIM-${start}`,
    evidence: `const v${start} = ${start};`,
    explanation: "e",
    needs_context: false,
    fingerprint: `fp${start}`,
    severity: "blocking",
    score: 90,
    verifier: {
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: ["q"],
      rationale: "r",
      score: 90,
      severity: "blocking",
    },
    span_text: "s",
  };
}

// Two posted findings: one near the golden with another category (an
// ambiguous pair, so a match judge query), and one far from it (an extras
// judge query).
function record(): RunRecord {
  const findings = [posted(12, "security"), posted(50, "bug")];
  return {
    identity: {
      repo: "/repo",
      pr: null,
      github: null,
      run_kind: "first",
      prior: null,
      base: "a".repeat(40),
      head: "b".repeat(40),
      started_at: "2026-11-14T12:00:00.000Z",
      tool_version: "0.1.0",
      config_hash: null,
      config: { files: [], values: DEFAULT_REPO_CONFIG, custom_reviewers: [] },
      description: "d",
      description_meta: { source: "commits", sanitized: false, truncated: false },
      history: { built: false, truncated: false },
      injected: [],
      changed_files: [],
      excluded_files: [],
      sensitive_files: [],
      triage: null,
      tier: "full",
      tier_reason: "r",
      selected_reviewers: [],
      models: {
        triage: { model: MODEL, effort: "medium" },
        reviewer: { model: "claude-opus-5-5", effort: "low" },
        verifier: { model: MODEL, effort: "high" },
        "verifier-escalation": { model: "claude-opus-5-5", effort: "high" },
        merge: { model: MODEL, effort: "medium" },
        smoke: { model: MODEL, effort: "low" },
      },
    },
    stages: {
      reviewers: [{ name: "r", pass: 1, status: "ok", findings, dropped: [], meta: null }],
      verifications: [],
      merges: [],
      capped: [],
      suppressed: [],
      pre_existing: [],
    },
    posted: {
      verdict: "would request changes",
      coverage: {
        reviewers_ran: ["r"],
        reviewers_failed: [],
        reviewers_skipped: [],
        reviewers_without_bash: [],
        sensitive_without_hunks: [],
        findings_dropped_by_failed_verifier: 0,
      },
      findings,
      github: null,
      below_floor: [],
      not_reposted: [],
      carried: [],
    },
    cost: { queries: [], total_cost_usd: 1, queries_without_cost: 0, stage_ms: {}, errors: [] },
  };
}

const GOLDEN: GoldenFinding[] = [
  {
    file: "src/a.ts",
    start_line: 10,
    end_line: 10,
    category: "bug",
    severity: "blocking",
    claim: "g",
  },
];

function judge() {
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const raw = {
      model: MODEL,
      durationMs: 1,
      stopReason: "end_turn",
      subtype: "success",
      usage: {},
      costUsd: 0.25,
    };
    if (req.schema === ExtrasOutputSchema)
      return { ok: true, output: { real: "yes", reason: "r" }, raw };
    return { ok: true, output: { same_issue: "yes", reason: "r" }, raw };
  });
}

// The metrics that the judge answers set. The judge calls and the judge
// cost count the queries, so they are not here.
function scored(m: RepeatMetrics) {
  const { judge_calls: _calls, judge_cost_usd: _cost, ...rest } = m;
  return rest;
}

describe("the judge cache (D8 R2)", () => {
  it("makes no judge query for a second scoring with the cache, and gives the same metrics", async () => {
    const path = join(work, "judge-cache.json");
    const first = judge();
    const cache = await readJudgeCache(path);
    const rec = record();
    const one = await scoreRecord(
      rec,
      GOLDEN,
      join(work, "head"),
      { client: first, model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    await writeJudgeCache(path, cache);
    expect(first.calls.length).toBe(2);

    const second = judge();
    const two = await scoreRecord(
      record(),
      GOLDEN,
      join(work, "head"),
      { client: second, model: MODEL, options: OPTIONS, cache: await readJudgeCache(path) },
      { extras: true },
    );
    expect(second.calls).toEqual([]);
    expect(scored(metrics(rec, two, 1))).toEqual(scored(metrics(rec, one, 1)));
    expect(metrics(rec, two, 1).recall).toBe(1);
    expect(metrics(rec, two, 1).extras_accepted).toBe(1);
  });

  it("asks the judge again when the judge model differs from the cached one", async () => {
    const path = join(work, "judge-cache-model.json");
    const cache = await readJudgeCache(path);
    await scoreRecord(
      record(),
      GOLDEN,
      join(work, "head"),
      { client: judge(), model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    await writeJudgeCache(path, cache);
    const other = judge();
    await scoreRecord(
      record(),
      GOLDEN,
      join(work, "head"),
      {
        client: other,
        model: "claude-opus-5-5",
        options: OPTIONS,
        cache: await readJudgeCache(path),
      },
      { extras: true },
    );
    expect(other.calls.length).toBe(2);
  });
});
