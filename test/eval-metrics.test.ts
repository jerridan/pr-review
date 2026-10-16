import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import type { Gate } from "../src/eval/baseline.js";
import { failedMetrics, metrics, type RepeatMetrics } from "../src/eval/metrics.js";
import { buildReport, renderTable } from "../src/eval/report.js";
import type { ScoreResult } from "../src/eval/score.js";
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
    });
    expect(metrics(rec, score, 2, 3)).toEqual({
      repeat: 3,
      failed: false,
      error: null,
      recall: 0.5,
      precision: 0.25,
      posted: 4,
      cost_usd: 0.3,
      run_ms: 150,
      judge_calls: 2,
      judge_unknown: 1,
      judge_cost_usd: 0.25,
      severity_agreement: { same: 1, matched: 1 },
    });
  });

  it("keeps the judge cost out of cost_usd", () => {
    const rec = record([posted(1)], { total: 0.1, stageMs: {} });
    const m = metrics(rec, scoreOf({ judgeCalls: 1, judgeCostUsd: 0.25 }), 1, 1);
    expect(m.cost_usd).toBe(0.1);
    expect(m.judge_cost_usd).toBe(0.25);
  });

  it("gives null recall for a case with no golden finding", () => {
    expect(metrics(record([posted(1)], { total: 0, stageMs: {} }), scoreOf(), 0, 1).recall).toBe(
      null,
    );
  });

  it("gives null precision when no finding posted", () => {
    const m = metrics(record([], { total: 0, stageMs: {} }), scoreOf(), 2, 1);
    expect(m.precision).toBeNull();
    expect(m.recall).toBe(0);
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
      cost_usd: null,
      run_ms: 40,
      judge_calls: 0,
      judge_unknown: 0,
      judge_cost_usd: 0,
      severity_agreement: { same: 0, matched: 0 },
    });
  });
});

function rm(repeat: number, parts: Partial<RepeatMetrics> = {}): RepeatMetrics {
  return {
    repeat,
    failed: false,
    error: null,
    recall: 1,
    precision: 1,
    posted: 1,
    cost_usd: 0.1,
    run_ms: 10,
    judge_calls: 0,
    judge_unknown: 0,
    judge_cost_usd: 0,
    severity_agreement: { same: 0, matched: 0 },
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

  it("gives the mean over the cases of each repeat, and skips a null value", () => {
    const { repeats } = buildReport(cases, null, null);
    expect(repeats.map(({ cost_per_case: _cost, ...rest }) => rest)).toEqual([
      { repeat: 1, recall: 0.5, precision: 0.5, findings_per_case: 1 },
      { repeat: 2, recall: 0.5, precision: 0.5, findings_per_case: 2 },
    ]);
    expect(repeats[0]?.cost_per_case).toBeCloseTo(0.3, 10);
    expect(repeats[1]?.cost_per_case).toBeCloseTo(0.3, 10);
  });

  it("gives the mean, the minimum and the maximum of the per-repeat means", () => {
    const varied = [
      {
        name: "a-case",
        repeats: [rm(1, { precision: 0.25, posted: 2 }), rm(2, { precision: 0.75, posted: 4 })],
      },
    ];
    const { aggregate } = buildReport(varied, null, null);
    expect(aggregate.precision).toEqual({ mean: 0.5, min: 0.25, max: 0.75 });
    expect(aggregate.findings_per_case).toEqual({ mean: 3, min: 2, max: 4 });
    expect(aggregate.recall).toEqual({ mean: 1, min: 1, max: 1 });
  });

  it("gives null for a mean of no value", () => {
    const none = [
      { name: "a-case", repeats: [rm(1, { precision: null }), rm(2, { precision: null })] },
    ];
    const report = buildReport(none, null, null);
    expect(report.repeats.map((r) => r.precision)).toEqual([null, null]);
    expect(report.aggregate.precision).toEqual({ mean: null, min: null, max: null });
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
      recall: 0.5,
      precision: 1,
      findings_per_case: 2,
      cost_per_case: 0.1,
    });
    expect(report.cases[0]?.repeats[1]?.failed).toBe(true);
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
          rm(1, { recall: 1, precision: 0.5, posted: 2, cost_usd: 0.2 }),
          rm(2, { recall: 0.5, precision: 1, posted: 1, cost_usd: 0.4 }),
        ],
      },
      { name: "b-case", repeats: [rm(1), failedMetrics(2, "the run threw", 1)] },
    ],
    null,
    null,
  );
  const text = renderTable(report);

  it("prints one table for each case, with a row for each repeat and the four columns", () => {
    const lines = text.split("\n");
    for (const name of ["a-case", "b-case"]) expect(text).toContain(name);
    const header = lines.find((l) => /recall/.test(l) && /posted/.test(l)) ?? "";
    for (const column of ["repeat", "recall", "precision", "posted", "cost"]) {
      expect(header).toContain(column);
    }
    expect(lines.some((l) => /^\s*1\s+1\.000\s+0\.500\s+2\s+\$0\.2000\s*$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s*2\s+0\.500\s+1\.000\s+1\s+\$0\.4000\s*$/.test(l))).toBe(true);
    expect(text).toContain("the run threw");
  });

  it("prints the mean, the minimum and the maximum of the four aggregate metrics", () => {
    const lines = text.split("\n");
    const header = lines.find((l) => /mean/.test(l) && /min/.test(l) && /max/.test(l));
    expect(header).toBeDefined();
    // Recall per repeat: (1 + 1) / 2 = 1 and 0.5, so the mean is 0.75.
    expect(lines.some((l) => /^recall\s+0\.750\s+0\.500\s+1\.000\s*$/.test(l))).toBe(true);
    expect(lines.some((l) => /^precision\s+0\.875\s+0\.750\s+1\.000\s*$/.test(l))).toBe(true);
    expect(lines.some((l) => /^findings per case\s+1\.250\s+1\.000\s+1\.500\s*$/.test(l))).toBe(
      true,
    );
    expect(
      lines.some((l) => /^cost per case\s+\$0\.2750\s+\$0\.1500\s+\$0\.4000\s*$/.test(l)),
    ).toBe(true);
  });
});
