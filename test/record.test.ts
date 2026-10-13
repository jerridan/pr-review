import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { formatJson } from "../src/output/json.js";
import { recordFileName, writeRecord } from "../src/record/write.js";
import { loadBuiltinReviewers } from "../src/reviewers/loader.js";
import { runReview } from "../src/run.js";
import type { Finding } from "../src/schemas/finding.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

type Fixture = { repo: string; base: string; head: string; file: string; line: number };

async function makeFixture(...options: string[]): Promise<Fixture> {
  const { stdout } = await run("bash", [SCRIPT, ...options]);
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

function meta(cost: number | null): QueryMeta {
  return {
    model: "claude-test",
    durationMs: 11,
    stopReason: "end_turn",
    subtype: "success",
    usage: { u: 1 },
    costUsd: cost,
  };
}

function result(score: number): VerifierResult {
  return {
    in_scope: true,
    claim_holds: true,
    introduced_by_pr: true,
    quotes: ["i <= values.length"],
    rationale: "r",
    score,
    severity: "blocking",
  };
}

function plantedFinding(fx: Fixture, overrides: Partial<Finding> = {}): Finding {
  return {
    file: fx.file,
    start_line: fx.line,
    end_line: fx.line,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: "The loop reads one item past the end.",
    evidence: "for (let i = 0; i <= values.length; i++) {",
    explanation: "The bound must be i < values.length.",
    needs_context: false,
    ...overrides,
  };
}

// The seven built-in reviewers, in file name order.
const SEVEN = [
  "conventions",
  "description-drift",
  "diff-bugs",
  "docs-and-comments",
  "history",
  "security",
  "tests",
];

let fx: Fixture;
let outRoot: string;
let record: RunRecord;
let recordPath: string;
let calls: QueryRequest[];

beforeAll(async () => {
  fx = await makeFixture();
  outRoot = mkdtempSync(join(tmpdir(), "pr-review-record-"));
  const fake = createFakeSdkClient((req): QueryOutcome<unknown> => {
    if (req.role === "triage") {
      return {
        ok: true,
        output: {
          tier: "full",
          reason: "New logic.",
          confidence: "high",
          categories: ["bug"],
          hotspots: [],
          file_notes: [],
          summary: "s",
        },
        raw: meta(0.02),
      };
    }
    // Only diff-bugs reports findings. The other reviewers report none.
    if (req.role === "reviewer") {
      return {
        ok: true,
        output: {
          findings:
            req.reviewerName === "diff-bugs"
              ? [
                  plantedFinding(fx),
                  plantedFinding(fx, { evidence: "this text is not in the file" }),
                ]
              : [],
        },
        raw: meta(0.5),
      };
    }
    if (req.role === "verifier") return { ok: true, output: result(70), raw: meta(0.1) };
    if (req.role === "verifier-escalation")
      return { ok: false, failure: { kind: "thrown", message: "x" }, raw: null };
    throw new Error(`unexpected role ${req.role}`);
  });
  const out = await runReview({
    repo: fx.repo,
    base: fx.base,
    head: fx.head,
    outDir: join(outRoot, "records"),
    allowApiKey: false,
    client: fake,
    now: () => new Date("2026-10-13T12:34:56.789Z"),
  });
  record = out.record;
  recordPath = out.recordPath;
  calls = fake.calls;
}, 30_000);

afterAll(() => {
  if (fx) rmSync(fx.repo, { recursive: true, force: true });
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
});

describe("the record file (A9)", () => {
  it("is named by the timestamp without colons and the 7-char head sha", () => {
    expect(recordFileName(new Date("2026-10-13T12:34:56.789Z"), "abcdef0123456789")).toBe(
      "2026-10-13T123456.789Z-abcdef0.json",
    );
    expect(basename(recordPath)).toBe(`2026-10-13T123456.789Z-${fx.head.slice(0, 7)}.json`);
    expect(isAbsolute(recordPath)).toBe(true);
  });

  it("validates against the record schema, as written", () => {
    const written = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(RecordSchema.safeParse(written).error).toBeUndefined();
    expect(written).toEqual(JSON.parse(JSON.stringify(record)));
  });

  it("fails validation when a required part is missing", () => {
    for (const part of ["identity", "stages", "posted", "cost"] as const) {
      const broken: Record<string, unknown> = JSON.parse(JSON.stringify(record));
      delete broken[part];
      expect(RecordSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("is not written when it does not validate", async () => {
    const dir = join(outRoot, "invalid");
    const broken = { ...record, identity: { ...record.identity, pr: 7 } } as unknown as RunRecord;
    await expect(writeRecord(dir, broken)).rejects.toThrow();
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("does not overwrite a record with the same name", async () => {
    const dir = join(outRoot, "twice");
    await writeRecord(dir, record);
    await expect(writeRecord(dir, record)).rejects.toThrow();
  });

  it("has pr and config_hash set to null", () => {
    expect(record.identity.pr).toBeNull();
    expect(record.identity.config_hash).toBeNull();
  });

  it("holds the description, the history flags and no injected file (R9)", () => {
    expect(record.identity.description).toBe(
      "Head: add average, move format helpers, bump lockfile, add CI",
    );
    expect(record.identity.history).toEqual({ built: true, truncated: false });
    expect(record.identity.injected).toEqual([]);
    // Each reviewer got its body alone, with no rules block.
    const bodies = new Map(loadBuiltinReviewers().map((d) => [d.frontmatter.name, d.systemPrompt]));
    const reviewers = calls.filter((c) => c.role === "reviewer");
    expect(reviewers.length).toBeGreaterThan(0);
    for (const call of reviewers) {
      expect(call.systemPrompt).toBe(bodies.get(call.reviewerName ?? ""));
    }
  });

  it("holds the default config, no loaded files and no custom reviewers", () => {
    expect(record.identity.config).toEqual({
      files: [],
      values: DEFAULT_REPO_CONFIG,
      custom_reviewers: [],
    });
  });
});

/** The config hash by spec R4, computed here apart from the code. */
function r4Hash(files: Record<string, string>): string {
  const paths = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const joined = paths.map((p) => `${p}\n${files[p]}`).join("\0");
  return createHash("sha256").update(Buffer.from(joined, "utf8")).digest("hex");
}

describe("the config hash of a fixture with config (R4)", () => {
  const files: Record<string, string> = {
    ".pr-review/config.yaml": "thresholds:\n  default: 82\nconcurrency: 2\n",
    ".pr-review/rules.md": "Name each test after its behaviour.\n",
  };
  let configFx: Fixture;
  let configRecord: RunRecord;
  let configPath: string;

  beforeAll(async () => {
    const source = mkdtempSync(join(tmpdir(), "pr-review-record-config-"));
    mkdirSync(join(source, "dir"));
    writeFileSync(join(source, "dir", "config.yaml"), files[".pr-review/config.yaml"] ?? "");
    writeFileSync(join(source, "dir", "rules.md"), files[".pr-review/rules.md"] ?? "");
    writeFileSync(join(source, "claude.md"), "Not part of the hash.\n");
    try {
      configFx = await makeFixture(
        "--pr-review-dir",
        join(source, "dir"),
        "--claude-md",
        join(source, "claude.md"),
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
    const fake = createFakeSdkClient((req): QueryOutcome<unknown> => {
      if (req.role === "reviewer") return { ok: true, output: { findings: [] }, raw: meta(0.1) };
      throw new Error(`unexpected role ${req.role}`);
    });
    const out = await runReview({
      repo: configFx.repo,
      base: configFx.base,
      head: configFx.head,
      tierOverride: "fast",
      outDir: join(outRoot, "config-records"),
      allowApiKey: false,
      client: fake,
    });
    configRecord = out.record;
    configPath = out.recordPath;
  }, 30_000);

  afterAll(() => {
    if (configFx) rmSync(configFx.repo, { recursive: true, force: true });
  });

  it("equals the SHA-256 that the test computes from the loaded files", () => {
    expect(configRecord.identity.config_hash).toBe(r4Hash(files));
    expect(configRecord.identity.config_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists the loaded paths and the validated values under identity.config", () => {
    expect(configRecord.identity.config.files).toEqual([
      ".pr-review/config.yaml",
      ".pr-review/rules.md",
    ]);
    expect(configRecord.identity.config.values).toEqual({
      ...DEFAULT_REPO_CONFIG,
      thresholds: { ...DEFAULT_REPO_CONFIG.thresholds, default: 82 },
      concurrency: 2,
    });
    expect(configRecord.identity.config.custom_reviewers).toEqual([]);
  });

  it("lists the injected files: the base commit's CLAUDE.md, then rules.md (R5)", () => {
    expect(configRecord.identity.injected).toEqual([
      { path: "CLAUDE.md", truncated: false },
      { path: ".pr-review/rules.md", truncated: false },
    ]);
  });

  it("writes a record that validates", () => {
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(RecordSchema.safeParse(written).error).toBeUndefined();
  });

  it("is null for the default fixture, which has no .pr-review/", () => {
    expect(record.identity.config_hash).toBeNull();
  });
});

describe("the record parts", () => {
  it("holds the identity and inputs", () => {
    const id = record.identity;
    expect(id.base).toBe(fx.base);
    expect(id.head).toBe(fx.head);
    expect(id.started_at).toBe("2026-10-13T12:34:56.789Z");
    expect(id.tool_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(id.changed_files).toEqual([
      { path: ".github/workflows/ci.yml", hunks: 1 },
      { path: "src/stats.ts", hunks: 1 },
    ]);
    expect(id.excluded_files).toContainEqual({ path: "package-lock.json", reason: "generated" });
    expect(id.sensitive_files).toEqual([".github/workflows/ci.yml"]);
    expect(id.tier).toBe("full");
    expect(id.tier_reason).toMatch(/sensitive/i);
    expect(id.triage?.summary).toBe("s");
    expect(id.selected_reviewers.map((r) => r.name)).toEqual(SEVEN);
    expect(id.selected_reviewers.find((r) => r.name === "diff-bugs")).toEqual({
      name: "diff-bugs",
      trigger: expect.stringContaining("min_tier fast"),
      model: "claude-opus-5-5",
      effort: "low",
      tools_ignored: [],
    });
    expect(id.selected_reviewers.find((r) => r.name === "tests")?.trigger).toContain(
      "min_tier full",
    );
    expect(id.models).toEqual({
      triage: { model: "claude-sonnet-5-5", effort: "medium" },
      reviewer: { model: "claude-opus-5-5", effort: "low" },
      verifier: { model: "claude-sonnet-5-5", effort: "high" },
      "verifier-escalation": { model: "claude-opus-5-5", effort: "high" },
      merge: { model: "claude-sonnet-5-5", effort: "medium" },
      smoke: { model: "claude-sonnet-5-5", effort: "low" },
    });
  });

  it("holds the raw stage outputs, the drop and the failed escalation", () => {
    // diff-bugs and security run two passes; the other five run one.
    expect(record.stages.reviewers).toHaveLength(9);
    const diffBugs = record.stages.reviewers.filter((r) => r.name === "diff-bugs");
    expect(diffBugs.map((r) => r.pass).sort()).toEqual([1, 2]);
    for (const run of diffBugs) {
      expect(run.findings).toEqual([plantedFinding(fx)]);
      expect(run.dropped).toEqual([
        {
          finding: plantedFinding(fx, { evidence: "this text is not in the file" }),
          reason: "bad-quote",
        },
      ]);
    }
    // Both passes give the same finding, so one copy is verified.
    expect(record.stages.verifications).toEqual([
      {
        finding: plantedFinding(fx),
        first: result(70),
        escalated: { kind: "thrown", message: "x" },
        final: null,
        passed: false,
      },
    ]);
    expect(record.stages.merges).toEqual([]);
    expect(record.stages.capped).toEqual([]);
  });

  it("holds what was posted: a failed escalation drops the finding and makes the verdict incomplete", () => {
    expect(record.posted.findings).toEqual([]);
    expect(record.posted.verdict).toBe("incomplete");
    expect(record.posted.coverage).toEqual({
      reviewers_ran: expect.arrayContaining(SEVEN),
      reviewers_failed: [],
      reviewers_skipped: [],
      findings_dropped_by_failed_verifier: 1,
    });
  });

  it("holds one cost entry per query, the total and every error", () => {
    expect(record.cost.queries).toHaveLength(calls.length);
    expect(new Set(record.cost.queries.map((q) => q.role))).toEqual(
      new Set(["reviewer", "triage", "verifier", "verifier-escalation"]),
    );
    expect(record.cost.queries.filter((q) => q.role === "reviewer")).toHaveLength(9);
    const reviewer = record.cost.queries.find(
      (q) => q.role === "reviewer" && q.reviewer === "diff-bugs",
    );
    expect(reviewer).toMatchObject({
      reviewer: "diff-bugs",
      model: "claude-test",
      duration_ms: 11,
      cost_usd: 0.5,
      usage: { u: 1 },
    });
    const escalation = record.cost.queries.find((q) => q.role === "verifier-escalation");
    expect(escalation).toMatchObject({
      model: "claude-opus-5-5",
      cost_usd: null,
      stop_reason: null,
    });
    // Triage 0.02, nine reviewer passes at 0.5 each, one verifier at 0.1.
    expect(record.cost.total_cost_usd).toBeCloseTo(0.02 + 9 * 0.5 + 0.1, 10);
    // The failed escalation has no cost, so the total is a lower bound.
    expect(record.cost.queries_without_cost).toBe(1);
    expect(Object.keys(record.cost.stage_ms)).toEqual(
      expect.arrayContaining(["gather", "triage", "find_verify", "merge"]),
    );
    expect(record.cost.errors).toEqual([
      { stage: "verify", message: expect.stringContaining("thrown") },
    ]);
  });
});

describe("--format json output (A9)", () => {
  it("prints one document with the eight keys, and findings is posted.findings", () => {
    const doc = JSON.parse(formatJson(record, recordPath));
    expect(Object.keys(doc).sort()).toEqual([
      "coverage",
      "excluded_files",
      "findings",
      "queries_without_cost",
      "record_path",
      "tier",
      "total_cost_usd",
      "verdict",
    ]);
    expect(doc).toEqual({
      record_path: recordPath,
      tier: record.identity.tier,
      verdict: record.posted.verdict,
      coverage: record.posted.coverage,
      excluded_files: record.identity.excluded_files,
      total_cost_usd: record.cost.total_cost_usd,
      queries_without_cost: 1,
      findings: record.posted.findings,
    });
    expect(doc.excluded_files).toContainEqual({ path: "package-lock.json", reason: "generated" });
  });
});
