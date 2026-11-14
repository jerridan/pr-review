// D8 R3: the paired report of one pass against all passes, from the eval
// and from the records of an earlier eval with no model call.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import type { GoldenFinding } from "../src/eval/case.js";
import type { Report } from "../src/eval/report.js";
import { ExtrasOutputSchema } from "../src/eval/score.js";
import { isRecordFileName } from "../src/record/write.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import {
  captured,
  captureOutput,
  casesFrom,
  cleanup,
  exitCodeOf,
  makeFixture,
  makeTemplate,
  output,
  tempDir,
  type Fixture,
} from "./fixtures/eval-fixture.js";

const made: string[] = [];
let fx: Fixture;
let cases = "";
afterAll(() => cleanup(made));
captureOutput();

// G1 is the planted bug. G2 is on the CI file, with another category than
// the finding B, so the pair of B and G2 goes to the judge.
const GOLDEN: GoldenFinding[] = [
  {
    file: "src/stats.ts",
    start_line: 11,
    end_line: 11,
    category: "bug",
    severity: "blocking",
    claim: "G1",
  },
  {
    file: ".github/workflows/ci.yml",
    start_line: 8,
    end_line: 8,
    category: "bug",
    severity: "blocking",
    claim: "G2",
  },
];

const finding = (
  file: string,
  line: number,
  category: string,
  claim: string,
  evidence: string,
) => ({
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
});
const A = finding(
  "src/stats.ts",
  11,
  "bug",
  "CLAIM-A",
  "for (let i = 0; i <= values.length; i++) {",
);
const B = finding(".github/workflows/ci.yml", 8, "security", "CLAIM-B", "- run: npm test");
// F matches no golden: a false finding.
const F = finding("README.md", 3, "docs", "CLAIM-F", "A small repo for pr-review tests.");

const meta = (costUsd: number): QueryMeta => ({
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd,
});

const TRIAGE = 0.1;
const REVIEWER = 0.2;
const VERIFIER = 0.05;

// diff-bugs and security run two passes. diff-bugs gives A in both passes.
// security gives nothing in pass 1. In pass 2 it gives B and F in run 1,
// and B only in run 2. The other reviewers give nothing and cost nothing.
// The first query of a reviewer in a run is its pass 1: the semaphore
// starts the queries in arrival order.
function fake() {
  let runs = 0;
  let calls = new Map<string, number>();
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const ok = (out: unknown, cost = 0): QueryOutcome<unknown> => ({
      ok: true,
      output: out,
      raw: meta(cost),
    });
    switch (req.role) {
      case "triage":
        runs += 1;
        calls = new Map();
        return ok(
          {
            tier: "full",
            reason: "r",
            confidence: "high",
            categories: ["bug"],
            hotspots: [],
            file_notes: [],
            summary: "s",
          },
          TRIAGE,
        );
      case "reviewer": {
        const name = req.reviewerName ?? "";
        const pass = (calls.get(name) ?? 0) + 1;
        calls.set(name, pass);
        if (name === "diff-bugs") return ok({ findings: [A] }, REVIEWER);
        if (name === "security") {
          const second = runs === 1 ? [B, F] : [B];
          return ok({ findings: pass === 1 ? [] : second }, REVIEWER);
        }
        return ok({ findings: [] });
      }
      case "verifier":
      case "verifier-escalation":
        return ok(
          {
            in_scope: true,
            claim_holds: true,
            introduced_by_pr: true,
            quotes: ["i <= values.length", "run: npm test", "A small repo"],
            rationale: "r",
            score: 95,
            severity: "blocking",
          },
          VERIFIER,
        );
      case "judge":
        if (req.schema === ExtrasOutputSchema) return ok({ real: "no", reason: "r" });
        return ok({ same_issue: "yes", reason: "r" }, 0.5);
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
}

async function evalPaired(): Promise<{
  code: number;
  out: string;
  report: Report;
  stderr: string;
}> {
  const out = tempDir("paired-out", made);
  const run = (): Promise<number> =>
    exitCodeOf(
      createProgram({ client: fake() }).parseAsync([
        "node",
        "pr-review",
        "eval",
        "--cases",
        cases,
        "--out",
        out,
        "--repeat",
        "2",
        "--paired",
        "--format",
        "json",
      ]),
    );
  // The eval runs in beforeAll, before the capture of each test.
  return captured(async () => {
    const code = await run();
    return { code, out, report: JSON.parse(output.stdout) as Report, stderr: output.stderr };
  });
}

// Run the eval in a test, into "out", with the extra flags.
async function evalInto(out: string, ...extra: string[]): Promise<number> {
  return exitCodeOf(
    createProgram({ client: fake() }).parseAsync([
      "node",
      "pr-review",
      "eval",
      "--cases",
      cases,
      "--out",
      out,
      ...extra,
    ]),
  );
}

async function evalReport(out: string, format: "json" | "table") {
  const client = createFakeSdkClient(() => {
    throw new Error("the offline report makes no query");
  });
  output.stdout = "";
  output.stderr = "";
  const code = await exitCodeOf(
    createProgram({ client }).parseAsync([
      "node",
      "pr-review",
      "eval-report",
      "--cases",
      cases,
      "--out",
      out,
      "--format",
      format,
    ]),
  );
  return { code, client };
}

// Each file in "dir" and below whose name passes "test".
function filesUnder(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full, test);
    return test(name) ? [full] : [];
  });
}

let live: { code: number; out: string; report: Report; stderr: string };
beforeAll(async () => {
  fx = await makeFixture();
  made.push(fx.repo);
  const root = tempDir("paired", made);
  const template = await makeTemplate(fx, root);
  cases = casesFrom(template, join(root, "cases"), [{ name: "case-a", golden: GOLDEN }]);
  live = await evalPaired();
}, 120_000);

describe("pr-review eval --paired (D8 R3)", () => {
  it("exits 0 and adds the paired section to report.json", () => {
    expect(live.code, live.stderr).toBe(0);
    const file = JSON.parse(readFileSync(join(live.out, "report.json"), "utf8")) as Report;
    expect(file.paired).toEqual(live.report.paired);
  });

  it("gives the one-pass and the all figures of each repeat of the case", () => {
    const every = live.report.paired?.scopes.find((s) => s.reviewer === null);
    const [r1, r2] = every?.cases[0]?.repeats ?? [];
    expect(r1?.all).toMatchObject({ raw_recall: 1, recall: 1, posted: 3, matched: 2 });
    expect(r1?.all.precision).toBeCloseTo(2 / 3);
    expect(r1?.all.cost_usd).toBeCloseTo(TRIAGE + 4 * REVIEWER + 3 * VERIFIER);
    expect(r1?.one_pass).toMatchObject({ raw_recall: 0.5, recall: 0.5, precision: 1, posted: 1 });
    // Less the two reviewer queries of pass 2 and the verifications of B and F.
    expect(r1?.one_pass.cost_usd).toBeCloseTo(TRIAGE + 2 * REVIEWER + VERIFIER);
    expect(r1).toMatchObject({ added_goldens: 1, added_false: 1 });
    expect(r1?.added_cost_per_golden).toBeCloseTo(2 * REVIEWER + 2 * VERIFIER);

    expect(r2?.all).toMatchObject({ raw_recall: 1, recall: 1, precision: 1, posted: 2 });
    expect(r2?.one_pass).toMatchObject({ raw_recall: 0.5, recall: 0.5, precision: 1, posted: 1 });
    expect(r2).toMatchObject({ added_goldens: 1, added_false: 0 });
    expect(r2?.added_cost_per_golden).toBeCloseTo(2 * REVIEWER + VERIFIER);
  });

  it("gives the sets of each reviewer that ran two passes", () => {
    const scopes = live.report.paired?.scopes ?? [];
    expect(scopes.map((s) => s.reviewer)).toEqual([null, "diff-bugs", "security"]);
    const r1 = (name: string) => scopes.find((s) => s.reviewer === name)?.cases[0]?.repeats[0];
    // diff-bugs pass 2 adds nothing: its one-pass set posts the same.
    expect(r1("diff-bugs")?.one_pass).toMatchObject({ recall: 1, posted: 3 });
    expect(r1("diff-bugs")?.one_pass.cost_usd).toBeCloseTo(TRIAGE + 3 * REVIEWER + 3 * VERIFIER);
    expect(r1("diff-bugs")).toMatchObject({
      added_goldens: 0,
      added_false: 0,
      added_cost_per_golden: null,
    });
    expect(r1("security")?.one_pass).toMatchObject({ recall: 0.5, posted: 1 });
    expect(r1("security")?.one_pass.cost_usd).toBeCloseTo(TRIAGE + 3 * REVIEWER + VERIFIER);
    expect(r1("security")).toMatchObject({ added_goldens: 1, added_false: 1 });
    expect(r1("security")?.added_cost_per_golden).toBeCloseTo(REVIEWER + 2 * VERIFIER);
  });

  it("gives the mean and the spread of the paired differences over the two repeats", () => {
    const every = live.report.paired?.scopes.find((s) => s.reviewer === null);
    expect(every?.repeats.map((r) => r.recall_diff)).toEqual([0.5, 0.5]);
    expect(every?.aggregate.recall_diff).toEqual({ mean: 0.5, min: 0.5, max: 0.5 });
    expect(every?.aggregate.precision_diff.mean).toBeCloseTo(-1 / 6);
    expect(every?.aggregate.precision_diff.min).toBeCloseTo(-1 / 3);
    expect(every?.aggregate.precision_diff.max).toBeCloseTo(0);
  });
});

describe("pr-review eval-report (D8 R3.2)", () => {
  it("gives the same paired figures from the records, with no query", async () => {
    const { code, client } = await evalReport(live.out, "json");
    expect(code, output.stderr).toBe(0);
    expect(client.calls).toEqual([]);
    const report = JSON.parse(output.stdout) as Report;
    expect(report.paired?.scopes).toEqual(live.report.paired?.scopes);
    expect(report.paired?.missing).toEqual([]);
    expect(report.paired?.uncached).toEqual([]);
  });

  it("exits 0 and names the repeat whose record has no source fields", async () => {
    const out = tempDir("paired-nosources", made);
    cpSync(live.out, out, { recursive: true });
    const [path] = filesUnder(join(out, "case-a", "1"), isRecordFileName);
    if (!path) throw new Error("no record");
    const text = readFileSync(path, "utf8");
    // Remove every source field that R1 adds.
    const stripped = JSON.parse(text, (key: string, value: unknown) =>
      key === "sources" ? undefined : value,
    ) as { cost: { queries: Record<string, unknown>[] } };
    for (const q of stripped.cost.queries) {
      delete q.pass;
      delete q.verification;
    }
    writeFileSync(path, JSON.stringify(stripped));

    const { code } = await evalReport(out, "table");
    expect(code, output.stderr).toBe(0);
    expect(output.stdout).toMatch(/no source fields: case-a repeat 1\b/i);
    expect(output.stdout).not.toMatch(/no source fields: case-a repeat 2\b/i);
  });

  it("prints a not-valid line at the top when the judge cache is gone", async () => {
    const out = tempDir("paired-nocache", made);
    cpSync(live.out, out, { recursive: true });
    for (const path of filesUnder(out, (n) => n === "judge-cache.json")) rmSync(path);

    const { code } = await evalReport(out, "table");
    expect(code, output.stderr).toBe(0);
    const first = output.stdout.split("\n")[0] ?? "";
    expect(first).toMatch(
      /^Not valid: case-a repeat 1: \d+ judge (pair|pairs) had no cached answer/,
    );
  });
});

describe("the review fixes of the paired report (D8 R2, R3)", () => {
  it("refuses to resume a --paired run without --paired", async () => {
    const out = tempDir("paired-resume", made);
    cpSync(live.out, out, { recursive: true });
    const code = await evalInto(out, "--repeat", "2", "--resume", "--format", "json");
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/other options/);
  });

  it("fails the repeat, and names the file, when its judge cache is not valid", async () => {
    const out = tempDir("paired-corrupt", made);
    const path = join(out, "case-a", "1", "judge-cache.json");
    mkdirSync(join(out, "case-a", "1"), { recursive: true });
    writeFileSync(path, "{ not json");
    const code = await evalInto(out, "--repeat", "1", "--paired", "--format", "json");
    expect(code).toBe(1);
    expect(output.stderr).toContain(path);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  }, 60_000);

  it("finds the record of a result.json that names no record", async () => {
    const out = tempDir("paired-norecord", made);
    cpSync(live.out, out, { recursive: true });
    const resultPath = join(out, "case-a", "1", "result.json");
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    expect(result.record).toBeDefined();
    delete result.record;
    writeFileSync(resultPath, JSON.stringify(result));

    const { code } = await evalReport(out, "json");
    expect(code, output.stderr).toBe(0);
    const report = JSON.parse(output.stdout) as Report;
    expect(report.failed_repeats).toEqual([]);
    expect(report.paired?.scopes).toEqual(live.report.paired?.scopes);
  });
});
