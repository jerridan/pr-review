import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatJson } from "../src/output/json.js";
import { recordFileName, writeRecord } from "../src/record/write.js";
import { runReview } from "../src/run.js";
import type { Finding } from "../src/schemas/finding.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

type Fixture = { repo: string; base: string; head: string; file: string; line: number };

async function makeFixture(): Promise<Fixture> {
  const { stdout } = await run("bash", [SCRIPT]);
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
    if (req.role === "reviewer") {
      return {
        ok: true,
        output: {
          findings: [
            plantedFinding(fx),
            plantedFinding(fx, { evidence: "this text is not in the file" }),
          ],
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
    expect(id.selected_reviewers).toEqual([
      { name: "diff-bugs", trigger: expect.stringContaining("min_tier fast") },
    ]);
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
    expect(record.stages.reviewers).toHaveLength(1);
    expect(record.stages.reviewers[0]?.dropped).toEqual([
      {
        finding: plantedFinding(fx, { evidence: "this text is not in the file" }),
        reason: "bad-quote",
      },
    ]);
    expect(record.stages.verifications).toEqual([
      {
        finding: plantedFinding(fx),
        first: result(70),
        escalated: { kind: "thrown", message: "x" },
        final: result(70),
        passed: false,
      },
    ]);
    expect(record.stages.merges).toEqual([]);
    expect(record.stages.capped).toEqual([]);
  });

  it("holds what was posted: a failed escalation leaves the verdict complete", () => {
    expect(record.posted.findings).toEqual([]);
    expect(record.posted.verdict).toBe("would approve");
    expect(record.posted.coverage).toEqual({
      reviewers_ran: ["diff-bugs"],
      reviewers_failed: [],
      findings_dropped_by_failed_verifier: 0,
    });
  });

  it("holds one cost entry per query, the total and every error", () => {
    expect(record.cost.queries).toHaveLength(calls.length);
    expect(record.cost.queries.map((q) => q.role).sort()).toEqual(
      ["reviewer", "triage", "verifier", "verifier-escalation"].sort(),
    );
    const reviewer = record.cost.queries.find((q) => q.role === "reviewer");
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
    expect(record.cost.total_cost_usd).toBeCloseTo(0.62, 10);
    expect(Object.keys(record.cost.stage_ms)).toEqual(
      expect.arrayContaining(["gather", "triage", "find_verify", "merge"]),
    );
    expect(record.cost.errors).toEqual([
      { stage: "verify", message: expect.stringContaining("thrown") },
    ]);
  });
});

describe("--format json output (A9)", () => {
  it("prints one document with the five keys, and findings is posted.findings", () => {
    const doc = JSON.parse(formatJson(record, recordPath));
    expect(Object.keys(doc).sort()).toEqual([
      "coverage",
      "findings",
      "record_path",
      "tier",
      "verdict",
    ]);
    expect(doc).toEqual({
      record_path: recordPath,
      tier: record.identity.tier,
      verdict: record.posted.verdict,
      coverage: record.posted.coverage,
      findings: record.posted.findings,
    });
  });
});
