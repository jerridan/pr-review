// D8 R2: the eval keeps every judge answer it used, and a later scoring
// of the same record reuses them.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// A fake judge. With "fail", every query fails, so each answer is "unknown".
function judge(fail = false) {
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    if (fail) return { ok: false, failure: { kind: "limit", message: "budget" }, raw: null };
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

describe("the judge cache and a failed answer (D8 R2, review)", () => {
  it("asks a cached unknown again when a client is given, and keeps the new answer", async () => {
    const cache = await readJudgeCache(join(work, "none-1.json"));
    const head = join(work, "head");
    const failed = await scoreRecord(
      record(),
      GOLDEN,
      head,
      { client: judge(true), model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    expect(failed.judgeUnknown).toBe(1);
    const again = judge();
    const two = await scoreRecord(
      record(),
      GOLDEN,
      head,
      { client: again, model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    expect(again.calls.length).toBe(2);
    expect(two.matched.length).toBe(1);
    expect(two.judgeUnknown).toBe(0);
    expect(two.extras).toMatchObject({ unknown: 0, accepted: [1] });
    // The new answers replace the failed ones in the cache.
    const replay = judge();
    await scoreRecord(
      record(),
      GOLDEN,
      head,
      { client: replay, model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    expect(replay.calls).toEqual([]);
  });

  it("uses a cached unknown with no client, and counts it as unknown", async () => {
    const cache = await readJudgeCache(join(work, "none-2.json"));
    const head = join(work, "head");
    await scoreRecord(
      record(),
      GOLDEN,
      head,
      { client: judge(true), model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    const offline = await scoreRecord(
      record(),
      GOLDEN,
      head,
      { client: null, model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    expect(offline.uncached).toBe(0);
    expect(offline.judgeUnknown).toBe(1);
    // The match judge failed, so both posted findings went to the extras judge.
    expect(offline.extras.unknown).toBe(2);
  });
});

describe("the key of a judge answer (D8 R2, review)", () => {
  it("misses the cache when the head lines that the judge sees change", async () => {
    const cache = await readJudgeCache(join(work, "none-3.json"));
    await scoreRecord(
      record(),
      GOLDEN,
      join(work, "head"),
      { client: judge(), model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    const other = join(work, "head-other");
    mkdirSync(join(other, "src"), { recursive: true });
    const lines = Array.from({ length: 60 }, (_, i) => `let w${i + 1} = ${i + 1};`);
    writeFileSync(join(other, "src", "a.ts"), `${lines.join("\n")}\n`);
    const fresh = judge();
    await scoreRecord(
      record(),
      GOLDEN,
      other,
      { client: fresh, model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    // Both the match question and the extras question show those lines.
    expect(fresh.calls.length).toBe(2);
  });

  it("misses the cache when the judge prompts change", async () => {
    const path = join(work, "judge-cache-prompt.json");
    const cache = await readJudgeCache(path);
    await scoreRecord(
      record(),
      GOLDEN,
      join(work, "head"),
      { client: judge(), model: MODEL, options: OPTIONS, cache },
      { extras: true },
    );
    await writeJudgeCache(path, cache);

    // The prompt loader reads PR_REVIEW_PROMPTS_DIR when it loads, so load
    // new copies of the modules after the variable is set.
    const prompts = join(work, "prompts");
    cpSync(fileURLToPath(new URL("../prompts/", import.meta.url)), prompts, { recursive: true });
    for (const file of ["judge.md", "extras-judge.md"]) {
      writeFileSync(
        join(prompts, file),
        `${readFileSync(join(prompts, file), "utf8")}\nOne more line.\n`,
      );
    }
    vi.stubEnv("PR_REVIEW_PROMPTS_DIR", prompts);
    vi.resetModules();
    try {
      const fresh = await import("../src/eval/score.js");
      const cacheModule = await import("../src/eval/judge-cache.js");
      const client = judge();
      await fresh.scoreRecord(
        record(),
        GOLDEN,
        join(work, "head"),
        { client, model: MODEL, options: OPTIONS, cache: await cacheModule.readJudgeCache(path) },
        { extras: true },
      );
      expect(client.calls.length).toBe(2);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("a judge cache file that is not valid (D8 R2, review)", () => {
  it("throws an error that names the file", async () => {
    const path = join(work, "corrupt-cache.json");
    writeFileSync(path, "{ not json");
    await expect(readJudgeCache(path)).rejects.toThrow(path);
  });
});
