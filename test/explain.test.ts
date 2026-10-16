import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { DEFAULT_REPO_CONFIG, type RepoConfig } from "../src/config/repo-config.js";
import { explain, type ExplainRow } from "../src/explain/index.js";
import { runReview } from "../src/run.js";
import type { Category, Finding } from "../src/schemas/finding.js";
import { RecordSchema, type PostedFinding, type RunRecord } from "../src/schemas/record.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const FIXTURE_SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));
const MAKE_CASE = fileURLToPath(new URL("../scripts/make-case.sh", import.meta.url));
const PRE_D4A = fileURLToPath(new URL("./fixtures/record-pre-d4a.json", import.meta.url));
const RUN_TIMEOUT = 120_000;

type Fixture = { repo: string; base: string; head: string; file: string; line: number };

async function makeFixture(...options: string[]): Promise<Fixture> {
  const { stdout } = await run("bash", [FIXTURE_SCRIPT, ...options]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  const [file, line] = value("PLANTED").split(":");
  return {
    repo: value("FIXTURE"),
    base: value("BASE"),
    head: value("HEAD"),
    file: file ?? "",
    line: Number(line),
  };
}

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pr-review-explain-"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

let stdout = "";
let stderr = "";
beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function exitCodeOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function explainCli(...args: string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return exitCodeOf(
    createProgram({ client: createFakeSdkClient(() => fail()) }).parseAsync([
      "node",
      "pr-review",
      "explain",
      ...args,
    ]),
  );
}

function fail(): never {
  throw new Error("explain makes no query");
}

type JsonEntry = Record<string, unknown> & { stage: string; outcome: string; reason: string };

async function explainJson(path: string): Promise<JsonEntry[]> {
  const code = await explainCli(path, "--format", "json");
  expect(code, stderr).toBe(0);
  return (JSON.parse(stdout) as { findings: JsonEntry[] }).findings;
}

describe("pr-review explain on a review with one finding of each outcome (R10.5, R7.2 to R7.5)", () => {
  // The planted bug, line 11 of src/stats.ts, is reported by two reviewers.
  // Merge keeps one copy. Line 3 is code that the change did not touch.
  const QUOTES = [
    "i <= values.length",
    "i < values.length",
    "name: ci",
    "runs-on: ubuntu-latest",
    "- run: npm test",
    "return total / values.length;",
  ];
  const LOW_CLAIM = "CLAIM-LOWSCORE the mean\nis wrong for an empty list";
  let fx: Fixture;
  let recordPath: string;

  function finding(
    file: string,
    line: number,
    category: Category,
    claim: string,
    evidence: string,
  ): Finding {
    return {
      file,
      start_line: line,
      end_line: line,
      category,
      severity_estimate: "blocking",
      confidence: "high",
      claim,
      evidence,
      explanation: "e",
      needs_context: false,
    };
  }

  beforeAll(async () => {
    const source = mkdtempSync(join(tmpdir(), "pr-review-explain-config-"));
    try {
      mkdirSync(join(source, "dir"));
      writeFileSync(
        join(source, "dir", "config.yaml"),
        [
          "suppressions:",
          "  - category: performance",
          '    reason: "SUPPRESS-RULE: CI speed is out of scope"',
          "caps:",
          "  non_blocking_base: 1",
          "  non_blocking_per_hunks: 100",
          "  non_blocking_max: 1",
          "",
        ].join("\n"),
      );
      fx = await makeFixture("--pr-review-dir", join(source, "dir"));
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
    const ci = ".github/workflows/ci.yml";
    const loop = "for (let i = 0; i <= values.length; i++) {";
    const conventions: Finding[] = [
      finding(fx.file, fx.line, "bug", "CLAIM-PLANTED", loop),
      finding(fx.file, 14, "bug", LOW_CLAIM, "return total / values.length;"),
      finding(fx.file, 12, "bug", "CLAIM-BADQUOTE", "THIS TEXT IS NOT IN THE FILE"),
      finding(ci, 8, "performance", "CLAIM-SUPPRESSED", "- run: npm test"),
      finding(ci, 1, "convention", "CLAIM-SUGGEST-A", "name: ci"),
      finding(ci, 5, "convention", "CLAIM-SUGGEST-B", "runs-on: ubuntu-latest"),
      finding(fx.file, 3, "bug", "CLAIM-PREEXISTING", "for (let i = 0; i < values.length; i++) {"),
    ];
    const tests: Finding[] = [finding(fx.file, fx.line, "bug", "CLAIM-DUP", loop)];
    const meta: QueryMeta = {
      model: "m",
      durationMs: 1,
      stopReason: "end_turn",
      subtype: "success",
      usage: {},
      costUsd: 0.01,
    };
    const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: meta });
    const verdict = (parts: Partial<VerifierResult>): QueryOutcome<unknown> =>
      out({
        in_scope: true,
        claim_holds: true,
        introduced_by_pr: true,
        quotes: QUOTES,
        rationale: "r",
        score: 95,
        severity: "blocking",
        ...parts,
      });
    const fake = createFakeSdkClient((req: QueryRequest) => {
      switch (req.role) {
        case "triage":
          return out({
            tier: "full",
            reason: "r",
            confidence: "high",
            categories: ["bug"],
            hotspots: [],
            file_notes: [],
            summary: "s",
          });
        case "reviewer":
          if (req.reviewerName === "conventions") return out({ findings: conventions });
          if (req.reviewerName === "tests") return out({ findings: tests });
          return out({ findings: [] });
        case "verifier":
        case "verifier-escalation": {
          const m = req.userMessage;
          if (m.includes("CLAIM-LOWSCORE")) return verdict({ score: 50 });
          if (m.includes("CLAIM-PREEXISTING")) {
            return verdict({ in_scope: false, introduced_by_pr: false });
          }
          if (m.includes("CLAIM-SUGGEST-A")) return verdict({ score: 92, severity: "suggestion" });
          if (m.includes("CLAIM-SUGGEST-B")) return verdict({ score: 91, severity: "suggestion" });
          return verdict({});
        }
        case "merge":
          return out({
            merged: [
              { member_index: 0, claim: "CLAIM-MERGED", explanation: "e", severity: "blocking" },
            ],
          });
        default:
          throw new Error(`unexpected role ${req.role}`);
      }
    });
    const result = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(work, "records"),
      format: "json",
      tierOverride: "full",
      allowApiKey: false,
      client: fake,
    });
    recordPath = result.recordPath;
  }, RUN_TIMEOUT);

  afterAll(() => {
    if (fx) rmSync(fx.repo, { recursive: true, force: true });
  });

  const claimOf = (e: JsonEntry) => String(e.claim ?? "");

  it("gives one row per distinct finding, with the stage, the outcome and the exact reason", async () => {
    const entries = await explainJson(recordPath);
    expect(entries).toHaveLength(8);
    const byClaim = new Map(entries.map((e) => [claimOf(e), e]));
    const expectRow = (claim: string, stage: string, outcome: string, reason: string) => {
      const entry = byClaim.get(claim);
      expect(entry, claim).toBeDefined();
      expect([entry?.stage, entry?.outcome, entry?.reason], claim).toEqual([
        stage,
        outcome,
        reason,
      ]);
    };
    expectRow("CLAIM-MERGED", "post", "kept", "posted as blocking");
    expectRow(
      LOW_CLAIM,
      "verify",
      "dropped",
      "verifier scored 50, below a threshold of at least 80",
    );
    expectRow(
      "CLAIM-BADQUOTE",
      "reviewer",
      "dropped",
      "dropped by the reviewer quote check: bad-quote",
    );
    expectRow(
      "CLAIM-SUPPRESSED",
      "suppress",
      "dropped",
      "suppressed by rule SUPPRESS-RULE: CI speed is out of scope",
    );
    expectRow("CLAIM-SUGGEST-A", "post", "kept", "posted as suggestion");
    expectRow("CLAIM-SUGGEST-B", "cap", "dropped", "capped: over the non-blocking cap");
    expectRow("CLAIM-PREEXISTING", "scope", "dropped", "pre-existing: out of scope");

    // Merge kept one of the two reports of the planted bug.
    const duplicate = entries.find((e) => e.stage === "merge");
    expect(["CLAIM-PLANTED", "CLAIM-DUP"]).toContain(String(duplicate?.claim ?? ""));
    expect(duplicate).toMatchObject({
      outcome: "dropped",
      reason: "merged into group 0 as a duplicate",
    });
    const merged = byClaim.get("CLAIM-MERGED");
    expect([merged?.reviewer, duplicate?.reviewer].sort()).toEqual(["conventions", "tests"]);
  });

  it("gives each entry the reviewer, the pass and the raw fields of the finding", async () => {
    const entries = await explainJson(recordPath);
    const suggest = entries.find((e) => e.claim === "CLAIM-SUGGEST-B");
    expect(suggest).toMatchObject({
      reviewer: "conventions",
      pass: 1,
      file: ".github/workflows/ci.yml",
      start_line: 5,
      end_line: 5,
      category: "convention",
      evidence: "runs-on: ubuntu-latest",
      severity: "suggestion",
    });
    expect(typeof suggest?.fingerprint).toBe("string");
  });

  it("prints a table by default, with the seven items on one line for each finding", async () => {
    const code = await explainCli(recordPath);
    expect(code, stderr).toBe(0);
    const lines = stdout.split("\n");
    const row = (text: string) => lines.filter((l) => l.includes(text));
    const header = lines[0] ?? "";
    for (const column of [
      "reviewer",
      "pass",
      "location",
      "category",
      "claim",
      "stage",
      "outcome",
      "reason",
    ]) {
      expect(header).toContain(column);
    }
    const [suggest] = row("CLAIM-SUGGEST-B");
    expect(suggest).toMatch(
      /conventions\s+1\s+\.github\/workflows\/ci\.yml:5-5\s+convention\s+CLAIM-SUGGEST-B\s+cap\s+dropped\s+capped: over the non-blocking cap/,
    );
    // The claim of two lines shows on one line.
    const low = row("CLAIM-LOWSCORE");
    expect(low).toHaveLength(1);
    expect(low[0]).toContain("CLAIM-LOWSCORE the mean is wrong");
    expect(low[0]).toContain("verifier scored 50, below a threshold of at least 80");
    expect(row("is wrong for an empty list").every((l) => l.includes("CLAIM-LOWSCORE"))).toBe(true);
    // One header line and one line for each of the eight findings.
    expect(lines.filter((l) => l.trim() !== "")).toHaveLength(9);
  });
});

// Hand-made records for the reasons that the review above does not make.

const HEAD = "b".repeat(40);

function finding(line: number, claim = `CLAIM-${line}`, category: Category = "bug"): Finding {
  return {
    file: "src/a.ts",
    start_line: line,
    end_line: line,
    category,
    severity_estimate: "blocking",
    confidence: "high",
    claim,
    evidence: "e",
    explanation: "x",
    needs_context: false,
  };
}

function result(parts: Partial<VerifierResult> = {}): VerifierResult {
  return {
    in_scope: true,
    claim_holds: true,
    introduced_by_pr: true,
    quotes: ["q"],
    rationale: "r",
    score: 95,
    severity: "blocking",
    ...parts,
  };
}

function posted(
  f: Finding,
  fingerprint: string,
  parts: Partial<PostedFinding> = {},
): PostedFinding {
  return {
    ...f,
    fingerprint,
    severity: "blocking",
    score: 95,
    verifier: result(),
    span_text: "s",
    ...parts,
  };
}

type Verification = RunRecord["stages"]["verifications"][number];

function verified(f: Finding, parts: Partial<Verification> = {}): Verification {
  const r = result();
  return { finding: f, first: r, final: r, passed: true, ...parts };
}

function reviewer(name: string, findings: Finding[], pass = 1) {
  return { name, pass, status: "ok" as const, findings, dropped: [], meta: null };
}

type Parts = {
  reviewers?: RunRecord["stages"]["reviewers"];
  verifications?: Verification[];
  merges?: RunRecord["stages"]["merges"];
  capped?: PostedFinding[];
  suppressed?: RunRecord["stages"]["suppressed"];
  preExisting?: PostedFinding[];
  posted?: PostedFinding[];
  belowFloor?: PostedFinding[];
  notReposted?: RunRecord["posted"]["not_reposted"];
  carried?: PostedFinding[];
  config?: Partial<RepoConfig>;
};

function record(parts: Parts): RunRecord {
  const rec: RunRecord = {
    identity: {
      repo: "/repo",
      pr: null,
      github: null,
      run_kind: "first",
      prior: null,
      base: "a".repeat(40),
      head: HEAD,
      started_at: "2026-10-16T12:00:00.000Z",
      tool_version: "0.1.0",
      config_hash: null,
      config: {
        files: [],
        values: { ...DEFAULT_REPO_CONFIG, ...parts.config },
        custom_reviewers: [],
      },
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
        triage: { model: "claude-sonnet-5-5", effort: "medium" },
        reviewer: { model: "claude-opus-5-5", effort: "low" },
        verifier: { model: "claude-sonnet-5-5", effort: "high" },
        "verifier-escalation": { model: "claude-opus-5-5", effort: "high" },
        merge: { model: "claude-sonnet-5-5", effort: "medium" },
        smoke: { model: "claude-sonnet-5-5", effort: "low" },
      },
    },
    stages: {
      reviewers: parts.reviewers ?? [],
      verifications: parts.verifications ?? [],
      merges: parts.merges ?? [],
      capped: parts.capped ?? [],
      suppressed: parts.suppressed ?? [],
      pre_existing: parts.preExisting ?? [],
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
      findings: parts.posted ?? [],
      github: null,
      below_floor: parts.belowFloor ?? [],
      not_reposted: parts.notReposted ?? [],
      carried: parts.carried ?? [],
    },
    cost: { queries: [], total_cost_usd: 0, queries_without_cost: 0, stage_ms: {}, errors: [] },
  };
  expect(RecordSchema.safeParse(rec).error).toBeUndefined();
  return rec;
}

/** The rows of a record with one reviewer "r" that reports each finding in "findings". */
function rowsOf(findings: Finding[], parts: Parts): ExplainRow[] {
  return explain(record({ reviewers: [reviewer("r", findings)], ...parts }));
}

const brief = (row: ExplainRow | undefined) =>
  row && { stage: row.stage, outcome: row.outcome, reason: row.reason };

describe("explain: the reviewer stage (R7.4)", () => {
  it("names the out-of-range quote check", () => {
    const f = finding(1);
    const rows = explain(
      record({
        reviewers: [{ ...reviewer("r", []), dropped: [{ finding: f, reason: "out-of-range" }] }],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reviewer: "r",
      pass: 1,
      stage: "reviewer",
      outcome: "dropped",
      reason: "dropped by the reviewer quote check: out-of-range",
    });
  });

  it("names a duplicate fingerprint for a reviewer finding with no verification", () => {
    const rows = rowsOf([finding(1), finding(2)], { verifications: [verified(finding(1))] });
    const lone = rows.find((r) => r.claim === "CLAIM-2");
    expect(brief(lone)).toEqual({
      stage: "reviewer",
      outcome: "dropped",
      reason: "not verified: a duplicate fingerprint in the same run",
    });
  });

  it("names both reviewers in one row when two reviewer entries hold equal findings", () => {
    const f = finding(1);
    const rows = explain(
      record({
        reviewers: [reviewer("first", [f]), reviewer("second", [f], 2)],
        verifications: [
          verified(f, {
            first: result({ score: 10 }),
            final: result({ score: 10 }),
            passed: false,
          }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewer).toBe("first, second");
    expect(rows[0]?.pass).toBe(1);
  });
});

describe("explain: the verify stage (R7.4)", () => {
  const dropped = (first: Verification["first"], parts: Partial<Verification> = {}): Verification =>
    verified(finding(1), {
      first,
      final: "kind" in first ? null : first,
      passed: false,
      ...parts,
    });

  it.each<[string, Verification, string]>([
    ["a failed call", dropped({ kind: "timeout", message: "m" }), "verifier call failed: timeout"],
    [
      "scope before the claim",
      dropped(result({ in_scope: false, claim_holds: false, score: 30 })),
      "verifier: out of scope, scored 30",
    ],
    [
      "the claim before the score",
      dropped(result({ claim_holds: false, score: 30 })),
      "verifier: the claim does not hold, scored 30",
    ],
    [
      "the score",
      dropped(result({ score: 79 })),
      "verifier scored 79, below a threshold of at least 80",
    ],
    [
      "the quote",
      dropped(result({ score: 90 }), { rejected: "No quote of the verifier is in the head file." }),
      "verifier rejected: No quote of the verifier is in the head file.",
    ],
    [
      "an escalated score",
      dropped(result({ score: 70 }), {
        escalated: result({ score: 65 }),
        final: result({ score: 65 }),
      }),
      "escalated, verifier scored 65, below a threshold of at least 80",
    ],
    [
      "an escalated call that failed",
      dropped(result({ score: 70 }), {
        escalated: { kind: "limit", message: "m" },
        final: null,
      }),
      "escalated, verifier call failed: limit",
    ],
    [
      "an escalated claim",
      dropped(result({ score: 70 }), {
        escalated: result({ claim_holds: false, score: 90 }),
        final: result({ claim_holds: false, score: 90 }),
      }),
      "escalated, verifier: the claim does not hold, scored 90",
    ],
  ])("names %s", (_label, verification, reason) => {
    const rows = rowsOf([finding(1)], { verifications: [verification] });
    expect(rows).toHaveLength(1);
    expect(brief(rows[0])).toEqual({ stage: "verify", outcome: "dropped", reason });
    expect(rows[0]).toMatchObject({ reviewer: "r", pass: 1 });
  });

  it("names the threshold that the config sets for the reviewer", () => {
    const rows = rowsOf([finding(1)], {
      verifications: [
        verified(finding(1), {
          first: result({ score: 82 }),
          final: result({ score: 82 }),
          passed: false,
        }),
      ],
      config: { reviewers: { r: { enabled: true, threshold: 85 } } },
    });
    expect(rows[0]?.reason).toBe("verifier scored 82, below the threshold 85");
  });

  it("names the default threshold of the config", () => {
    const rows = rowsOf([finding(1)], {
      verifications: [
        verified(finding(1), {
          first: result({ score: 60 }),
          final: result({ score: 60 }),
          passed: false,
        }),
      ],
      config: { thresholds: { default: 70, middle_band: [60, 85] } },
    });
    expect(rows[0]?.reason).toBe("verifier scored 60, below a threshold of at least 70");
  });

  it("gives no later stage for a passed verification with no later copy", () => {
    const rows = rowsOf([finding(1)], { verifications: [verified(finding(1))] });
    expect(brief(rows[0])).toEqual({
      stage: "verify",
      outcome: "dropped",
      reason: "no later stage in the record",
    });
  });
});

describe("explain: suppress, merge and cap (R7.3, R7.4)", () => {
  it("ties a merge group index to the passed verifications that no rule suppressed", () => {
    // Verification 1 does not pass and verification 2 is suppressed, so the
    // merge index space is [0, 3, 4]: group [1, 2] means verifications 3 and 4.
    const fs = [
      finding(1),
      finding(2),
      finding(3),
      finding(10, "CLAIM-10a"),
      finding(10, "CLAIM-10b"),
    ];
    const rows = rowsOf(fs, {
      verifications: [
        verified(fs[0] as Finding),
        verified(fs[1] as Finding, {
          first: result({ score: 5 }),
          final: result({ score: 5 }),
          passed: false,
        }),
        verified(fs[2] as Finding),
        verified(fs[3] as Finding),
        verified(fs[4] as Finding),
      ],
      suppressed: [
        { finding: fs[2] as Finding, reviewer: "r", rule: { category: "bug", reason: "RULE" } },
      ],
      merges: [
        {
          group: [1, 2],
          result: {
            merged: [
              { member_index: 1, claim: "CLAIM-MERGED", explanation: "e", severity: "blocking" },
            ],
          },
        },
      ],
      posted: [posted(finding(1), "f1"), posted({ ...finding(10), claim: "CLAIM-MERGED" }, "f10")],
    });
    expect(rows.map((r) => [r.claim, r.stage, r.reason])).toEqual([
      ["CLAIM-1", "post", "posted as blocking"],
      ["CLAIM-2", "verify", "verifier scored 5, below a threshold of at least 80"],
      ["CLAIM-3", "suppress", "suppressed by rule RULE"],
      ["CLAIM-10a", "merge", "merged into group 0 as a duplicate"],
      ["CLAIM-MERGED", "post", "posted as blocking"],
    ]);
    expect(rows[4]?.finding).toMatchObject({ claim: "CLAIM-MERGED", fingerprint: "f10" });
  });

  it("names the group index G of a later merge entry", () => {
    const fs = [finding(1, "A"), finding(1, "B"), finding(5, "C"), finding(5, "D")];
    const merged = (claim: string) => ({
      merged: [{ member_index: 0, claim, explanation: "e", severity: "blocking" as const }],
    });
    const rows = rowsOf(fs, {
      verifications: fs.map((f) => verified(f)),
      merges: [
        { group: [0, 1], result: merged("AB") },
        { group: [2, 3], result: merged("CD") },
      ],
      posted: [
        posted({ ...finding(1), claim: "AB" }, "f1"),
        posted({ ...finding(5), claim: "CD" }, "f5"),
      ],
    });
    expect(rows.find((r) => r.claim === "D")?.reason).toBe("merged into group 1 as a duplicate");
    expect(rows.find((r) => r.claim === "B")?.reason).toBe("merged into group 0 as a duplicate");
  });

  it("appends the failure kind of a merge query to the rows of its members", () => {
    const fs = [finding(1, "A"), finding(1, "B")];
    const rows = rowsOf(fs, {
      verifications: fs.map((f) => verified(f)),
      merges: [{ group: [0, 1], result: { kind: "limit", message: "budget" } }],
      posted: [posted(fs[0] as Finding, "fa"), posted(fs[1] as Finding, "fb")],
    });
    expect(rows.map((r) => r.reason)).toEqual([
      "posted as blocking; merge query failed: limit",
      "posted as blocking; merge query failed: limit",
    ]);
  });

  it("appends the rejected text of a merge to the rows of its members", () => {
    const fs = [finding(1, "A"), finding(1, "B")];
    const rows = rowsOf(fs, {
      verifications: fs.map((f) => verified(f)),
      merges: [
        {
          group: [0, 1],
          result: { merged: [] },
          rejected: "The merge result has no findings.",
        },
      ],
      posted: [posted(fs[0] as Finding, "fa")],
      capped: [posted(fs[1] as Finding, "fb", { severity: "nit" })],
    });
    expect(rows.map((r) => [r.stage, r.reason])).toEqual([
      ["post", "posted as blocking; merge rejected: The merge result has no findings."],
      [
        "cap",
        "capped: over the non-blocking cap; merge rejected: The merge result has no findings.",
      ],
    ]);
  });
});

describe("explain: scope and post (R7.3, R7.4)", () => {
  const outOfScope = (f: Finding, score = 95): Verification =>
    verified(f, {
      first: result({ in_scope: false, score }),
      final: result({ in_scope: false, score }),
      passed: false,
    });

  it("keeps a pre-existing finding when the config comments on them", () => {
    const f = finding(3);
    const rows = rowsOf([f], {
      verifications: [outOfScope(f)],
      preExisting: [posted(f, "fp")],
      config: { pre_existing: "comment" },
    });
    expect(rows).toHaveLength(1);
    expect(brief(rows[0])).toEqual({
      stage: "scope",
      outcome: "kept",
      reason: "pre-existing: out of scope",
    });
  });

  it("names the checks that can remove a pre-existing candidate that stages.pre_existing does not hold", () => {
    const f = finding(3);
    const rows = rowsOf([f], {
      verifications: [outOfScope(f)],
      config: { pre_existing: "comment" },
    });
    expect(brief(rows[0])).toEqual({
      stage: "scope",
      outcome: "dropped",
      reason:
        "pre-existing candidate, not kept: a failed quote, a suppression, a dismissal or a duplicate fingerprint",
    });
  });

  it("keeps the verify reason for an out-of-scope verification below the threshold", () => {
    const f = finding(3);
    const rows = rowsOf([f], {
      verifications: [outOfScope(f, 40)],
      config: { pre_existing: "comment" },
    });
    expect(rows[0]?.reason).toBe("verifier: out of scope, scored 40");
  });

  it("names the floor of a later run", () => {
    const f = finding(1);
    const rows = rowsOf([f], {
      verifications: [verified(f)],
      belowFloor: [posted(f, "fp", { severity: "suggestion" })],
    });
    expect(brief(rows[0])).toEqual({
      stage: "post",
      outcome: "dropped",
      reason: "not posted: below the floor of a later run",
    });
  });

  it.each<["open" | "dismissed"]>([["open"], ["dismissed"]])(
    "gives a fingerprint %s that ties to nothing its own row, apart from the verification",
    (reason) => {
      const f = finding(1);
      const rows = rowsOf([f], {
        verifications: [verified(f)],
        notReposted: [{ fingerprint: "deadbeefdeadbeef", reason }],
      });
      expect(rows).toHaveLength(2);
      expect(brief(rows[0])).toEqual({
        stage: "verify",
        outcome: "dropped",
        reason: "no later stage in the record",
      });
      expect(rows[1]).toMatchObject({
        reviewer: null,
        pass: null,
        file: null,
        span: null,
        category: null,
        claim: null,
        fingerprint: "deadbeefdeadbeef",
        stage: "post",
        outcome: "dropped",
        reason: `not posted: fingerprint ${reason}`,
      });
    },
  );

  it("shows a carried finding with an unknown reviewer and pass", () => {
    const rows = explain(record({ carried: [posted(finding(7), "fc")] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reviewer: null,
      pass: null,
      file: "src/a.ts",
      span: [7, 7],
      fingerprint: "fc",
      stage: "post",
      outcome: "kept",
      reason: "carried from an earlier run",
    });
  });

  it("ties a fingerprint open to the carried finding with that fingerprint", () => {
    const rows = explain(
      record({
        carried: [posted(finding(7), "fc")],
        notReposted: [{ fingerprint: "fc", reason: "open" }],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("carried from an earlier run; not posted: fingerprint open");
  });
});

describe("pr-review explain: the command (R7.1, R7.5, R7.6, R7.7, R3.7)", () => {
  it.each<[string, string | null]>([
    ["text that is not JSON", "{ not json"],
    ["an empty object", "{}"],
    ["a missing path", null],
  ])("exits 2 with a message for %s", async (_label, text) => {
    const path = join(work, `bad-${Math.random().toString(16).slice(2)}.json`);
    if (text !== null) writeFileSync(path, text);
    const code = await explainCli(path);
    expect(code).toBe(2);
    expect(stderr).toContain(path);
    expect(stdout).toBe("");
  });

  it("exits 2 for a format outside table and json", async () => {
    expect(await explainCli(PRE_D4A, "--format", "xml")).toBe(2);
  });

  it("accepts a record that pr-review run wrote before D4a", async () => {
    const recordText = readFileSync(PRE_D4A, "utf8");
    expect(RecordSchema.safeParse(JSON.parse(recordText)).error).toBeUndefined();
    expect(await explainCli(PRE_D4A), stderr).toBe(0);
    const entries = await explainJson(PRE_D4A);
    expect(entries).toHaveLength(9);
    for (const e of entries) {
      expect(e.stage).toBe("verify");
      expect(e.outcome).toBe("dropped");
    }
    // The verdicts of the nine verifications in the record.
    expect(entries.map((e) => e.reason).sort()).toEqual(
      [
        "verifier: the claim does not hold, scored 12",
        ...[30, 40, 25, 45, 45, 30].map(
          (n) => `verifier scored ${n}, below a threshold of at least 80`,
        ),
        "escalated, verifier: the claim does not hold, scored 22",
        "escalated, verifier: out of scope, scored 12",
      ].sort(),
    );
  });

  it(
    "explains a record that pr-review eval wrote",
    async () => {
      const fx = await makeFixture();
      try {
        const cases = join(work, "eval-cases");
        mkdirSync(cases);
        await run("bash", [MAKE_CASE, fx.repo, fx.base, fx.head, "one"], { cwd: cases });
        writeFileSync(join(cases, "one", "golden.json"), JSON.stringify({ findings: [] }));
        const out = join(work, "eval-out");
        const fake = createFakeSdkClient((req): QueryOutcome<unknown> => {
          const meta: QueryMeta = {
            model: "m",
            durationMs: 1,
            stopReason: "end_turn",
            subtype: "success",
            usage: {},
            costUsd: 0,
          };
          if (req.role === "triage") {
            return {
              ok: true,
              output: {
                tier: "full",
                reason: "r",
                confidence: "high",
                categories: [],
                hotspots: [],
                file_notes: [],
                summary: "s",
              },
              raw: meta,
            };
          }
          return { ok: true, output: { findings: [] }, raw: meta };
        });
        const code = await exitCodeOf(
          createProgram({ client: fake }).parseAsync([
            "node",
            "pr-review",
            "eval",
            "--cases",
            cases,
            "--repeat",
            "1",
            "--out",
            out,
            "--format",
            "json",
          ]),
        );
        expect(code, stderr).toBe(0);
        const dir = join(out, "one", "1");
        const [file] = readdirSync(dir).filter((f) => f.endsWith(".json"));
        expect(await explainCli(join(dir, file ?? ""))).toBe(0);
      } finally {
        rmSync(fx.repo, { recursive: true, force: true });
      }
    },
    RUN_TIMEOUT,
  );
});
