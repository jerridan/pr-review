// D8 R1: the record links each finding and each query to its pass.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { metrics } from "../src/eval/metrics.js";
import { scoreRecord } from "../src/eval/score.js";
import { explain } from "../src/explain/index.js";
import { runReview } from "../src/run.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));
const PRE_D4A = fileURLToPath(new URL("./fixtures/record-pre-d4a.json", import.meta.url));

const META: QueryMeta = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

// Every built-in reviewer but diff-bugs is off. diff-bugs runs two passes.
const CONFIG = [
  "reviewers:",
  "  diff-bugs:",
  "    passes: 2",
  ...["conventions", "description-drift", "docs-and-comments", "history", "security", "tests"].map(
    (n) => `  ${n}:\n    enabled: false`,
  ),
  "",
].join("\n");

let repo = "";
let base = "";
let head = "";
let out = "";
const dirs: string[] = [];

beforeAll(async () => {
  const source = mkdtempSync(join(tmpdir(), "pr-review-sources-config-"));
  dirs.push(source);
  mkdirSync(join(source, "dir"));
  writeFileSync(join(source, "dir", "config.yaml"), CONFIG);
  const { stdout } = await run("bash", [SCRIPT, "--pr-review-dir", join(source, "dir")]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  repo = value("FIXTURE");
  base = value("BASE");
  head = value("HEAD");
  dirs.push(repo);
  out = mkdtempSync(join(tmpdir(), "pr-review-sources-out-"));
  dirs.push(out);
}, 30_000);
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const A = {
  file: "src/stats.ts",
  start_line: 11,
  end_line: 11,
  category: "bug",
  severity_estimate: "blocking",
  confidence: "high",
  claim: "CLAIM-A",
  evidence: "for (let i = 0; i <= values.length; i++) {",
  explanation: "e",
  needs_context: false,
};
const B = {
  file: ".github/workflows/ci.yml",
  start_line: 8,
  end_line: 8,
  category: "security",
  severity_estimate: "blocking",
  confidence: "high",
  claim: "CLAIM-B",
  evidence: "- run: npm test",
  explanation: "e",
  needs_context: false,
};

// The first reviewer query is pass 1: it gives A. The second is pass 2:
// it gives A and B. The semaphore starts the queries in arrival order.
function fake() {
  let reviewerCalls = 0;
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const ok = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
    switch (req.role) {
      case "triage":
        return ok({
          tier: "full",
          reason: "r",
          confidence: "high",
          categories: ["bug"],
          hotspots: [],
          file_notes: [],
          summary: "s",
        });
      case "reviewer":
        reviewerCalls += 1;
        return ok({ findings: reviewerCalls === 1 ? [A] : [A, B] });
      case "verifier":
      case "verifier-escalation":
        return ok({
          in_scope: true,
          claim_holds: true,
          introduced_by_pr: true,
          quotes: ["i <= values.length", "run: npm test"],
          rationale: "r",
          score: 95,
          severity: "blocking",
        });
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
}

describe("the sources of each finding and query (D8 R1)", () => {
  let record: RunRecord;
  beforeAll(async () => {
    const result = await runReview({
      repo,
      base,
      head,
      format: "json",
      tierOverride: "full",
      outDir: out,
      allowApiKey: false,
      client: fake(),
    });
    // The record on disk is the one that counts.
    record = JSON.parse(readFileSync(result.recordPath, "utf8")) as RunRecord;
  }, 30_000);

  const byClaim = <T extends { claim: string }>(list: T[], claim: string): T | undefined =>
    list.find((f) => f.claim === claim);

  it("names both passes as the sources of a finding that both passes returned", () => {
    const verification = record.stages.verifications.find((v) => v.finding.claim === "CLAIM-A");
    expect(verification?.sources).toEqual([
      { reviewer: "diff-bugs", pass: 1 },
      { reviewer: "diff-bugs", pass: 2 },
    ]);
    expect(byClaim(record.posted.findings, "CLAIM-A")?.sources).toEqual([
      { reviewer: "diff-bugs", pass: 1 },
      { reviewer: "diff-bugs", pass: 2 },
    ]);
  });

  it("names pass 2 only as the source of a finding that only pass 2 returned", () => {
    const verification = record.stages.verifications.find((v) => v.finding.claim === "CLAIM-B");
    expect(verification?.sources).toEqual([{ reviewer: "diff-bugs", pass: 2 }]);
    expect(byClaim(record.posted.findings, "CLAIM-B")?.sources).toEqual([
      { reviewer: "diff-bugs", pass: 2 },
    ]);
  });

  it("names the pass of each reviewer query", () => {
    const reviewerQueries = record.cost.queries.filter((q) => q.role === "reviewer");
    expect(reviewerQueries.map((q) => [q.reviewer, q.pass]).sort()).toEqual([
      ["diff-bugs", 1],
      ["diff-bugs", 2],
    ]);
  });

  it("names the verification of each verifier query", () => {
    const verifierQueries = record.cost.queries.filter(
      (q) => q.role === "verifier" || q.role === "verifier-escalation",
    );
    expect(verifierQueries.length).toBe(record.stages.verifications.length);
    const served = verifierQueries.map((q) => q.verification).sort();
    expect(served).toEqual(record.stages.verifications.map((_, i) => i));
  });
});

describe("a record without the source fields (D8 R1.4)", () => {
  const old = (): RunRecord => RecordSchema.parse(JSON.parse(readFileSync(PRE_D4A, "utf8")));

  it("explains a record without source fields", () => {
    expect(explain(old()).length).toBeGreaterThan(0);
  });

  it("scores a record without source fields", async () => {
    const record = old();
    const noJudge = createFakeSdkClient(() => {
      throw new Error("no judge query is expected");
    });
    const score = await scoreRecord(record, [], "/nonexistent", {
      client: noJudge,
      model: "claude-sonnet-5-5",
      options: { allowApiKey: false, env: {} },
    });
    expect(metrics(record, score, 1).posted).toBe(record.posted.findings.length);
  });
});
