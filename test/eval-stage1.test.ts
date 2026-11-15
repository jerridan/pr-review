// D4c E1 stage 1: pr-review eval --stage1 runs triage and the reviewers
// only, and scores the raw candidates of each reviewer. eval-report
// --by-reviewer gives the same figures from the records of any eval.
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import type { ByReviewerSection, ReviewerFigures } from "../src/eval/by-reviewer.js";
import type { GoldenFinding } from "../src/eval/case.js";
import type { Report } from "../src/eval/report.js";
import { isRecordFileName } from "../src/record/write.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
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
} from "./fixtures/eval-fixture.js";

const made: string[] = [];
afterAll(() => cleanup(made));
captureOutput();

const golden = (
  file: string,
  line: number,
  category: GoldenFinding["category"],
  severity: GoldenFinding["severity"],
  claim: string,
): GoldenFinding => ({ file, start_line: line, end_line: line, category, severity, claim });

const G_A = golden("src/stats.ts", 11, "bug", "blocking", "GA");
const G_P1 = golden("src/stats.ts", 14, "bug", "suggestion", "GP1");
const G_P2 = golden(".github/workflows/ci.yml", 8, "security", "nit", "GP2");

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
const P1 = finding("src/stats.ts", 14, "bug", "CLAIM-P1", "return total / values.length;");
const P2 = finding(".github/workflows/ci.yml", 8, "security", "CLAIM-P2", "- run: npm test");
const F = finding("README.md", 3, "docs", "CLAIM-F", "A small repo for pr-review tests.");
// A2 is next to G_A with no overlap, so its pair with G_A goes to the judge.
const A2 = finding("src/stats.ts", 12, "bug", "CLAIM-A2", "total += values[i];");

type Findings = ReturnType<typeof finding>[];

const meta = (costUsd: number): QueryMeta => ({
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd,
});

const BUGS_PASS = 0.2;
const SECURITY_PASS = 0.3;

// The findings of each run (one run per case, in case order): diff-bugs
// pass 1, diff-bugs pass 2, security pass 1.
const RUNS: [Findings, Findings, Findings][] = [
  [[A, P1], [A], [P2]],
  [[A2], [], [F]],
];

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
          0.1,
        );
      case "reviewer": {
        const name = req.reviewerName ?? "";
        const pass = (calls.get(name) ?? 0) + 1;
        calls.set(name, pass);
        const run = RUNS[runs - 1];
        if (name === "diff-bugs") return ok({ findings: run?.[pass - 1] ?? [] }, BUGS_PASS);
        if (name === "security") return ok({ findings: run?.[2] ?? [] }, SECURITY_PASS);
        return ok({ findings: [] });
      }
      case "verifier":
        return ok({
          in_scope: true,
          claim_holds: true,
          introduced_by_pr: true,
          quotes: [
            "i <= values.length",
            "return total / values.length",
            "run: npm test",
            "A small repo",
            "total += values[i]",
          ],
          rationale: "r",
          score: 95,
          severity: "blocking",
        });
      case "judge":
        return ok({ same_issue: "yes", reason: "r" });
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
}

const FLAGS = ["--reviewers", "diff-bugs,security", "--passes", "diff-bugs=2,security=1"];

async function evalWith(
  cases: string,
  out: string,
  client: ReturnType<typeof fake>,
  ...extra: string[]
): Promise<number> {
  return exitCodeOf(
    createProgram({ client }).parseAsync([
      "node",
      "pr-review",
      "eval",
      "--cases",
      cases,
      "--out",
      out,
      "--repeat",
      "1",
      "--no-extras",
      "--format",
      "json",
      ...FLAGS,
      ...extra,
    ]),
  );
}

function recordsUnder(dir: string): RunRecord[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return recordsUnder(full);
      if (!isRecordFileName(name)) return [];
      return [JSON.parse(readFileSync(full, "utf8")) as RunRecord];
    });
}

let cases = "";
let stage1Out = "";
let fullOut = "";
let stage1Client: ReturnType<typeof fake>;
let stage1Report: Report & { by_reviewer?: ByReviewerSection };
beforeAll(async () => {
  const fx = await makeFixture();
  made.push(fx.repo);
  const root = tempDir("stage1", made);
  const template = await makeTemplate(fx, root);
  cases = casesFrom(template, join(root, "cases"), [
    { name: "a-case", golden: [G_A, G_P1, G_P2] },
    { name: "b-case", golden: [G_A] },
  ]);
  stage1Out = tempDir("stage1-out", made);
  stage1Client = fake();
  await captured(async () => {
    const code = await evalWith(cases, stage1Out, stage1Client, "--stage1");
    if (code !== 0) throw new Error(`the stage 1 eval exited ${code}: ${output.stderr}`);
    stage1Report = JSON.parse(output.stdout) as typeof stage1Report;
  });
  fullOut = tempDir("stage1-full", made);
  await captured(async () => {
    const code = await evalWith(cases, fullOut, fake(), "--raw-judge");
    if (code !== 0) throw new Error(`the full eval exited ${code}: ${output.stderr}`);
  });
}, 240_000);

const scopeOf = (section: ByReviewerSection | undefined, reviewer: string | null) => {
  const scope = section?.repeats[0]?.scopes.find((s) => s.reviewer === reviewer);
  if (!scope) throw new Error(`no scope ${String(reviewer)}`);
  return scope;
};

// The counts of one row: the candidates, the goldens, and the goldens by
// label (blocking, suggestion, nit).
const figures = (
  candidates: number,
  goldens: number,
  byLabel: [number, number, number],
): Partial<ReviewerFigures> => ({
  candidates,
  goldens,
  by_label: { blocking: byLabel[0], suggestion: byLabel[1], nit: byLabel[2] },
  uncached: 0,
  unknown: 0,
});

describe("pr-review eval --stage1: the run", () => {
  it("makes no verifier, escalation or merge query", () => {
    const roles = new Set(stage1Client.calls.map((c) => c.role));
    expect([...roles].sort()).toEqual(["judge", "reviewer", "triage"]);
  });

  it("marks the record as stage 1, with no verification and the candidates in dedupe order", () => {
    const [a, b] = recordsUnder(stage1Out);
    expect(RecordSchema.safeParse(a).success).toBe(true);
    expect(a?.identity.mode).toBe("stage1");
    expect(a?.stages.verifications).toEqual([]);
    expect(a?.posted.findings).toEqual([]);
    expect(a?.stages.candidates).toEqual([
      {
        finding: A,
        reviewer: "diff-bugs",
        sources: [
          { reviewer: "diff-bugs", pass: 1 },
          { reviewer: "diff-bugs", pass: 2 },
        ],
      },
      { finding: P1, reviewer: "diff-bugs", sources: [{ reviewer: "diff-bugs", pass: 1 }] },
      { finding: P2, reviewer: "security", sources: [{ reviewer: "security", pass: 1 }] },
    ]);
    expect(b?.stages.candidates?.map((c) => c.finding.claim)).toEqual(["CLAIM-A2", "CLAIM-F"]);
    // The raw candidates stay in the reviewer entries, with their passes.
    expect(a?.stages.reviewers.map((r) => [r.name, r.pass, r.findings.length]).sort()).toEqual([
      ["diff-bugs", 1, 2],
      ["diff-bugs", 2, 1],
      ["security", 1, 1],
    ]);
  });

  it("marks a normal record as full, with no candidates field", () => {
    const [a] = recordsUnder(fullOut);
    expect(a?.identity.mode).toBe("full");
    expect(a?.stages.candidates).toBeUndefined();
    expect(a?.stages.verifications.length).toBeGreaterThan(0);
  });

  it("gives posted recall and precision as none, not as 0", async () => {
    const [a, b] = stage1Report.cases;
    expect(a?.repeats[0]).toMatchObject({ recall: null, precision: null, raw_recall: 1 });
    expect(b?.repeats[0]).toMatchObject({ recall: null, precision: null, raw_recall: 1 });
    expect(stage1Report.aggregate.recall.mean).toBeNull();
    const out = tempDir("stage1-table", made);
    output.stdout = "";
    await evalWith(cases, out, fake(), "--stage1", "--format", "table");
    expect(output.stdout).toMatch(/posted recall and precision: none/i);
  }, 120_000);
});

describe("pr-review eval --stage1: the figures of each reviewer", () => {
  it("gives the figures of each reviewer and of all reviewers for each case", () => {
    const section = stage1Report.by_reviewer;
    expect(section?.repeats[0]?.scopes.map((s) => s.reviewer)).toEqual([
      null,
      "diff-bugs",
      "security",
    ]);
    const bugs = scopeOf(section, "diff-bugs");
    expect(bugs.cases.map((c) => c.case)).toEqual(["a-case", "b-case"]);
    expect(bugs.cases[0]).toMatchObject(figures(2, 2, [1, 1, 0]));
    expect(bugs.cases[0]?.cost_usd).toBeCloseTo(2 * BUGS_PASS);
    expect(bugs.cases[0]?.cost_per_golden).toBeCloseTo(BUGS_PASS);
    // A2 matches G_A through the judge.
    expect(bugs.cases[1]).toMatchObject(figures(1, 1, [1, 0, 0]));

    const security = scopeOf(section, "security");
    expect(security.cases[0]).toMatchObject(figures(1, 1, [0, 0, 1]));
    expect(security.cases[1]).toMatchObject(figures(1, 0, [0, 0, 0]));
    expect(security.cases[1]?.cost_usd).toBeCloseTo(SECURITY_PASS);
    expect(security.cases[1]?.cost_per_golden).toBeNull();

    const all = scopeOf(section, null);
    expect(all.cases[0]).toMatchObject(figures(3, 3, [1, 1, 1]));
    expect(all.cases[0]?.cost_usd).toBeCloseTo(2 * BUGS_PASS + SECURITY_PASS);
    expect(all.cases[1]).toMatchObject(figures(2, 1, [1, 0, 0]));
  });

  it("sums the figures over the cases", () => {
    const section = stage1Report.by_reviewer;
    const bugs = scopeOf(section, "diff-bugs").total;
    expect(bugs).toMatchObject(figures(3, 3, [2, 1, 0]));
    expect(bugs.cost_usd).toBeCloseTo(4 * BUGS_PASS);
    expect(bugs.cost_per_golden).toBeCloseTo((4 * BUGS_PASS) / 3);
    const security = scopeOf(section, "security").total;
    expect(security).toMatchObject(figures(2, 1, [0, 0, 1]));
    expect(security.cost_per_golden).toBeCloseTo(2 * SECURITY_PASS);
    const all = scopeOf(section, null).total;
    expect(all).toMatchObject(figures(5, 4, [2, 1, 1]));
    expect(all.cost_usd).toBeCloseTo(4 * BUGS_PASS + 2 * SECURITY_PASS);
  });
});

async function byReviewer(out: string, client = fake(), ...extra: string[]) {
  output.stdout = "";
  output.stderr = "";
  const code = await exitCodeOf(
    createProgram({ client }).parseAsync([
      "node",
      "pr-review",
      "eval-report",
      "--by-reviewer",
      "--cases",
      cases,
      "--out",
      out,
      "--format",
      "json",
      ...extra,
    ]),
  );
  const report = JSON.parse(output.stdout || "{}") as { by_reviewer?: ByReviewerSection };
  return { code, client, section: report.by_reviewer };
}

describe("pr-review eval-report --by-reviewer", () => {
  it("gives the same figures for a full record and a stage 1 record with the same reviewer findings", async () => {
    const stage1 = await byReviewer(stage1Out);
    expect(stage1.code, output.stderr).toBe(0);
    expect(stage1.client.calls).toEqual([]);
    const full = await byReviewer(fullOut);
    expect(full.code, output.stderr).toBe(0);
    expect(full.client.calls).toEqual([]);
    expect(full.section?.repeats).toEqual(stage1.section?.repeats);
    expect(stage1.section?.repeats).toEqual(stage1Report.by_reviewer?.repeats);
  });

  it("asks the judge for the pairs that the cache does not hold with --ask-missing", async () => {
    const dir = tempDir("stage1-ask", made);
    cpSync(stage1Out, dir, { recursive: true });
    rmSync(join(dir, "b-case", "1", "judge-cache.json"));
    const before = await byReviewer(dir);
    expect(scopeOf(before.section, "diff-bugs").cases[1]).toMatchObject({
      goldens: 0,
      uncached: 1,
    });
    const asked = await byReviewer(dir, fake(), "--ask-missing");
    expect(asked.code, output.stderr).toBe(0);
    expect(asked.client.calls.map((c) => c.role)).toEqual(["judge"]);
    expect(asked.section?.ask_missing?.questions).toBe(1);
    expect(asked.section?.repeats).toEqual(stage1Report.by_reviewer?.repeats);
  });

  it("prints the figures of each reviewer in the table", async () => {
    output.stdout = "";
    const code = await exitCodeOf(
      createProgram({ client: fake() }).parseAsync([
        "node",
        "pr-review",
        "eval-report",
        "--by-reviewer",
        "--cases",
        cases,
        "--out",
        stage1Out,
      ]),
    );
    expect(code, output.stderr).toBe(0);
    expect(output.stdout).toMatch(/By reviewer/);
    expect(output.stdout).toMatch(/total\s+diff-bugs\s+3\s+3\s+2\s+1\s+0\s+\$0\.8000\s+\$0\.2667/);
  });
});

describe("pr-review eval --stage1: usage and resume", () => {
  const usage: [string, string[]][] = [
    ["--paired", ["--paired"]],
    ["--baseline", ["--baseline", "b.json"]],
    ["--write-baseline", ["--write-baseline", "--baseline", "b.json"]],
  ];
  for (const [what, flags] of usage) {
    it(`exits 2 for --stage1 with ${what}, with no model call`, async () => {
      const client = fake();
      const code = await evalWith(
        cases,
        tempDir("stage1-usage", made),
        client,
        "--stage1",
        ...flags,
      );
      expect(code).toBe(2);
      expect(output.stderr).toMatch(/--stage1/);
      expect(client.calls).toEqual([]);
    }, 60_000);
  }

  it("refuses to resume a result of a run with another --stage1 value", async () => {
    const dir = tempDir("stage1-resume", made);
    cpSync(stage1Out, dir, { recursive: true });
    const client = fake();
    const code = await evalWith(cases, dir, client, "--raw-judge", "--resume");
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/other options/);
    expect(client.calls).toEqual([]);

    const full = tempDir("stage1-resume-full", made);
    cpSync(fullOut, full, { recursive: true });
    expect(await evalWith(cases, full, fake(), "--stage1", "--resume")).toBe(2);
    expect(output.stderr).toMatch(/other options/);
  }, 60_000);

  it("reuses a stage 1 result with --stage1 --resume", async () => {
    const dir = tempDir("stage1-reuse", made);
    cpSync(stage1Out, dir, { recursive: true });
    const client = fake();
    expect(await evalWith(cases, dir, client, "--stage1", "--resume")).toBe(0);
    expect(client.calls).toEqual([]);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as {
      by_reviewer?: ByReviewerSection;
    };
    expect(report.by_reviewer?.repeats).toEqual(stage1Report.by_reviewer?.repeats);
  }, 60_000);
});
