import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import type { Gate } from "../src/eval/baseline.js";
import { failedMetrics, metrics, type RepeatMetrics } from "../src/eval/metrics.js";
import { buildReport, renderTable } from "../src/eval/report.js";
import type { GoldenFinding } from "../src/eval/case.js";
import { scoreRecord, type ScoreResult } from "../src/eval/score.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import type { PostedFinding, RunRecord } from "../src/schemas/record.js";

function posted(line: number): PostedFinding {
  return {
    file: "src/a.ts",
    start_line: line,
    end_line: line,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: "c",
    evidence: "e",
    explanation: "x",
    needs_context: false,
    fingerprint: "f".repeat(16),
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

function record(
  findings: PostedFinding[],
  cost: { total: number | null; stageMs: Record<string, number> },
): RunRecord {
  return {
    identity: {
      repo: "/repo",
      pr: null,
      github: null,
      run_kind: "first",
      prior: null,
      base: "a".repeat(40),
      head: "b".repeat(40),
      started_at: "2026-10-16T12:00:00.000Z",
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
      triage: null,
      tier: "full",
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
      findings,
      github: null,
      below_floor: [],
      not_reposted: [],
      carried: [],
    },
    cost: {
      queries: [],
      total_cost_usd: cost.total,
      queries_without_cost: 0,
      stage_ms: cost.stageMs,
      errors: [],
    },
  };
}

function scoreOf(parts: Partial<ScoreResult> = {}): ScoreResult {
  return {
    matched: [],
    judgeCalls: 0,
    judgeUnknown: 0,
    judgeCostUsd: 0,
    severityAgreement: { same: 0, matched: 0 },
    notRealMatches: 0,
    postedGoldenCount: 0,
    unmatchedPosted: [],
    raw: { matched: [], candidates: 0 },
    extras: { enabled: false, judged: 0, accepted: [] },
    ...parts,
  };
}

describe("metrics (R5.1, R5.2)", () => {
  it("gives every metric of one repeat from the record and the score", () => {
    const rec = record([posted(1), posted(2), posted(3), posted(4)], {
      total: 0.3,
      stageMs: { gather: 100, find: 50 },
    });
    const score = scoreOf({
      matched: [{ posted: 0, golden: 0, via: "exact" }],
      judgeCalls: 2,
      judgeUnknown: 1,
      judgeCostUsd: 0.25,
      severityAgreement: { same: 1, matched: 1 },
      notRealMatches: 1,
      postedGoldenCount: 2,
      unmatchedPosted: [2, 3],
      raw: {
        matched: [
          { posted: 0, golden: 0, via: "exact" },
          { posted: 2, golden: 1, via: "judge" },
        ],
        candidates: 5,
      },
      extras: { enabled: true, judged: 2, accepted: [3] },
    });
    expect(metrics(rec, score, 3)).toEqual({
      repeat: 3,
      failed: false,
      error: null,
      recall: 0.5,
      precision: 0.25,
      posted: 4,
      matched: 1,
      cost_usd: 0.3,
      run_ms: 150,
      judge_calls: 2,
      judge_unknown: 1,
      judge_cost_usd: 0.25,
      severity_agreement: { same: 1, matched: 1 },
      not_real_matches: 1,
      raw_recall: 1,
      raw_matched: 2,
      raw_candidates: 5,
      drops: {},
      extras_judged: 2,
      extras_accepted: 1,
      // One match and one accepted extra of four posted findings.
      adjudicated_precision: 0.5,
    });
  });

  it("gives null adjudicated precision when extras are off, and keeps the strict precision", () => {
    const rec = record([posted(1), posted(2)], { total: 0, stageMs: {} });
    const m = metrics(rec, scoreOf({ matched: [{ posted: 0, golden: 0, via: "exact" }] }), 1);
    expect(m.adjudicated_precision).toBeNull();
    expect(m.extras_judged).toBe(0);
    expect(m.precision).toBe(0.5);
  });

  it("gives null adjudicated precision when no finding posted", () => {
    const rec = record([], { total: 0, stageMs: {} });
    const m = metrics(rec, scoreOf({ extras: { enabled: true, judged: 0, accepted: [] } }), 1);
    expect(m.adjudicated_precision).toBeNull();
  });

  it("keeps the judge cost out of cost_usd", () => {
    const rec = record([posted(1)], { total: 0.1, stageMs: {} });
    const m = metrics(rec, scoreOf({ judgeCalls: 1, judgeCostUsd: 0.25, postedGoldenCount: 1 }), 1);
    expect(m.cost_usd).toBe(0.1);
    expect(m.judge_cost_usd).toBe(0.25);
  });

  it("gives null recall for a case with no posted golden finding", () => {
    expect(metrics(record([posted(1)], { total: 0, stageMs: {} }), scoreOf(), 1).recall).toBe(null);
  });

  it("gives null precision when no finding posted", () => {
    const m = metrics(record([], { total: 0, stageMs: {} }), scoreOf({ postedGoldenCount: 2 }), 1);
    expect(m.precision).toBeNull();
    expect(m.recall).toBe(0);
  });

  // A posted finding at the span of a not_real golden, and one posted
  // golden elsewhere that no finding matches.
  it("gives recall over the posted goldens only, and counts the not-real match as a false positive", async () => {
    const rec = record([posted(10)], { total: 0, stageMs: {} });
    const goldens: GoldenFinding[] = [
      {
        file: "src/b.ts",
        start_line: 5,
        end_line: 5,
        category: "bug",
        severity: "blocking",
        claim: "g",
      },
      {
        file: "src/a.ts",
        start_line: 10,
        end_line: 10,
        category: "bug",
        severity: "not_real",
        claim: "n",
      },
    ];
    const noJudge = createFakeSdkClient(() => {
      throw new Error("no judge query is expected");
    });
    const score = await scoreRecord(rec, goldens, "/nonexistent", {
      client: noJudge,
      model: "claude-sonnet-5-5",
      options: { allowApiKey: false, env: {} },
    });
    const m = metrics(rec, score, 1);
    expect(m.recall).toBe(0);
    expect(m.precision).toBe(0);
    expect(m.matched).toBe(0);
    expect(m.not_real_matches).toBe(1);
  });

  it("gives null raw recall for a case with no posted golden finding", () => {
    expect(metrics(record([], { total: 0, stageMs: {} }), scoreOf(), 1).raw_recall).toBeNull();
  });

  // The reviewer found the golden bug, and the verifier dropped it, so it
  // did not post.
  it("gives raw recall 1, recall 0 and one verify drop when the verifier drops a golden hit", async () => {
    const rec = record([], { total: 0, stageMs: {} });
    const {
      verifier: _v,
      fingerprint: _f,
      severity: _s,
      score: _sc,
      span_text: _t,
      ...hit
    } = posted(10);
    rec.stages.reviewers = [
      { name: "r", pass: 1, status: "ok", findings: [hit], dropped: [], meta: null },
    ];
    const rejected = { ...posted(10).verifier, claim_holds: false, score: 20 };
    rec.stages.verifications = [{ finding: hit, first: rejected, final: null, passed: false }];
    const goldens: GoldenFinding[] = [
      {
        file: "src/a.ts",
        start_line: 10,
        end_line: 10,
        category: "bug",
        severity: "blocking",
        claim: "g",
      },
    ];
    const noJudge = createFakeSdkClient(() => {
      throw new Error("no judge query is expected");
    });
    const score = await scoreRecord(rec, goldens, "/nonexistent", {
      client: noJudge,
      model: "claude-sonnet-5-5",
      options: { allowApiKey: false, env: {} },
    });
    const m = metrics(rec, score, 1);
    expect(m.raw_recall).toBe(1);
    expect(m.recall).toBe(0);
    expect(m.raw_matched).toBe(1);
    expect(m.raw_candidates).toBe(1);
    expect(m.drops).toEqual({ verify: 1 });
  });
});

describe("failedMetrics (R3.8)", () => {
  it("gives a failed repeat with the error, null metrics and no posted finding", () => {
    expect(failedMetrics(2, "the run threw", 40)).toEqual({
      repeat: 2,
      failed: true,
      error: "the run threw",
      recall: null,
      precision: null,
      posted: 0,
      matched: 0,
      cost_usd: null,
      run_ms: 40,
      judge_calls: 0,
      judge_unknown: 0,
      judge_cost_usd: 0,
      severity_agreement: { same: 0, matched: 0 },
      not_real_matches: 0,
      raw_recall: null,
      raw_matched: 0,
      raw_candidates: 0,
      drops: {},
      extras_judged: 0,
      extras_accepted: 0,
      adjudicated_precision: null,
    });
  });
});

// The metrics of one repeat. "matched" follows from the precision and the
// posted count, unless the test gives it.
function rm(repeat: number, parts: Partial<RepeatMetrics> = {}): RepeatMetrics {
  const posted = parts.posted ?? 1;
  const precision = parts.precision === undefined ? 1 : parts.precision;
  return {
    repeat,
    failed: false,
    error: null,
    recall: 1,
    precision,
    posted,
    matched: precision === null ? 0 : precision * posted,
    cost_usd: 0.1,
    run_ms: 10,
    judge_calls: 0,
    judge_unknown: 0,
    judge_cost_usd: 0,
    severity_agreement: { same: 0, matched: 0 },
    not_real_matches: 0,
    raw_recall: 1,
    raw_matched: 0,
    raw_candidates: 0,
    drops: {},
    extras_judged: 0,
    extras_accepted: 0,
    adjudicated_precision: null,
    ...parts,
  };
}

describe("buildReport (R5.3, R5.4, R5.6)", () => {
  const cases = [
    {
      name: "a-case",
      repeats: [
        rm(1, { recall: 1, precision: 0.5, posted: 2, cost_usd: 0.2, judge_calls: 1 }),
        rm(2, { recall: 1, precision: 1, posted: 1, cost_usd: 0.4, judge_unknown: 1 }),
      ],
    },
    {
      name: "b-case",
      repeats: [
        rm(1, { recall: 0, precision: null, posted: 0, cost_usd: 0.4, judge_cost_usd: 0.25 }),
        rm(2, { recall: 0, precision: 0, posted: 3, cost_usd: 0.2, judge_calls: 2 }),
      ],
    },
  ];

  it("gives the mean over the cases of recall and findings, and the pooled precision, for each repeat", () => {
    const { repeats } = buildReport(cases, null, null);
    // Repeat 1: 1 matched of 2 posted, and a case with none posted: 0.5.
    // Repeat 2: 1 matched of 1 posted, and 0 matched of 3 posted: 1 of 4.
    const same = { raw_recall: 1, recall: 0.5, adjudicated_precision: null, drops: {} };
    expect(repeats.map(({ cost_per_case: _cost, ...rest }) => rest)).toEqual([
      { repeat: 1, ...same, precision: 0.5, findings_per_case: 1, judge_cost_per_case: 0.125 },
      { repeat: 2, ...same, precision: 0.25, findings_per_case: 2, judge_cost_per_case: 0 },
    ]);
    expect(repeats[0]?.cost_per_case).toBeCloseTo(0.3, 10);
    expect(repeats[1]?.cost_per_case).toBeCloseTo(0.3, 10);
  });

  it("pools the precision of a repeat: 1 matched of 1 and 0 matched of 3 give 0.25, not 0.5", () => {
    const pooled = [
      { name: "a-case", repeats: [rm(1, { precision: 1, posted: 1, matched: 1 })] },
      { name: "b-case", repeats: [rm(1, { precision: 0, posted: 3, matched: 0 })] },
    ];
    expect(buildReport(pooled, null, null).repeats[0]?.precision).toBe(0.25);
  });

  it("gives null pooled precision for a repeat where no case posted a finding", () => {
    const none = [
      { name: "a-case", repeats: [rm(1, { precision: null, posted: 0 })] },
      { name: "b-case", repeats: [rm(1, { precision: null, posted: 0 })] },
    ];
    expect(buildReport(none, null, null).repeats[0]?.precision).toBeNull();
  });

  it("gives the mean, the minimum and the maximum of the per-repeat values", () => {
    const varied = [
      {
        name: "a-case",
        repeats: [rm(1, { precision: 0.25, posted: 4 }), rm(2, { precision: 0.75, posted: 8 })],
      },
    ];
    const { aggregate } = buildReport(varied, null, null);
    expect(aggregate.precision).toEqual({ mean: 0.5, min: 0.25, max: 0.75 });
    expect(aggregate.findings_per_case).toEqual({ mean: 6, min: 4, max: 8 });
    expect(aggregate.recall).toEqual({ mean: 1, min: 1, max: 1 });
  });

  it("gives null for a mean of no value", () => {
    const none = [
      {
        name: "a-case",
        repeats: [rm(1, { precision: null, posted: 0 }), rm(2, { precision: null, posted: 0 })],
      },
    ];
    const report = buildReport(none, null, null);
    expect(report.repeats.map((r) => r.precision)).toEqual([null, null]);
    expect(report.aggregate.precision).toEqual({ mean: null, min: null, max: null });
  });

  it("gives the mean raw recall and the summed drops of each repeat, and both over the eval", () => {
    const withDrops = [
      {
        name: "a-case",
        repeats: [
          rm(1, { raw_recall: 1, drops: { verify: 2, merge: 1 } }),
          rm(2, { raw_recall: 0.5, drops: { verify: 1 } }),
        ],
      },
      {
        name: "b-case",
        repeats: [
          rm(1, { raw_recall: 0, drops: { cap: 1 } }),
          rm(2, { raw_recall: null, drops: {} }),
          failedMetrics(3, "boom", 1),
        ],
      },
    ];
    const report = buildReport(withDrops, null, null);
    expect(report.repeats.map((r) => [r.repeat, r.raw_recall, r.drops])).toEqual([
      [1, 0.5, { verify: 2, merge: 1, cap: 1 }],
      [2, 0.5, { verify: 1 }],
      [3, null, {}],
    ]);
    expect(report.aggregate.raw_recall).toEqual({ mean: 0.5, min: 0.5, max: 0.5 });
    expect(report.aggregate.drops).toEqual({ verify: 3, merge: 1, cap: 1 });
  });

  it("sums the judge calls, the unknown answers and the judge cost over the eval", () => {
    expect(buildReport(cases, null, null).judge).toEqual({ calls: 3, unknown: 1, cost_usd: 0.25 });
  });

  it("lists a failed repeat and leaves it out of every mean", () => {
    const withFailure = [
      {
        name: "a-case",
        repeats: [rm(1, { recall: 1, posted: 4, cost_usd: 0.5 }), failedMetrics(2, "boom", 5)],
      },
      {
        name: "b-case",
        repeats: [
          rm(1, { recall: 0, posted: 2, cost_usd: 0.1 }),
          rm(2, { recall: 0.5, posted: 2, cost_usd: 0.1 }),
        ],
      },
    ];
    const report = buildReport(withFailure, null, null);
    expect(report.failed_repeats).toEqual([{ case: "a-case", repeat: 2, error: "boom" }]);
    expect(report.repeats[1]).toEqual({
      repeat: 2,
      raw_recall: 1,
      recall: 0.5,
      precision: 1,
      findings_per_case: 2,
      cost_per_case: 0.1,
      drops: {},
      adjudicated_precision: null,
      judge_cost_per_case: 0,
    });
    expect(report.cases[0]?.repeats[1]?.failed).toBe(true);
  });

  it("pools the adjudicated precision of a repeat, and gives the mean judge cost per case", () => {
    const judged = [
      {
        name: "a-case",
        repeats: [
          rm(1, {
            posted: 4,
            matched: 1,
            extras_accepted: 1,
            adjudicated_precision: 0.5,
            judge_cost_usd: 0.1,
          }),
          rm(2, { judge_cost_usd: 0.5 }),
        ],
      },
      {
        name: "b-case",
        repeats: [
          rm(1, {
            posted: 2,
            matched: 0,
            extras_accepted: 2,
            adjudicated_precision: 1,
            judge_cost_usd: 0.3,
          }),
          rm(2, { judge_cost_usd: 0.1 }),
        ],
      },
    ];
    const report = buildReport(judged, null, null);
    // Repeat 1: (1 + 1 + 0 + 2) / (4 + 2). Repeat 2 has no extras.
    expect(report.repeats[0]?.adjudicated_precision).toBeCloseTo(4 / 6, 10);
    expect(report.repeats[1]?.adjudicated_precision).toBeNull();
    expect(report.repeats[0]?.judge_cost_per_case).toBeCloseTo(0.2, 10);
    expect(report.repeats[1]?.judge_cost_per_case).toBeCloseTo(0.3, 10);
    const adj = report.aggregate.adjudicated_precision;
    expect([adj.mean, adj.min, adj.max].map((v) => v?.toFixed(6))).toEqual(
      Array(3).fill((4 / 6).toFixed(6)),
    );
    const cost = report.aggregate.judge_cost_per_case;
    expect([cost.mean, cost.min, cost.max].map((v) => v?.toFixed(6))).toEqual([
      "0.250000",
      "0.200000",
      "0.300000",
    ]);
  });

  it("holds the cases, the gate and the cases ref that it gets", () => {
    const gate: Gate = {
      passed: false,
      recall_drop: 0.5,
      precision_drop: 0,
      margin: { recall: 0.05, precision: 0.05 },
    };
    const report = buildReport(cases, gate, "c".repeat(40));
    expect(report.cases).toEqual(cases);
    expect(report.gate).toEqual(gate);
    expect(report.cases_ref).toBe("c".repeat(40));
  });
});

describe("renderTable (R5.5)", () => {
  const report = buildReport(
    [
      {
        name: "a-case",
        repeats: [
          rm(1, {
            recall: 1,
            precision: 0.5,
            posted: 2,
            cost_usd: 0.2,
            drops: { merge: 1, verify: 2 },
            extras_accepted: 1,
            adjudicated_precision: 1,
            judge_cost_usd: 0.05,
          }),
          rm(2, { raw_recall: 0.5, recall: 0.5, precision: 1, posted: 1, cost_usd: 0.4 }),
        ],
      },
      { name: "b-case", repeats: [rm(1), failedMetrics(2, "the run threw", 1)] },
    ],
    null,
    null,
  );
  const text = renderTable(report);

  it("prints one table for each case, with a row for each repeat and the nine columns", () => {
    const lines = text.split("\n");
    for (const name of ["a-case", "b-case"]) expect(text).toContain(name);
    const header = lines.find((l) => /recall/.test(l) && /posted/.test(l)) ?? "";
    expect(header).toMatch(
      /^repeat\s+raw recall\s+recall\s+precision\s+adj precision\s+posted\s+drops\s+cost\s+judge cost$/,
    );
    // The drops go in the order of the pipeline stages. A repeat with no
    // extras shows "-" for the adjudicated precision.
    expect(
      lines.some((l) =>
        /^\s*1\s+1\.000\s+1\.000\s+0\.500\s+1\.000\s+2\s+verify 2, merge 1\s+\$0\.2000\s+\$0\.0500\s*$/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        /^\s*2\s+0\.500\s+0\.500\s+1\.000\s+-\s+1\s+-\s+\$0\.4000\s+\$0\.0000\s*$/.test(l),
      ),
    ).toBe(true);
    expect(text).toContain("the run threw");
  });

  it("prints the cost per PR heading once, before the first case table", () => {
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^cost per PR: /);
    expect(lines[0]).toContain("judge cost");
    expect(lines.filter((l) => l.startsWith("cost per PR:"))).toHaveLength(1);
    expect(text.indexOf("cost per PR:")).toBeLessThan(text.indexOf("Case: a-case"));
  });

  it("prints the adjudicated precision and the judge cost per PR in the summary", () => {
    const lines = text.split("\n");
    // Repeat 1 pools (1 + 1) / 2 from a-case. Repeat 2 has no extras.
    expect(lines.some((l) => /^adj precision\s+1\.000\s+1\.000\s+1\.000\s*$/.test(l))).toBe(true);
    // The judge cost per case is (0.05 + 0) / 2 and 0.
    expect(
      lines.some((l) => /^judge cost per PR\s+\$0\.0125\s+\$0\.0000\s+\$0\.0250\s*$/.test(l)),
    ).toBe(true);
  });

  it("prints the raw recall and the summed drops in the summary", () => {
    const lines = text.split("\n");
    // Raw recall per repeat: (1 + 1) / 2 = 1 and 0.5.
    expect(lines.some((l) => /^raw recall\s+0\.750\s+0\.500\s+1\.000\s*$/.test(l))).toBe(true);
    expect(lines.some((l) => /^drops\s+verify 2, merge 1\s*$/.test(l))).toBe(true);
  });

  it("prints the mean, the minimum and the maximum of the four aggregate metrics", () => {
    const lines = text.split("\n");
    const header = lines.find((l) => /mean/.test(l) && /min/.test(l) && /max/.test(l));
    expect(header).toBeDefined();
    // Recall per repeat: (1 + 1) / 2 = 1 and 0.5, so the mean is 0.75.
    // Pooled precision per repeat: (1 + 1) / (2 + 1) = 0.667 and 1 / 1 = 1.
    expect(lines.some((l) => /^recall\s+0\.750\s+0\.500\s+1\.000\s*$/.test(l))).toBe(true);
    expect(lines.some((l) => /^precision\s+0\.833\s+0\.667\s+1\.000\s*$/.test(l))).toBe(true);
    expect(lines.some((l) => /^findings per case\s+1\.250\s+1\.000\s+1\.500\s*$/.test(l))).toBe(
      true,
    );
    expect(lines.some((l) => /^cost per PR\s+\$0\.2750\s+\$0\.1500\s+\$0\.4000\s*$/.test(l))).toBe(
      true,
    );
  });
});
