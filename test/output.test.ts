import { describe, expect, it } from "vitest";
import { formatJson } from "../src/output/json.js";
import { formatTable } from "../src/output/table.js";
import type { Finding, Severity } from "../src/schemas/finding.js";
import type { PostedFinding, RunRecord } from "../src/schemas/record.js";

function posted(
  file: string,
  start: number,
  end: number,
  severity: Severity,
  score: number,
  claim: string,
): PostedFinding {
  const finding: Finding = {
    file,
    start_line: start,
    end_line: end,
    category: severity === "nit" ? "convention" : "bug",
    severity_estimate: severity,
    confidence: "high",
    claim,
    evidence: "e",
    explanation: "x",
    needs_context: false,
  };
  return {
    ...finding,
    fingerprint: "0123456789abcdef",
    severity,
    score,
    verifier: {
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: [],
      rationale: "r",
      score,
      severity,
    },
  };
}

function record(
  findings: PostedFinding[],
  overrides: Partial<RunRecord["posted"]> = {},
): RunRecord {
  return {
    identity: {
      repo: "/repo",
      pr: null,
      base: "a".repeat(40),
      head: "b".repeat(40),
      started_at: "2026-10-13T12:00:00.000Z",
      tool_version: "0.1.0",
      config_hash: null,
      changed_files: [{ path: "src/stats.ts", hunks: 1 }],
      excluded_files: [],
      sensitive_files: [],
      triage: null,
      tier: "full",
      tier_reason: "Triage: New logic in a public function.",
      selected_reviewers: [
        { name: "diff-bugs", trigger: "min_tier fast <= full; paths: any; categories: any" },
      ],
      models: {
        triage: { model: "claude-sonnet-5-5", effort: "medium" },
        reviewer: { model: "claude-opus-5-5", effort: "low" },
        verifier: { model: "claude-sonnet-5-5", effort: "high" },
        "verifier-escalation": { model: "claude-opus-5-5", effort: "high" },
        merge: { model: "claude-sonnet-5-5", effort: "medium" },
        smoke: { model: "claude-sonnet-5-5", effort: "low" },
      },
    },
    stages: { reviewers: [], verifications: [], merges: [], capped: [] },
    posted: {
      verdict: findings.some((f) => f.severity === "blocking")
        ? "would request changes"
        : "would approve",
      coverage: {
        reviewers_ran: ["diff-bugs"],
        reviewers_failed: [],
        findings_dropped_by_failed_verifier: 0,
      },
      findings,
      ...overrides,
    },
    cost: { queries: [], total_cost_usd: 0.4321, stage_ms: {}, errors: [] },
  };
}

const WITH_FINDINGS = record([
  posted(
    "src/stats.ts",
    11,
    11,
    "blocking",
    95,
    "The loop reads one item past the end of the array.",
  ),
  posted("src/format.ts", 3, 7, "suggestion", 84, "The percent rounds before it divides."),
  posted("src/a-very/long/path/name.ts", 120, 120, "nit", 81, "The name hides the unit."),
]);

describe("table output (A10)", () => {
  it("matches the snapshot for a run with findings", () => {
    expect(formatTable(WITH_FINDINGS)).toMatchSnapshot();
  });

  it("matches the snapshot for a run with no findings", () => {
    expect(formatTable(record([]))).toMatchSnapshot();
  });

  it("matches the snapshot for an incomplete run with a failed reviewer and an unknown cost", () => {
    const r = record([], {
      verdict: "incomplete",
      coverage: {
        reviewers_ran: [],
        reviewers_failed: ["diff-bugs"],
        findings_dropped_by_failed_verifier: 2,
      },
    });
    expect(formatTable({ ...r, cost: { ...r.cost, total_cost_usd: null } })).toMatchSnapshot();
  });

  it("shows the tier, the reason, the verdict, the coverage and each finding", () => {
    const text = formatTable(WITH_FINDINGS);
    expect(text).toContain("full");
    expect(text).toContain("Triage: New logic in a public function.");
    expect(text).toContain("would request changes");
    expect(text).toContain("diff-bugs");
    expect(text).toContain("src/stats.ts:11");
    expect(text).toContain("src/format.ts:3-7");
    expect(text).not.toContain("overflow");
  });
});

describe("json output", () => {
  it("is one JSON document that ends with a newline", () => {
    const text = formatJson(WITH_FINDINGS, "/out/r.json");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).findings).toHaveLength(3);
  });
});
