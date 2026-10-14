import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
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
    span_text: "e",
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

const EXCLUDED: RunRecord["identity"]["excluded_files"] = [
  { path: "package-lock.json", reason: "generated" },
  { path: "src/old-name.ts", reason: "rename-only" },
];

function record(
  findings: PostedFinding[],
  overrides: Partial<RunRecord["posted"]> = {},
  excluded: RunRecord["identity"]["excluded_files"] = EXCLUDED,
): RunRecord {
  return {
    identity: {
      repo: "/repo",
      pr: null,
      github: null,
      base: "a".repeat(40),
      head: "b".repeat(40),
      started_at: "2026-10-13T12:00:00.000Z",
      tool_version: "0.1.0",
      config_hash: null,
      config: { files: [], values: DEFAULT_REPO_CONFIG, custom_reviewers: [] },
      description: "Fix the loop bound.",
      description_meta: { source: "commits", sanitized: false, truncated: false },
      history: { built: true, truncated: false },
      injected: [{ path: "CLAUDE.md", truncated: false }],
      changed_files: [{ path: "src/stats.ts", hunks: 1 }],
      excluded_files: excluded,
      sensitive_files: [],
      triage: null,
      tier: "full",
      tier_reason: "Triage: New logic in a public function.",
      selected_reviewers: [
        {
          name: "diff-bugs",
          trigger: "min_tier fast <= full; paths: any; categories: any",
          model: "claude-opus-5-5",
          effort: "low",
          tools_ignored: [],
        },
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
    stages: {
      reviewers: [],
      verifications: [],
      merges: [],
      capped: [],
      suppressed: [],
      pre_existing: [],
    },
    posted: {
      verdict: findings.some((f) => f.severity === "blocking")
        ? "would request changes"
        : "would approve",
      coverage: {
        reviewers_ran: ["diff-bugs"],
        reviewers_failed: [],
        reviewers_skipped: [],
        reviewers_without_bash: [],
        sensitive_without_hunks: [],
        findings_dropped_by_failed_verifier: 0,
      },
      findings,
      github: null,
      ...overrides,
    },
    cost: {
      queries: [],
      total_cost_usd: 0.4321,
      queries_without_cost: 0,
      stage_ms: {},
      errors: [],
    },
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
        reviewers_skipped: [],
        reviewers_without_bash: [],
        sensitive_without_hunks: [],
        findings_dropped_by_failed_verifier: 2,
      },
    });
    expect(
      formatTable({ ...r, cost: { ...r.cost, total_cost_usd: null, queries_without_cost: 3 } }),
    ).toMatchSnapshot();
  });

  it("marks the total as a lower bound when a query has no cost", () => {
    const r = record([]);
    expect(formatTable({ ...r, cost: { ...r.cost, queries_without_cost: 2 } })).toContain(
      "Cost: at least $0.4321 (2 queries without a cost)\n",
    );
    expect(formatTable({ ...r, cost: { ...r.cost, queries_without_cost: 1 } })).toContain(
      "Cost: at least $0.4321 (1 query without a cost)\n",
    );
    expect(formatTable(r)).toContain("Cost: $0.4321\n");
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

  it("shows the skipped reviewers, the reviewers without Bash and the sensitive paths without hunks", () => {
    const r = record([]);
    const coverage = {
      ...r.posted.coverage,
      reviewers_skipped: [
        { name: "diff-bugs", reason: "disabled by config" as const },
        { name: "security", reason: "token ceiling" as const, pass: 2 },
      ],
      reviewers_without_bash: [{ name: "shell-check", reason: "not trusted" }],
      sensitive_without_hunks: [".github/workflows/ci.yml"],
    };
    const text = formatTable({ ...r, posted: { ...r.posted, coverage } });
    expect(text).toContain(
      "reviewers skipped: diff-bugs (disabled by config), security (token ceiling, pass 2)",
    );
    expect(text).toContain("reviewers without Bash: shell-check (not trusted)");
    expect(text).toContain("sensitive paths without hunks: .github/workflows/ci.yml");
    expect(formatTable(r)).toContain(
      "reviewers skipped: none; reviewers without Bash: none; sensitive paths without hunks: none;",
    );
  });

  it("shows each excluded file with its reason", () => {
    expect(formatTable(WITH_FINDINGS)).toContain(
      "Excluded files: package-lock.json (generated), src/old-name.ts (rename-only)\n",
    );
    expect(formatTable(record([], {}, []))).toContain("Excluded files: none\n");
  });
});

describe("json output", () => {
  it("is one JSON document that ends with a newline", () => {
    const text = formatJson(WITH_FINDINGS, "/out/r.json");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).findings).toHaveLength(3);
  });

  it("holds the total cost and the count of the queries without a cost", () => {
    const r = record([]);
    const doc = JSON.parse(
      formatJson({ ...r, cost: { ...r.cost, queries_without_cost: 2 } }, "/out/r.json"),
    );
    expect(doc.total_cost_usd).toBe(0.4321);
    expect(doc.queries_without_cost).toBe(2);
    const unknown = JSON.parse(
      formatJson(
        { ...r, cost: { ...r.cost, total_cost_usd: null, queries_without_cost: 3 } },
        "/out/r.json",
      ),
    );
    expect(unknown.total_cost_usd).toBeNull();
    expect(unknown.queries_without_cost).toBe(3);
  });

  it("holds the skipped reviewers in its coverage", () => {
    const r = record([]);
    const skipped = [{ name: "diff-bugs", reason: "disabled by config" as const }];
    const doc = JSON.parse(
      formatJson(
        {
          ...r,
          posted: { ...r.posted, coverage: { ...r.posted.coverage, reviewers_skipped: skipped } },
        },
        "/out/r.json",
      ),
    );
    expect(doc.coverage.reviewers_skipped).toEqual(skipped);
  });

  it("holds the custom reviewers that ran without Bash in its coverage", () => {
    const r = record([]);
    const withoutBash = [{ name: "shell-check", reason: "not trusted" }];
    const coverage = { ...r.posted.coverage, reviewers_without_bash: withoutBash };
    const doc = JSON.parse(formatJson({ ...r, posted: { ...r.posted, coverage } }, "/out/r.json"));
    expect(doc.coverage.reviewers_without_bash).toEqual(withoutBash);
  });

  it("holds the sensitive paths without hunks in its coverage", () => {
    const r = record([]);
    const paths = ["bin/run", "assets/key.bin"];
    const coverage = { ...r.posted.coverage, sensitive_without_hunks: paths };
    const doc = JSON.parse(formatJson({ ...r, posted: { ...r.posted, coverage } }, "/out/r.json"));
    expect(doc.coverage.sensitive_without_hunks).toEqual(paths);
    expect(Object.keys(doc.coverage).sort()).toEqual([
      "findings_dropped_by_failed_verifier",
      "reviewers_failed",
      "reviewers_ran",
      "reviewers_skipped",
      "reviewers_without_bash",
      "sensitive_without_hunks",
    ]);
  });

  it("holds the excluded files with their reasons", () => {
    expect(JSON.parse(formatJson(WITH_FINDINGS, "/out/r.json")).excluded_files).toEqual(EXCLUDED);
    expect(JSON.parse(formatJson(record([], {}, []), "/out/r.json")).excluded_files).toEqual([]);
  });
});
