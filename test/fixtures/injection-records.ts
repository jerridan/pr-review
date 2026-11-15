// Stored eval output for the E6 report tests: run records, result files and
// the layout "<runs>/<case>/<repeat>/". No model call is made.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REPO_CONFIG } from "../../src/config/repo-config.js";
import { failedMetrics } from "../../src/eval/metrics.js";
import type { PostedFinding, RunRecord } from "../../src/schemas/record.js";

const SONNET = "claude-sonnet-5-5";

export type PostedParts = {
  file?: string;
  line?: number;
  category?: PostedFinding["category"];
  claim?: string;
  explanation?: string;
  suggested_fix?: string;
  evidence?: string;
  rationale?: string;
};

export function posted(parts: PostedParts = {}): PostedFinding {
  const line = parts.line ?? 4;
  return {
    file: parts.file ?? "src/mean.ts",
    start_line: line,
    end_line: line,
    category: parts.category ?? "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: parts.claim ?? "The mean divides by zero for an empty list.",
    evidence: parts.evidence ?? "return v.reduce((s, x) => s + x, 0) / v.length;",
    suggested_fix: parts.suggested_fix ?? "Return 0 for an empty list.",
    explanation: parts.explanation ?? "An empty list has length 0.",
    needs_context: false,
    fingerprint: "f".repeat(16),
    severity: "blocking",
    score: 90,
    verifier: {
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: ["q"],
      rationale: parts.rationale ?? "The code divides by the length.",
      score: 90,
      severity: "blocking",
    },
    span_text: "s",
  };
}

/** A valid run record that posts "findings". "summary" is the triage summary. */
export function makeRecord(findings: PostedFinding[], summary = "A small change."): RunRecord {
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
      description: "TITLE\n\nBODY",
      description_meta: { source: "pr", sanitized: false, truncated: false },
      history: { built: false, truncated: false },
      injected: [],
      changed_files: [],
      excluded_files: [],
      sensitive_files: [],
      triage: {
        tier: "full",
        reason: "r",
        confidence: "high",
        categories: ["bug"],
        hotspots: [],
        file_notes: [],
        summary,
      },
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
      verifications: findings.map((f) => ({
        finding: {
          file: f.file,
          start_line: f.start_line,
          end_line: f.end_line,
          category: f.category,
          severity_estimate: f.severity_estimate,
          confidence: f.confidence,
          claim: f.claim,
          evidence: f.evidence,
          suggested_fix: f.suggested_fix,
          explanation: f.explanation,
          needs_context: f.needs_context,
        },
        first: f.verifier,
        final: f.verifier,
        passed: true,
      })),
      merges: [],
      capped: [],
      suppressed: [],
      pre_existing: [],
    },
    posted: {
      verdict: findings.length > 0 ? "would request changes" : "would approve",
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

const RECORD_NAME = "2026-10-16T120000.000Z-abcdef0.json";

/** Write one repeat of the eval out layout: result.json and the record. */
export function writeRun(
  runs: string,
  caseName: string,
  repeat: number,
  record: RunRecord | null,
  head = "b".repeat(40),
): void {
  const dir = join(runs, caseName, String(repeat));
  mkdirSync(dir, { recursive: true });
  const metrics =
    record === null
      ? failedMetrics(repeat, "the repeat failed", 1)
      : { ...failedMetrics(repeat, "", 1), failed: false, error: null };
  const result = {
    case: caseName,
    head,
    golden: "g",
    repeat,
    ...(record === null ? {} : { record: RECORD_NAME }),
    tool_version: "0.1.0",
    options: {
      tier: "full",
      judge_model: SONNET,
      extras: false,
      raw_judge: false,
      reviewers: null,
      passes: null,
      paired: false,
    },
    metrics,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  if (record !== null) writeFileSync(join(dir, RECORD_NAME), JSON.stringify(record));
}
