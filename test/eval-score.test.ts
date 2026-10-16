import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import type { GoldenFinding } from "../src/eval/case.js";
import { scoreRecord } from "../src/eval/score.js";
import type { Category, Severity } from "../src/schemas/finding.js";
import { JudgeOutputSchema } from "../src/schemas/judge.js";
import type { PostedFinding, RunRecord } from "../src/schemas/record.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import { buildQueryOptions, type RunOptions } from "../src/sdk/options.js";

const OPTIONS: RunOptions = { allowApiKey: false, env: {} };
const SONNET = "claude-sonnet-5-5";

let head: string;
beforeAll(() => {
  head = mkdtempSync(join(tmpdir(), "pr-review-eval-score-"));
  mkdirSync(join(head, "src"));
  // Line n of each file is "const vn = n;", so a span text names its lines.
  const lines = Array.from({ length: 60 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  writeFileSync(join(head, "src", "a.ts"), `${lines.join("\n")}\n`);
  writeFileSync(join(head, "src", "b.ts"), `${lines.join("\n")}\n`);
});
afterAll(() => rmSync(head, { recursive: true, force: true }));

type PostedParts = {
  category?: Category;
  severity?: Severity;
  claim?: string;
};

function posted(file: string, start: number, end: number, parts: PostedParts = {}): PostedFinding {
  const severity = parts.severity ?? "blocking";
  return {
    file,
    start_line: start,
    end_line: end,
    category: parts.category ?? "bug",
    severity_estimate: severity,
    confidence: "high",
    claim: parts.claim ?? `POSTED-CLAIM-${file}-${start}`,
    evidence: `POSTED-EVIDENCE-${start}`,
    suggested_fix: "POSTED-FIX",
    explanation: "POSTED-EXPLANATION",
    needs_context: false,
    fingerprint: "f".repeat(16),
    severity,
    score: 90,
    verifier: {
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: ["q"],
      rationale: "VERIFIER-RATIONALE",
      score: 90,
      severity,
    },
    span_text: "s",
  };
}

function golden(
  file: string,
  start: number,
  end: number,
  parts: { category?: Category; severity?: Severity; note?: string } = {},
): GoldenFinding {
  return {
    file,
    start_line: start,
    end_line: end,
    category: parts.category ?? "bug",
    severity: parts.severity ?? "blocking",
    claim: `GOLDEN-CLAIM-${file}-${start}`,
    ...(parts.note !== undefined ? { note: parts.note } : {}),
  };
}

function record(findings: PostedFinding[]): RunRecord {
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
      description: "CASE-TITLE-TEXT\n\nCASE-BODY-TEXT",
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
        triage: { model: SONNET, effort: "medium" },
        reviewer: { model: "claude-opus-5-5", effort: "low" },
        verifier: { model: SONNET, effort: "high" },
        "verifier-escalation": { model: "claude-opus-5-5", effort: "high" },
        merge: { model: SONNET, effort: "medium" },
        smoke: { model: SONNET, effort: "low" },
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
    cost: { queries: [], total_cost_usd: 0, queries_without_cost: 0, stage_ms: {}, errors: [] },
  };
}

function meta(costUsd: number | null): QueryMeta {
  return {
    model: SONNET,
    durationMs: 1,
    stopReason: "end_turn",
    subtype: "success",
    usage: {},
    costUsd,
  };
}

type Answer = "yes" | "no" | "unknown" | "fail" | "throw";

/** A fake client whose judge queries give the answers in order. */
function judgeFake(answers: Answer[], costUsd: number | null = 0.01) {
  let next = 0;
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    if (req.role !== "judge") throw new Error(`unexpected role ${req.role}`);
    const answer = answers[next] ?? "no";
    next += 1;
    if (answer === "throw") throw new Error("the judge process crashed");
    if (answer === "fail") {
      return { ok: false, failure: { kind: "limit", message: "budget" }, raw: meta(costUsd) };
    }
    return { ok: true, output: { same_issue: answer, reason: "r" }, raw: meta(costUsd) };
  });
}

function score(
  findings: PostedFinding[],
  goldens: GoldenFinding[],
  fake: ReturnType<typeof judgeFake>,
  model = SONNET,
) {
  return scoreRecord(record(findings), goldens, head, { client: fake, model, options: OPTIONS });
}

// The text of each untrusted block in a message, by label.
function blocks(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of message.matchAll(
    /<([a-z][a-z0-9_]*)_[0-9a-f]{16}>\n([\s\S]*?)\n<\/\1_[0-9a-f]{16}>/g,
  )) {
    out.set(m[1] ?? "", m[2] ?? "");
  }
  return out;
}

describe("scoreRecord: the exact pass (R4.1, R4.6)", () => {
  it("matches each posted finding to its golden finding by position, with no judge query", async () => {
    const fake = judgeFake([]);
    const result = await score(
      [posted("src/b.ts", 40, 41), posted("src/a.ts", 5, 5), posted("src/a.ts", 50, 50)],
      [golden("src/a.ts", 4, 6), golden("src/b.ts", 41, 41), golden("src/b.ts", 1, 1)],
      fake,
    );
    expect(result.matched).toEqual([
      { posted: 0, golden: 1, via: "exact" },
      { posted: 1, golden: 0, via: "exact" },
    ]);
    expect(result.judgeCalls).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("matches one posted finding to only one of two golden findings that both match exactly", async () => {
    const fake = judgeFake([]);
    const result = await score(
      [posted("src/a.ts", 10, 12)],
      [golden("src/a.ts", 10, 10), golden("src/a.ts", 12, 12)],
      fake,
    );
    expect(result.matched).toEqual([{ posted: 0, golden: 0, via: "exact" }]);
  });

  it("matches one golden finding to only one of two posted findings that both match exactly", async () => {
    const result = await score(
      [posted("src/a.ts", 10, 10), posted("src/a.ts", 10, 11)],
      [golden("src/a.ts", 10, 10)],
      judgeFake([]),
    );
    expect(result.matched).toEqual([{ posted: 0, golden: 0, via: "exact" }]);
  });

  it("resolves exact matches before it asks the judge about an earlier ambiguous pair", async () => {
    const fake = judgeFake(["yes"]);
    const result = await score(
      // The first posted finding is near the golden finding, the second overlaps it.
      [posted("src/a.ts", 20, 20), posted("src/a.ts", 12, 12)],
      [golden("src/a.ts", 12, 12)],
      fake,
    );
    expect(result.matched).toEqual([{ posted: 1, golden: 0, via: "exact" }]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("scoreRecord: the judge pass (R4.3, R4.6)", () => {
  const ambiguous = () => ({
    findings: [posted("src/a.ts", 20, 21)],
    goldens: [golden("src/a.ts", 12, 14)],
  });

  it("sends exactly one judge query for one ambiguous pair, and matches on yes", async () => {
    const fake = judgeFake(["yes"]);
    const { findings, goldens } = ambiguous();
    const result = await score(findings, goldens, fake);
    expect(fake.calls.map((c) => c.role)).toEqual(["judge"]);
    expect(result.matched).toEqual([{ posted: 0, golden: 0, via: "judge" }]);
    expect(result.judgeCalls).toBe(1);
    expect(result.judgeUnknown).toBe(0);
  });

  it.each<[Answer, number]>([
    ["no", 0],
    ["unknown", 1],
    ["fail", 1],
    ["throw", 1],
  ])("gives no match for the answer %s, and counts %i unknown", async (answer, unknown) => {
    const fake = judgeFake([answer]);
    const { findings, goldens } = ambiguous();
    const result = await score(findings, goldens, fake);
    expect(fake.calls).toHaveLength(1);
    expect(result.matched).toEqual([]);
    expect(result.judgeCalls).toBe(1);
    expect(result.judgeUnknown).toBe(unknown);
  });

  it("sends one judge query for two ambiguous pairs that share a golden, when the first answer is yes", async () => {
    const fake = judgeFake(["yes", "yes"]);
    const result = await score(
      [posted("src/a.ts", 20, 20), posted("src/a.ts", 4, 4)],
      [golden("src/a.ts", 12, 12)],
      fake,
    );
    expect(fake.calls).toHaveLength(1);
    expect(result.matched).toEqual([{ posted: 0, golden: 0, via: "judge" }]);
  });

  it("asks about the second pair that shares a golden when the first answer is no", async () => {
    const fake = judgeFake(["no", "yes"]);
    const result = await score(
      [posted("src/a.ts", 20, 20), posted("src/a.ts", 4, 4)],
      [golden("src/a.ts", 12, 12)],
      fake,
    );
    expect(fake.calls).toHaveLength(2);
    expect(result.matched).toEqual([{ posted: 1, golden: 0, via: "judge" }]);
  });

  it("asks about a posted finding with two ambiguous goldens in golden order, and stops at yes", async () => {
    const fake = judgeFake(["yes"]);
    const result = await score(
      [posted("src/a.ts", 20, 20)],
      [golden("src/a.ts", 28, 28), golden("src/a.ts", 12, 12)],
      fake,
    );
    expect(fake.calls).toHaveLength(1);
    expect(blocks(fake.calls[0]?.userMessage ?? "").get("golden_finding")).toContain(
      "GOLDEN-CLAIM-src/a.ts-28",
    );
    expect(result.matched).toEqual([{ posted: 0, golden: 0, via: "judge" }]);
  });

  it("sums the cost of every judge query, also a failed one", async () => {
    const fake = judgeFake(["no", "fail"], 0.02);
    const result = await score(
      [posted("src/a.ts", 20, 20), posted("src/a.ts", 4, 4)],
      [golden("src/a.ts", 12, 12)],
      fake,
    );
    expect(result.judgeCostUsd).toBeCloseTo(0.04, 10);
  });

  it("adds no cost for a query without a cost", async () => {
    const result = await score(
      [posted("src/a.ts", 20, 20)],
      [golden("src/a.ts", 12, 12)],
      judgeFake(["no"], null),
    );
    expect(result.judgeCostUsd).toBe(0);
  });
});

describe("scoreRecord: the judge query (R4.4, R4.5)", () => {
  async function judgeCall(model = SONNET): Promise<QueryRequest> {
    const fake = judgeFake(["no"]);
    await score(
      [posted("src/a.ts", 20, 21), posted("src/b.ts", 50, 50, { claim: "OTHER-FINDING-CLAIM" })],
      [golden("src/a.ts", 12, 14, { note: "GOLDEN-NOTE-TEXT", severity: "nit" })],
      fake,
      model,
    );
    expect(fake.calls).toHaveLength(1);
    return fake.calls[0] as QueryRequest;
  }

  it("sends the six posted fields and the golden fields, and no other field", async () => {
    const found = blocks((await judgeCall()).userMessage);
    expect(JSON.parse(found.get("posted_finding") ?? "null")).toEqual({
      file: "src/a.ts",
      start_line: 20,
      end_line: 21,
      category: "bug",
      claim: "POSTED-CLAIM-src/a.ts-20",
      evidence: "POSTED-EVIDENCE-20",
    });
    expect(JSON.parse(found.get("golden_finding") ?? "null")).toEqual({
      file: "src/a.ts",
      start_line: 12,
      end_line: 14,
      category: "bug",
      claim: "GOLDEN-CLAIM-src/a.ts-12",
    });
  });

  it("sends the head file text at the posted span and at the golden span", async () => {
    const found = blocks((await judgeCall()).userMessage);
    const postedSpan = found.get("posted_span") ?? "";
    expect(postedSpan).toContain("const v20 = 20;");
    expect(postedSpan).toContain("const v21 = 21;");
    expect(postedSpan).not.toContain("const v19 = 19;");
    expect(postedSpan).not.toContain("const v22 = 22;");
    const goldenSpan = found.get("golden_span") ?? "";
    for (const n of [12, 13, 14]) expect(goldenSpan).toContain(`const v${n} = ${n};`);
    expect(goldenSpan).not.toContain("const v11 = 11;");
    expect(goldenSpan).not.toContain("const v15 = 15;");
  });

  it("sends no case title, case body, other finding, golden note or other posted field", async () => {
    const call = await judgeCall();
    const everything = `${call.systemPrompt}\n${call.userMessage}`;
    for (const absent of [
      "CASE-TITLE-TEXT",
      "CASE-BODY-TEXT",
      "OTHER-FINDING-CLAIM",
      "GOLDEN-NOTE-TEXT",
      "POSTED-EXPLANATION",
      "POSTED-FIX",
      "VERIFIER-RATIONALE",
      "diff --git",
    ]) {
      expect(everything).not.toContain(absent);
    }
  });

  it("sends the judge model of the caller, at effort high, with no tool and a positive budget", async () => {
    const options = buildQueryOptions(await judgeCall("claude-haiku-5-5"), OPTIONS);
    expect(options.model).toBe("claude-haiku-5-5");
    expect(options.effort).toBe("high");
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.maxBudgetUsd).toBeGreaterThan(0);
  });

  it("gives a judge query Sonnet 5.5 at effort high, no tool, a turn limit and a budget by default", () => {
    const options = buildQueryOptions(
      { role: "judge", systemPrompt: "s", userMessage: "u", schema: JudgeOutputSchema, cwd: head },
      OPTIONS,
    );
    expect(options.model).toBe(SONNET);
    expect(options.effort).toBe("high");
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBeGreaterThan(0);
    expect(options.maxBudgetUsd).toBeGreaterThan(0);
  });
});

describe("scoreRecord: severity agreement (R4.7)", () => {
  it("gives 1 of 1 for a matched pair with the same severity", async () => {
    const result = await score(
      [posted("src/a.ts", 10, 10, { severity: "suggestion" })],
      [golden("src/a.ts", 10, 10, { severity: "suggestion" })],
      judgeFake([]),
    );
    expect(result.severityAgreement).toEqual({ same: 1, matched: 1 });
  });

  it("gives 0 of 1 when the golden severity changes, and keeps the match", async () => {
    const result = await score(
      [posted("src/a.ts", 10, 10, { severity: "suggestion" })],
      [golden("src/a.ts", 10, 10, { severity: "blocking" })],
      judgeFake([]),
    );
    expect(result.severityAgreement).toEqual({ same: 0, matched: 1 });
    expect(result.matched).toEqual([{ posted: 0, golden: 0, via: "exact" }]);
  });

  it("counts a pair that the judge matched", async () => {
    const result = await score(
      [posted("src/a.ts", 20, 20, { severity: "nit" })],
      [golden("src/a.ts", 12, 12, { severity: "nit" })],
      judgeFake(["yes"]),
    );
    expect(result.severityAgreement).toEqual({ same: 1, matched: 1 });
  });
});
