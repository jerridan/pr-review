// D8 phase 2: the by-pass report. The two passes of one reviewer are two
// samples of one pass. eval-report --by-pass scores pass 1, pass 2 and
// both from the records and the judge caches of an earlier eval.
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import {
  summarizeScope,
  type ByPassRow,
  type ByPassScope,
  type ByPassSection,
  type PassSet,
} from "../src/eval/by-pass.js";
import type { GoldenFinding } from "../src/eval/case.js";
import { ExtrasOutputSchema } from "../src/eval/score.js";
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
afterAll(() => cleanup(made));
captureOutput();

const golden = (
  file: string,
  line: number,
  category: string,
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
// A: the shared golden. P1 and P2: one golden for each pass. F: false.
const A = finding("src/stats.ts", 11, "bug", "CLAIM-A", "for (let i = 0; i <= values.length; i++) {");
const P1 = finding("src/stats.ts", 14, "bug", "CLAIM-P1", "return total / values.length;");
const P2 = finding(".github/workflows/ci.yml", 8, "security", "CLAIM-P2", "- run: npm test");
const F = finding("README.md", 3, "docs", "CLAIM-F", "A small repo for pr-review tests.");
// A2 is next to G_A with no overlap, so its pair with G_A is ambiguous.
const A2 = finding("src/stats.ts", 12, "bug", "CLAIM-A2", "total += values[i];");

const meta = (costUsd: number): QueryMeta => ({
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd,
});

const TRIAGE = 0.1;
const BUGS_PASS = [0.2, 0.3];
const SECURITY_PASS = 0.1;
const VERIFIER = 0.05;

type Findings = ReturnType<typeof finding>[];

// The findings of diff-bugs, by run (one run per case, in case order) and
// by pass. security gives nothing. The first query of a reviewer in a run
// is its pass 1: the semaphore starts the queries in arrival order.
function fake(byRun: [Findings, Findings][], judge: "yes" | "no" = "yes") {
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
        if (name === "diff-bugs") {
          const found = byRun[runs - 1]?.[pass - 1] ?? [];
          return ok({ findings: found }, BUGS_PASS[pass - 1]);
        }
        if (name === "security") return ok({ findings: [] }, SECURITY_PASS);
        return ok({ findings: [] });
      }
      case "verifier":
      case "verifier-escalation":
        return ok(
          {
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
          },
          VERIFIER,
        );
      case "judge":
        if (req.schema === ExtrasOutputSchema) return ok({ real: "no", reason: "r" });
        return ok({ same_issue: judge, reason: "r" }, 0.5);
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
}

// Run the eval with --paired into a new directory and give the directory.
async function evalRun(
  cases: string,
  client: ReturnType<typeof fake>,
  reviewers: string,
): Promise<string> {
  const out = tempDir("by-pass-out", made);
  const code = await captured(() =>
    exitCodeOf(
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
        "--paired",
        "--reviewers",
        reviewers,
        "--format",
        "json",
      ]),
    ),
  );
  if (code !== 0) throw new Error(`the eval exited ${code}: ${output.stderr}`);
  return out;
}

const noQuery = () =>
  createFakeSdkClient(() => {
    throw new Error("no query without --ask-missing");
  });

async function report(
  cases: string,
  out: string,
  extra: string[] = [],
  client: ReturnType<typeof createFakeSdkClient> = noQuery(),
) {
  output.stdout = "";
  output.stderr = "";
  const format = extra.includes("table") ? [] : ["--format", "json"];
  const code = await exitCodeOf(
    createProgram({ client }).parseAsync([
      "node",
      "pr-review",
      "eval-report",
      "--by-pass",
      "--cases",
      cases,
      "--out",
      out,
      ...format,
      ...extra,
    ]),
  );
  return { code, client };
}

const sectionOf = (): ByPassSection =>
  (JSON.parse(output.stdout) as { by_pass: ByPassSection }).by_pass;

const scopeOf = (section: ByPassSection, reviewer: string | null): ByPassScope => {
  const scope = section.repeats[0]?.scopes.find((s) => s.reviewer === reviewer);
  if (!scope) throw new Error(`no scope ${String(reviewer)}`);
  return scope;
};

let fx: Fixture;
let template = "";
let mainCases = "";
let mainOut = "";
beforeAll(async () => {
  fx = await makeFixture();
  made.push(fx.repo);
  const root = tempDir("by-pass", made);
  template = await makeTemplate(fx, root);
  mainCases = casesFrom(template, join(root, "cases"), [
    { name: "a-split", golden: [G_A, G_P1, G_P2] },
    { name: "b-false", golden: [G_A] },
    { name: "c-clean", golden: [] },
  ]);
  mainOut = await evalRun(
    mainCases,
    fake([
      [
        [A, P1],
        [A, P2],
      ],
      [[A], [A, F]],
      [[], []],
    ]),
    "diff-bugs,security",
  );
}, 180_000);

describe("pr-review eval-report --by-pass: the three sets (R1, R2)", () => {
  it("gives the figures of pass 1, pass 2 and both for each case", async () => {
    const { code, client } = await report(mainCases, mainOut);
    expect(code, output.stderr).toBe(0);
    expect(client.calls).toEqual([]);
    const bugs = scopeOf(sectionOf(), "diff-bugs");
    expect(bugs.cases.map((c) => c.case)).toEqual(["a-split", "b-false", "c-clean"]);
    const [a, b, c] = bugs.cases;

    expect(a?.pass_1).toMatchObject({ goldens: 2, posted: 2, false_posted: 0, precision: 1 });
    expect(a?.pass_1.raw_goldens).toBe(2);
    expect(a?.pass_1.cost_usd).toBeCloseTo(0.2 + 2 * VERIFIER);
    expect(a?.pass_2).toMatchObject({ goldens: 2, posted: 2, false_posted: 0, precision: 1 });
    expect(a?.pass_2.cost_usd).toBeCloseTo(0.3 + 2 * VERIFIER);
    expect(a?.both).toMatchObject({ goldens: 3, posted: 3, false_posted: 0, raw_goldens: 3 });
    // A verification with sources in both passes counts once in both.
    expect(a?.both.cost_usd).toBeCloseTo(0.5 + 3 * VERIFIER);

    expect(b?.pass_1).toMatchObject({ goldens: 1, posted: 1, false_posted: 0, precision: 1 });
    expect(b?.pass_2).toMatchObject({ goldens: 1, posted: 2, false_posted: 1, precision: 0.5 });
    expect(b?.both).toMatchObject({ goldens: 1, posted: 2, false_posted: 1, precision: 0.5 });

    expect(c?.pass_1).toMatchObject({ goldens: 0, posted: 0, precision: null });
    expect(c?.both).toMatchObject({ goldens: 0, posted: 0, precision: null });
    expect(c?.both.cost_usd).toBeCloseTo(0.5);
  });

  it("sums the sets over the cases, by label, with a pooled precision", async () => {
    await report(mainCases, mainOut);
    const { total } = scopeOf(sectionOf(), "diff-bugs");
    expect(total.pass_1).toMatchObject({
      goldens: 3,
      by_label: { blocking: 2, suggestion: 1, nit: 0 },
      posted: 3,
      false_posted: 0,
      precision: 1,
      raw_goldens: 3,
    });
    expect(total.pass_2).toMatchObject({
      goldens: 3,
      by_label: { blocking: 2, suggestion: 0, nit: 1 },
      posted: 4,
      false_posted: 1,
      precision: 0.75,
    });
    expect(total.both).toMatchObject({
      goldens: 4,
      by_label: { blocking: 2, suggestion: 1, nit: 1 },
      posted: 5,
      false_posted: 1,
      precision: 0.8,
    });
    expect(total.pass_1.cost_usd).toBeCloseTo(0.75);
    expect(total.pass_2.cost_usd).toBeCloseTo(1.1);
    expect(total.both.cost_usd).toBeCloseTo(1.75);
  });

  it("gives the goldens and the false findings that only one pass has", async () => {
    await report(mainCases, mainOut);
    const bugs = scopeOf(sectionOf(), "diff-bugs");
    const [a, b] = bugs.cases;
    expect(a).toMatchObject({ only_pass_1_goldens: 1, only_pass_2_goldens: 1 });
    expect(a).toMatchObject({ only_pass_1_false: 0, only_pass_2_false: 0 });
    expect(b).toMatchObject({ only_pass_1_goldens: 0, only_pass_2_goldens: 0 });
    expect(b).toMatchObject({ only_pass_1_false: 0, only_pass_2_false: 1 });
    expect(bugs.total).toMatchObject({
      only_pass_1_goldens: 1,
      only_pass_2_goldens: 1,
      only_pass_1_false: 0,
      only_pass_2_false: 1,
    });
  });

  it("keeps the findings and the queries of other reviewers out of a reviewer scope", async () => {
    await report(mainCases, mainOut);
    const section = sectionOf();
    expect(section.repeats[0]?.scopes.map((s) => s.reviewer)).toEqual([
      null,
      "diff-bugs",
      "security",
    ]);
    const security = scopeOf(section, "security");
    expect(security.total.both).toMatchObject({ goldens: 0, posted: 0, precision: null });
    expect(security.total.pass_1.cost_usd).toBeCloseTo(3 * SECURITY_PASS);
    // The scope of every reviewer adds the security queries to diff-bugs.
    const every = scopeOf(section, null);
    expect(every.total.both).toMatchObject({ goldens: 4, posted: 5 });
    expect(every.total.both.cost_usd).toBeCloseTo(1.75 + 6 * SECURITY_PASS);
  });
});

describe("pr-review eval-report --by-pass: the one-pass arm and the decision (R3, R4)", () => {
  it("gives the one-pass mean, the noise of one pass and what both adds", async () => {
    await report(mainCases, mainOut);
    const bugs = scopeOf(sectionOf(), "diff-bugs");
    expect(bugs.one_pass.goldens).toBe(3);
    expect(bugs.one_pass.precision).toBeCloseTo(6 / 7);
    expect(bugs.one_pass.cost_usd).toBeCloseTo(0.925);
    expect(bugs.one_pass.cost_per_golden).toBeCloseTo(0.925 / 3);
    expect(bugs.noise).toMatchObject({ goldens: 0, false_posted: -1 });
    expect(bugs.noise.precision).toBeCloseTo(0.25);
    expect(bugs.cases.map((c) => c.added_goldens)).toEqual([1, 0, 0]);
    expect(bugs.cases.map((c) => c.added_false)).toEqual([0, 0.5, 0]);
    expect(bugs.added.goldens).toBe(1);
    expect(bugs.added.false_posted).toBeCloseTo(0.5);
    expect(bugs.added.cost_usd).toBeCloseTo(0.825);
    expect(bugs.added.cost_per_golden).toBeCloseTo(0.825);
    expect(bugs.added.goldens_per_case.mean).toBeCloseTo(1 / 3);
    expect(bugs.added.goldens_per_case.lower).toBe(0);
    expect(bugs.added.goldens_per_case.upper).toBeCloseTo(2 / 3);
  });

  it("counts a resample with no added golden as a ratio above 2, so (b) fails", async () => {
    await report(mainCases, mainOut);
    const bugs = scopeOf(sectionOf(), "diff-bugs");
    expect(bugs.decision.ratio.value).toBeCloseTo(0.825 / (0.925 / 3));
    expect(bugs.decision.ratio.unbounded_resamples).toBeGreaterThan(0);
    expect(bugs.decision.ratio.unbounded_resamples).toBeLessThan(10000);
    expect(bugs.decision.ratio.upper).toBeNull();
    expect(bugs.decision.ratio.passed).toBe(false);
    expect(bugs.decision.precision.passed).toBe(false);
    expect(bugs.decision.result).toBe("stays at 1");
    const security = scopeOf(sectionOf(), "security");
    // A null precision fails (c).
    expect(security.decision.precision).toMatchObject({ both: null, passed: false });
    expect(scopeOf(sectionOf(), null).decision.information_only).toBe(true);
    expect(bugs.decision.information_only).toBe(false);
  });

  it("gives the same bootstrap on two runs, and states the seed and the resamples", async () => {
    await report(mainCases, mainOut);
    const first = sectionOf();
    await report(mainCases, mainOut);
    expect(sectionOf()).toEqual(first);
    expect(first.bootstrap).toMatchObject({ resamples: 10000, level: 0.9 });
    expect(typeof first.bootstrap.seed).toBe("number");

    await report(mainCases, mainOut, ["--format", "table"]);
    expect(output.stdout).toContain(`seed ${first.bootstrap.seed}`);
    expect(output.stdout).toContain("10000 resamples");
    expect(output.stdout).toMatch(/reviewer diff-bugs[\s\S]*stays at 1/);
  });
});

describe("pr-review eval-report --by-pass: unanswered judge questions (R5)", () => {
  let cases = "";
  let out = "";
  beforeAll(async () => {
    const root = tempDir("by-pass-judge", made);
    cases = casesFrom(template, join(root, "cases"), [{ name: "d-judge", golden: [G_A] }]);
    // Pass 1 takes G_A with an exact match, so the live run never asks
    // about A2 and G_A. The pass-2 set needs that answer.
    out = await evalRun(cases, fake([[[A], [A2]]]), "diff-bugs");
  }, 120_000);

  it("counts the question as no match, and sends no query, without --ask-missing", async () => {
    const { code, client } = await report(cases, out);
    expect(code, output.stderr).toBe(0);
    expect(client.calls).toEqual([]);
    const bugs = scopeOf(sectionOf(), "diff-bugs");
    expect(bugs.total.pass_2).toMatchObject({ goldens: 0, uncached: 1 });
    expect(bugs.total.pass_1).toMatchObject({ goldens: 1, uncached: 0 });
    expect(sectionOf().ask_missing).toBeNull();
  });

  it("asks the judge for those questions only with --ask-missing, and caches the answers", async () => {
    const dir = tempDir("by-pass-ask", made);
    cpSync(out, dir, { recursive: true });
    const client = fake([], "yes");
    const { code } = await report(cases, dir, ["--ask-missing"], client);
    expect(code, output.stderr).toBe(0);
    expect(client.calls.map((c) => c.role)).toEqual(["judge"]);
    const section = sectionOf();
    expect(section.ask_missing?.questions).toBe(1);
    expect(section.ask_missing?.cost_usd).toBeCloseTo(0.5);
    expect(scopeOf(section, "diff-bugs").total.pass_2).toMatchObject({ goldens: 1, uncached: 0 });
    const cache = JSON.parse(readFileSync(join(dir, "d-judge", "1", "judge-cache.json"), "utf8"));
    expect(Object.values(cache.answers)).toContain("yes");

    // A later offline run reads the new answer.
    const later = await report(cases, dir);
    expect(later.client.calls).toEqual([]);
    expect(scopeOf(sectionOf(), "diff-bugs").total.pass_2).toMatchObject({
      goldens: 1,
      uncached: 0,
    });
  });

  it("prints the count of the unanswered questions in the table", async () => {
    await report(cases, out, ["--format", "table"]);
    expect(output.stdout).toMatch(/unanswered judge questions: pass 1 0, pass 2 1, both 0/i);
  });

  it("refuses --ask-missing without --by-pass", async () => {
    output.stderr = "";
    const code = await exitCodeOf(
      createProgram({ client: noQuery() }).parseAsync([
        "node",
        "pr-review",
        "eval-report",
        "--ask-missing",
        "--cases",
        cases,
        "--out",
        out,
      ]),
    );
    expect(code).toBe(2);
  });
});

// The decision of one scope from its case rows, with no record.
const set = (goldens: number, posted: number, cost: number): PassSet => ({
  goldens,
  by_label: { blocking: goldens, suggestion: 0, nit: 0 },
  posted,
  false_posted: posted - goldens,
  precision: posted === 0 ? null : goldens / posted,
  cost_usd: cost,
  raw_goldens: goldens,
  uncached: 0,
});
const row = (name: string, p1: PassSet, p2: PassSet, both: PassSet): { case: string } & ByPassRow => ({
  case: name,
  pass_1: p1,
  pass_2: p2,
  both,
  only_pass_1_goldens: 0,
  only_pass_2_goldens: 0,
  only_pass_1_false: 0,
  only_pass_2_false: 0,
});
// Each single pass finds 2 of its 2 posted for $1; both find 3 of 3 for
// $1.50. So R = (0.5 / 1) / (1 / 2) = 1.
const gains = (name: string) => row(name, set(2, 2, 1), set(2, 2, 1), set(3, 3, 1.5));
const flat = (name: string) => row(name, set(2, 2, 1), set(2, 2, 1), set(2, 2, 1.5));

describe("the decision of a scope (R4)", () => {
  it("passes (b) and (c), and gives passes 2, when every resample has R = 1", () => {
    const scope = summarizeScope("history", [gains("x"), gains("y"), gains("z")]);
    expect(scope.decision.ratio).toMatchObject({
      value: 1,
      lower: 1,
      upper: 1,
      unbounded_resamples: 0,
      limit: 2,
      passed: true,
    });
    expect(scope.decision.precision.passed).toBe(true);
    expect(scope.decision.result).toBe("passes 2");
  });

  it("fails (b) when a resample with no added golden can reach the upper end", () => {
    // One draw in four takes the flat case twice: no added golden.
    const scope = summarizeScope("history", [gains("x"), flat("y")]);
    expect(scope.decision.ratio.value).toBeCloseTo(2);
    expect(scope.decision.ratio.upper).toBeNull();
    expect(scope.decision.ratio.unbounded_resamples).toBeGreaterThan(1000);
    expect(scope.decision.ratio.passed).toBe(false);
    expect(scope.decision.result).toBe("stays at 1");
  });

  it("counts a resample with no one-pass golden as a ratio above 2", () => {
    const none = row("y", set(0, 0, 1), set(0, 0, 1), set(1, 1, 1.5));
    const scope = summarizeScope("history", [none, none]);
    expect(scope.decision.ratio).toMatchObject({ value: null, upper: null, passed: false });
    expect(scope.decision.ratio.unbounded_resamples).toBe(10000);
  });

  it("fails (b) when the upper end of R is above 2", () => {
    // R = (2 / 1) / (1 / 2) = 4 in every resample.
    const dear = row("x", set(2, 2, 1), set(2, 2, 1), set(3, 3, 3));
    const scope = summarizeScope("history", [dear, dear]);
    expect(scope.decision.ratio).toMatchObject({ value: 4, upper: 4, passed: false });
    expect(scope.decision.result).toBe("stays at 1");
  });

  it("passes (c) at 0.05 below the one-pass precision, and fails below that", () => {
    const at = row("x", set(2, 2, 1), set(2, 2, 1), set(19, 20, 1.5));
    expect(summarizeScope("h", [at]).decision.precision).toMatchObject({
      both: 0.95,
      one_pass: 1,
      passed: true,
    });
    const below = row("x", set(2, 2, 1), set(2, 2, 1), set(18, 20, 1.5));
    const scope = summarizeScope("h", [below]);
    expect(scope.decision.precision.passed).toBe(false);
    expect(scope.decision.result).toBe("stays at 1");
  });

  it("gives the same intervals on two calls", () => {
    const rows = [gains("x"), flat("y"), gains("z")];
    expect(summarizeScope("h", rows)).toEqual(summarizeScope("h", rows));
  });
});
