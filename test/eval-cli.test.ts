import { execFile, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { GoldenFinding } from "../src/eval/case.js";
import type { Report } from "../src/eval/report.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const FIXTURE_SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));
const MAKE_CASE = fileURLToPath(new URL("../scripts/make-case.sh", import.meta.url));
const RUN_TIMEOUT = 120_000;

// Do not let the user's git config change a commit that a test makes.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

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

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.trim();
}

let fx: Fixture;
// A fixture whose base commit gives the conventions reviewer the judge model.
let sameJudgeFx: Fixture;
let work: string;
// One case directory per fixture, from scripts/make-case.sh, with no golden.json.
let template: string;
let sameJudgeTemplate: string;
// A fixture whose base commit holds a .pr-review/ config that is not valid,
// so each run of its case throws (R3.10).
let brokenFx: Fixture;
let brokenTemplate: string;

/** Build a fixture whose base commit holds a .pr-review/config.yaml with this text. */
async function fixtureWithConfig(configYaml: string): Promise<Fixture> {
  const source = mkdtempSync(join(tmpdir(), "pr-review-eval-cli-config-"));
  try {
    mkdirSync(join(source, "dir"));
    writeFileSync(join(source, "dir", "config.yaml"), configYaml);
    return await makeFixture("--pr-review-dir", join(source, "dir"));
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  fx = await makeFixture();
  sameJudgeFx = await fixtureWithConfig("reviewers:\n  conventions:\n    model: sonnet\n");
  brokenFx = await fixtureWithConfig("concurrency: 0\n");
  work = mkdtempSync(join(tmpdir(), "pr-review-eval-cli-"));
  const templates = join(work, "templates");
  mkdirSync(templates);
  await run("bash", [MAKE_CASE, fx.repo, fx.base, fx.head, "plain"], { cwd: templates });
  await run("bash", [MAKE_CASE, sameJudgeFx.repo, sameJudgeFx.base, sameJudgeFx.head, "same"], {
    cwd: templates,
  });
  await run("bash", [MAKE_CASE, brokenFx.repo, brokenFx.base, brokenFx.head, "broken"], {
    cwd: templates,
  });
  template = join(templates, "plain");
  sameJudgeTemplate = join(templates, "same");
  brokenTemplate = join(templates, "broken");
}, 60_000);

afterAll(() => {
  for (const dir of [fx?.repo, sameJudgeFx?.repo, brokenFx?.repo, work]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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
  vi.unstubAllEnvs();
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

let dirCount = 0;
function newDir(label: string): string {
  dirCount += 1;
  const dir = join(work, `${label}-${dirCount}`);
  mkdirSync(dir);
  return dir;
}

const PLANTED = (): GoldenFinding => ({
  file: fx.file,
  start_line: fx.line,
  end_line: fx.line,
  category: "bug",
  severity: "blocking",
  claim: "The loop reads one element past the end of the list.",
});

// A golden finding that no scripted finding matches or comes near.
const UNMATCHED: GoldenFinding = {
  file: "README.md",
  start_line: 1,
  end_line: 1,
  category: "docs",
  severity: "nit",
  claim: "The title does not name the project.",
};

type CaseSpec = {
  name: string;
  golden: GoldenFinding[];
  title?: string;
  body?: string;
  from?: string;
};

/** Write a cases directory with one case per spec. */
function casesDir(specs: CaseSpec[], root = newDir("cases")): string {
  for (const spec of specs) {
    const dir = join(root, spec.name);
    cpSync(spec.from ?? template, dir, { recursive: true });
    const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as Record<
      string,
      unknown
    >;
    meta.name = spec.name;
    if (spec.title !== undefined) meta.title = spec.title;
    if (spec.body !== undefined) meta.body = spec.body;
    writeFileSync(join(dir, "case.json"), JSON.stringify(meta));
    writeFileSync(join(dir, "golden.json"), JSON.stringify({ findings: spec.golden }));
  }
  return root;
}

/** A case whose run fails, then a case whose run succeeds. */
function brokenCases(): string {
  return casesDir([
    { name: "a-broken", from: brokenTemplate, golden: [PLANTED()] },
    { name: "b-unmatched", golden: [UNMATCHED] },
  ]);
}

function twoCases(): string {
  return casesDir([
    { name: "a-planted", golden: [PLANTED()] },
    { name: "b-unmatched", golden: [UNMATCHED] },
  ]);
}

const TRIAGE_COST = 0.1;

function meta(costUsd: number): QueryMeta {
  return {
    model: "m",
    durationMs: 1,
    stopReason: "end_turn",
    subtype: "success",
    usage: {},
    costUsd,
  };
}

type ScriptOptions = {
  /** In the even runs, the conventions reviewer reports the planted finding only. */
  vary?: boolean;
  judgeAnswer?: "yes" | "no";
  judgeCost?: number;
  /** Wait a moment in each query, so two runs at one time would overlap. */
  delay?: boolean;
};

/**
 * A fake client. Only the conventions reviewer reports findings: the
 * planted bug, and a finding on the new CI file. Every verifier passes
 * them. Only triage and the judge have a cost.
 */
function evalFake(opts: ScriptOptions = {}) {
  let runs = 0;
  return createFakeSdkClient(async (req: QueryRequest): Promise<QueryOutcome<unknown>> => {
    if (opts.delay) await new Promise((resolve) => setTimeout(resolve, 2));
    if (req.role === "triage") runs += 1;
    const out = (output: unknown, cost = 0): QueryOutcome<unknown> => ({
      ok: true,
      output,
      raw: meta(cost),
    });
    switch (req.role) {
      case "triage":
        return out(
          {
            tier: "full",
            reason: "r",
            confidence: "high",
            categories: ["bug"],
            hotspots: [],
            file_notes: [],
            summary: "s",
          },
          TRIAGE_COST,
        );
      case "reviewer": {
        if (req.reviewerName !== "conventions") return out({ findings: [] });
        const planted = {
          file: fx.file,
          start_line: fx.line,
          end_line: fx.line,
          category: "bug",
          severity_estimate: "blocking",
          confidence: "high",
          claim: "CLAIM-off-by-one",
          evidence: "for (let i = 0; i <= values.length; i++) {",
          explanation: "e",
          needs_context: false,
        };
        const ci = {
          file: ".github/workflows/ci.yml",
          start_line: 7,
          end_line: 7,
          category: "security",
          severity_estimate: "blocking",
          confidence: "high",
          claim: "CLAIM-ci",
          evidence: "- run: npm test",
          explanation: "e",
          needs_context: false,
        };
        const evenRun = runs % 2 === 0;
        return out({ findings: opts.vary && evenRun ? [planted] : [planted, ci] });
      }
      case "verifier":
      case "verifier-escalation":
        return out({
          in_scope: true,
          claim_holds: true,
          introduced_by_pr: true,
          quotes: ["i <= values.length", "run: npm test"],
          rationale: "r",
          score: 95,
          severity: "blocking",
        });
      case "merge":
        return out({
          merged: [{ member_index: 0, claim: "merged", explanation: "e", severity: "blocking" }],
        });
      case "judge":
        return out({ same_issue: opts.judgeAnswer ?? "yes", reason: "r" }, opts.judgeCost ?? 0.25);
      default:
        return out({ ok: true, word: "pong" });
    }
  });
}

type Fake = ReturnType<typeof evalFake>;

async function evalCli(fake: Fake, cases: string, ...extra: string[]) {
  const out = newDir("out");
  const code = await exitCodeOf(
    createProgram({ client: fake }).parseAsync([
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
  return { code, out };
}

async function evalJson(fake: Fake, cases: string, ...extra: string[]) {
  const result = await evalCli(fake, cases, "--format", "json", ...extra);
  const report = result.code === 2 ? null : (JSON.parse(stdout) as Report);
  return { ...result, report };
}

function recordsUnder(out: string): { path: string; record: RunRecord }[] {
  const found: { path: string; record: RunRecord }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json") && entry.name !== "report.json") {
        found.push({ path: full, record: JSON.parse(readFileSync(full, "utf8")) as RunRecord });
      }
    }
  };
  walk(out);
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const judgeCalls = (fake: Fake) => fake.calls.filter((c) => c.role === "judge");

describe("pr-review eval: the end-to-end report (R10.1, R5.1, R5.4, R5.6)", () => {
  it(
    "gives recall, precision, findings, cost and spread from the script, over two cases and two repeats",
    async () => {
      const { code, report } = await evalJson(evalFake(), twoCases(), "--repeat", "2");
      expect(code, stderr).toBe(0);
      if (!report) throw new Error("no report");
      expect(report.cases.map((c) => c.name)).toEqual(["a-planted", "b-unmatched"]);
      const values = report.cases.map((c) =>
        c.repeats.map((r) => [r.repeat, r.recall, r.precision, r.posted, r.cost_usd, r.failed]),
      );
      expect(values).toEqual([
        [
          [1, 1, 0.5, 2, TRIAGE_COST, false],
          [2, 1, 0.5, 2, TRIAGE_COST, false],
        ],
        [
          [1, 0, 0, 2, TRIAGE_COST, false],
          [2, 0, 0, 2, TRIAGE_COST, false],
        ],
      ]);
      expect(report.repeats).toEqual([
        { repeat: 1, recall: 0.5, precision: 0.25, findings_per_case: 2, cost_per_case: 0.1 },
        { repeat: 2, recall: 0.5, precision: 0.25, findings_per_case: 2, cost_per_case: 0.1 },
      ]);
      expect(report.aggregate).toEqual({
        recall: { mean: 0.5, min: 0.5, max: 0.5 },
        precision: { mean: 0.25, min: 0.25, max: 0.25 },
        findings_per_case: { mean: 2, min: 2, max: 2 },
        cost_per_case: { mean: 0.1, min: 0.1, max: 0.1 },
      });
      expect(report.judge).toEqual({ calls: 0, unknown: 0, cost_usd: 0 });
      expect(report.failed_repeats).toEqual([]);
      expect(report.gate).toBeNull();
      for (const key of ["cases", "repeats", "aggregate", "judge", "failed_repeats", "gate"]) {
        expect(report).toHaveProperty(key);
      }
      for (const r of report.cases.flatMap((c) => c.repeats)) {
        for (const key of [
          "repeat",
          "failed",
          "recall",
          "precision",
          "posted",
          "cost_usd",
          "run_ms",
          "judge_calls",
          "judge_cost_usd",
        ]) {
          expect(r).toHaveProperty(key);
        }
        expect(r.severity_agreement).toEqual(
          r.recall === 1 ? { same: 1, matched: 1 } : { same: 0, matched: 0 },
        );
        expect(r.run_ms).toBeGreaterThanOrEqual(0);
      }
    },
    RUN_TIMEOUT,
  );

  it(
    "gives a different minimum and maximum when the findings vary between repeats",
    async () => {
      const { code, report } = await evalJson(
        evalFake({ vary: true }),
        twoCases(),
        "--repeat",
        "2",
      );
      expect(code, stderr).toBe(0);
      if (!report) throw new Error("no report");
      expect(
        report.repeats.map((r) => [r.repeat, r.recall, r.precision, r.findings_per_case]),
      ).toEqual([
        [1, 0.5, 0.25, 2],
        [2, 0.5, 0.5, 1],
      ]);
      expect(report.aggregate.precision).toEqual({ mean: 0.375, min: 0.25, max: 0.5 });
      expect(report.aggregate.findings_per_case).toEqual({ mean: 1.5, min: 1, max: 2 });
      expect(report.aggregate.recall).toEqual({ mean: 0.5, min: 0.5, max: 0.5 });
    },
    RUN_TIMEOUT,
  );
});

describe("pr-review eval: the runs (R3.2 to R3.7)", () => {
  it(
    "runs each case and each repeat in sequence, with one record directory per run",
    async () => {
      const fake = evalFake({ delay: true });
      const { code, out } = await evalCli(fake, twoCases(), "--repeat", "2", "--format", "json");
      expect(code, stderr).toBe(0);
      for (const name of ["a-planted", "b-unmatched"]) {
        for (const repeat of ["1", "2"]) {
          const files = readdirSync(join(out, name, repeat)).filter((f) => f.endsWith(".json"));
          expect(files, `${name}/${repeat}`).toHaveLength(1);
        }
      }
      expect(fake.calls.filter((c) => c.role === "triage")).toHaveLength(4);
      // Each run has its own checkouts. The queries of one checkout form one
      // block, so no two runs overlap.
      const cwds = fake.calls.map((c) => c.cwd);
      const blocks = cwds.filter((cwd, i) => i === 0 || cwds[i - 1] !== cwd);
      expect(new Set(blocks).size).toBe(blocks.length);
    },
    RUN_TIMEOUT,
  );

  it(
    "writes a record equal to the record of pr-review run, apart from the repo, the time and the description",
    async () => {
      const runOut = newDir("run-out");
      const runCode = await exitCodeOf(
        createProgram({ client: evalFake() }).parseAsync([
          "node",
          "pr-review",
          "run",
          "--repo",
          fx.repo,
          "--base",
          fx.base,
          "--head",
          fx.head,
          "--tier",
          "full",
          "--format",
          "json",
          "--out",
          runOut,
        ]),
      );
      expect(runCode, stderr).toBe(0);
      const { code, out } = await evalCli(
        evalFake(),
        casesDir([{ name: "only", golden: [PLANTED()] }]),
        "--repeat",
        "1",
        "--format",
        "json",
      );
      expect(code, stderr).toBe(0);
      const strip = (r: RunRecord) => {
        const copy = structuredClone(r) as unknown as {
          identity: Record<string, unknown>;
          cost: { stage_ms: unknown; queries: Record<string, unknown>[] };
        };
        for (const key of ["repo", "started_at", "description", "description_meta"]) {
          delete copy.identity[key];
        }
        copy.cost.stage_ms = null;
        for (const q of copy.cost.queries) delete q.duration_ms;
        return copy;
      };
      const [fromRun] = recordsUnder(runOut);
      const [fromEval] = recordsUnder(out);
      if (!fromRun || !fromEval) throw new Error("a record is missing");
      expect(strip(fromEval.record)).toEqual(strip(fromRun.record));
    },
    RUN_TIMEOUT,
  );

  it(
    "takes the description from the case title and body through the sanitizer, and makes no gh call",
    async () => {
      // A gh shim first on the PATH records each call and fails. A real gh
      // later on the PATH is never reached, so the test holds with gh installed.
      const bin = newDir("bin");
      const calls = join(bin, "gh-calls.log");
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`, {
        mode: 0o755,
      });
      vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
      expect(execFileSync("bash", ["-c", "command -v gh"], { encoding: "utf8" }).trim()).toBe(
        join(bin, "gh"),
      );
      const cases = casesDir([
        {
          name: "described",
          golden: [PLANTED()],
          title: "CASE-TITLE fixes the average",
          body: "CASE-BODY visible <!-- HIDDEN-COMMENT --> text",
        },
      ]);
      const { code, out } = await evalCli(evalFake(), cases, "--repeat", "1", "--format", "json");
      expect(code, stderr).toBe(0);
      const [only] = recordsUnder(out);
      if (!only) throw new Error("no record");
      const { description, description_meta } = only.record.identity;
      expect(description).toContain("CASE-TITLE fixes the average");
      expect(description).toContain("CASE-BODY visible");
      expect(description).not.toContain("HIDDEN-COMMENT");
      expect(description_meta).toEqual({ source: "pr", sanitized: true, truncated: false });
      expect(existsSync(calls), "the eval called gh").toBe(false);
    },
    RUN_TIMEOUT,
  );

  it(
    "runs at the full tier by default and at the tier that --tier names, and writes valid records",
    async () => {
      const cases = casesDir([{ name: "tiered", golden: [PLANTED()] }]);
      const full = await evalCli(evalFake(), cases, "--repeat", "1", "--format", "json");
      expect(full.code, stderr).toBe(0);
      const fast = await evalCli(
        evalFake(),
        cases,
        "--repeat",
        "1",
        "--format",
        "json",
        "--tier",
        "fast",
      );
      expect(fast.code, stderr).toBe(0);
      const tiers = [full.out, fast.out].map((out) =>
        recordsUnder(out).map((r) => r.record.identity.tier),
      );
      expect(tiers).toEqual([["full"], ["fast"]]);
      for (const { record } of [...recordsUnder(full.out), ...recordsUnder(fast.out)]) {
        expect(RecordSchema.safeParse(record).error).toBeUndefined();
      }
    },
    RUN_TIMEOUT,
  );

  it(
    "uses the description of the case and not the content of diff.patch (R1.7)",
    async () => {
      const first = await evalJson(evalFake(), twoCases(), "--repeat", "1");
      const changed = twoCases();
      for (const name of ["a-planted", "b-unmatched"]) {
        writeFileSync(join(changed, name, "diff.patch"), "Some other text, not a diff.\n");
      }
      stdout = "";
      const second = await evalJson(evalFake(), changed, "--repeat", "1");
      const withoutTime = (r: Report | null) =>
        JSON.parse(JSON.stringify(r), (key, value: unknown) => (key === "run_ms" ? 0 : value));
      expect(second.code).toBe(0);
      expect(withoutTime(second.report)).toEqual(withoutTime(first.report));
    },
    RUN_TIMEOUT,
  );
});

describe("pr-review eval: failed repeats (R3.8, R3.11)", () => {
  it(
    "lists a run that fails, gives it null metrics, finishes the other runs and exits 1",
    async () => {
      const { code, report } = await evalJson(evalFake(), brokenCases(), "--repeat", "1");
      expect(code).toBe(1);
      if (!report) throw new Error("no report");
      expect(report.failed_repeats).toHaveLength(1);
      expect(report.failed_repeats[0]).toMatchObject({ case: "a-broken", repeat: 1 });
      expect(report.failed_repeats[0]?.error).toContain("concurrency");
      const failed = report.cases[0]?.repeats[0];
      expect(failed).toMatchObject({ failed: true, recall: null, precision: null, cost_usd: null });
      expect(report.cases[1]?.repeats).toMatchObject([
        { repeat: 1, failed: false, recall: 0, precision: 0, posted: 2, cost_usd: TRIAGE_COST },
      ]);
      expect(report.aggregate.findings_per_case.mean).toBe(2);
      expect(stderr).toContain("a-broken");
    },
    RUN_TIMEOUT,
  );

  it(
    "exits 1 with a failed repeat and a failed gate, and reports the gate",
    async () => {
      const baseline = join(newDir("baseline"), "baseline.json");
      writeFileSync(baseline, JSON.stringify(baselineFile({ recall: 1, precision: 1 })));
      const { code, report } = await evalJson(
        evalFake(),
        brokenCases(),
        "--repeat",
        "1",
        "--baseline",
        baseline,
      );
      expect(code).toBe(1);
      expect(report?.gate?.passed).toBe(false);
    },
    RUN_TIMEOUT,
  );
});

describe("pr-review eval: usage errors (R3.1, R3.9)", () => {
  it("lists every flag with its default in --help", async () => {
    const code = await exitCodeOf(
      createProgram({ client: evalFake() }).parseAsync(["node", "pr-review", "eval", "--help"]),
    );
    expect(code).toBe(0);
    for (const flag of [
      "--cases <dir>",
      "--repeat <n>",
      "--baseline <file>",
      "--write-baseline",
      "--out <dir>",
      "--format <format>",
      "--tier <tier>",
      "--judge-model <id>",
      "--allow-api-key",
      "--allow-same-judge",
    ]) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain("(default: 3)");
    expect(stdout).toContain('(default: "pr-review-eval")');
    expect(stdout).toContain('default: "table"');
    expect(stdout).toContain('default: "full"');
    expect(stdout).toContain("claude-sonnet-5-5");
  });

  it.each<[string, string[], string]>([
    ["no --cases", [], "--cases"],
    ["--repeat 0", ["--repeat", "0"], "--repeat"],
    ["--repeat -1", ["--repeat", "-1"], "--repeat"],
    ["--repeat 1.5", ["--repeat", "1.5"], "--repeat"],
    ["--repeat abc", ["--repeat", "abc"], "--repeat"],
    ["--format xml", ["--format", "xml"], "--format"],
    ["--tier medium", ["--tier", "medium"], "--tier"],
    ["--write-baseline without --baseline", ["--write-baseline"], "--baseline"],
  ])(
    "exits 2 for %s, with no query and a message that names the flag",
    async (label, extra, flag) => {
      const fake = evalFake();
      const cases = label === "no --cases" ? [] : ["--cases", template];
      const code = await exitCodeOf(
        createProgram({ client: fake }).parseAsync([
          "node",
          "pr-review",
          "eval",
          ...cases,
          ...extra,
        ]),
      );
      expect(code).toBe(2);
      expect(stderr).toContain(flag);
      expect(fake.calls).toHaveLength(0);
    },
  );
});

describe("pr-review eval: invalid cases (R1, R10.4)", () => {
  async function expectInvalid(cases: string, caseName: string | null) {
    const fake = evalFake();
    const { code, out } = await evalCli(fake, cases, "--repeat", "1");
    expect(code).toBe(2);
    if (caseName !== null) expect(stderr).toContain(caseName);
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(join(out, "report.json"))).toBe(false);
  }

  it.each(["repo.bundle", "diff.patch", "golden.json"])(
    "exits 2 for a case without %s",
    async (file) => {
      const cases = twoCases();
      rmSync(join(cases, "b-unmatched", file));
      await expectInvalid(cases, "b-unmatched");
    },
  );

  it.each<[string, (meta: Record<string, unknown>) => void]>([
    ["a missing field", (meta) => delete meta.title],
    ["a wrong type", (meta) => (meta.head = 7)],
    ["a source outside the six values", (meta) => (meta.source = "github")],
    ["a name unequal to the directory name", (meta) => (meta.name = "elsewhere")],
  ])("exits 2 for case.json with %s", async (_label, change) => {
    const cases = twoCases();
    const file = join(cases, "b-unmatched", "case.json");
    const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    change(meta);
    writeFileSync(file, JSON.stringify(meta));
    await expectInvalid(cases, "b-unmatched");
  });

  it.each<[string, Partial<GoldenFinding> | Record<string, unknown>]>([
    ["an unknown category", { category: "style" }],
    ["an unknown severity", { severity: "critical" }],
    ["a start_line below 1", { start_line: 0, end_line: 0 }],
    ["an end_line below start_line", { start_line: 9, end_line: 8 }],
  ])("exits 2 for golden.json with %s", async (_label, change) => {
    const cases = casesDir([
      { name: "a-planted", golden: [PLANTED()] },
      { name: "b-bad", golden: [{ ...UNMATCHED, ...change } as GoldenFinding] },
    ]);
    await expectInvalid(cases, "b-bad");
  });

  it(
    "exits 2 for a bundle that lacks the base sha, before any query",
    async () => {
      const cases = twoCases();
      // A bundle of the head branch only. The base commit comes after the fork.
      await git(fx.repo, [
        "bundle",
        "create",
        "--quiet",
        join(cases, "b-unmatched", "repo.bundle"),
        "feature",
      ]);
      await expectInvalid(cases, "b-unmatched");
      expect(stderr).toContain(fx.base);
    },
    RUN_TIMEOUT,
  );

  it("exits 2 for an empty cases directory", async () => {
    const empty = newDir("empty");
    await expectInvalid(empty, null);
    expect(stderr).toContain(empty);
    expect(stderr).toContain("no case");
  });

  it(
    "reports only the subdirectories with case.json, in name order",
    async () => {
      const cases = casesDir([
        { name: "z-last", golden: [UNMATCHED] },
        { name: "m-first", golden: [PLANTED()] },
      ]);
      mkdirSync(join(cases, "notes"));
      writeFileSync(join(cases, "notes", "README.md"), "Not a case.\n");
      const { code, report } = await evalJson(evalFake(), cases, "--repeat", "1");
      expect(code, stderr).toBe(0);
      expect(report?.cases.map((c) => c.name)).toEqual(["m-first", "z-last"]);
    },
    RUN_TIMEOUT,
  );
});

describe("pr-review eval: the judge (R4.4, R5.2)", () => {
  it(
    "keeps the judge cost out of cost_usd",
    async () => {
      // The golden overlaps the planted finding with another category: an ambiguous pair.
      const cases = casesDir([
        { name: "judged", golden: [{ ...PLANTED(), category: "security" }] },
      ]);
      const fake = evalFake({ judgeCost: 0.25, judgeAnswer: "yes" });
      const { code, report } = await evalJson(fake, cases, "--repeat", "1");
      expect(code, stderr).toBe(0);
      expect(judgeCalls(fake)).toHaveLength(1);
      const [r] = report?.cases[0]?.repeats ?? [];
      expect(r).toMatchObject({
        cost_usd: TRIAGE_COST,
        judge_cost_usd: 0.25,
        judge_calls: 1,
        recall: 1,
      });
      expect(report?.judge).toEqual({ calls: 1, unknown: 0, cost_usd: 0.25 });
    },
    RUN_TIMEOUT,
  );

  it(
    "sends the judge query to the model of --judge-model",
    async () => {
      const cases = casesDir([
        { name: "judged", golden: [{ ...PLANTED(), category: "security" }] },
      ]);
      const fake = evalFake();
      const { code } = await evalJson(fake, cases, "--repeat", "1", "--judge-model", "haiku");
      expect(code, stderr).toBe(0);
      expect(judgeCalls(fake).map((c) => c.overrides?.model)).toEqual(["claude-haiku-5-5"]);
    },
    RUN_TIMEOUT,
  );

  it("exits 2 with no query when --judge-model equals the reviewer model", async () => {
    const fake = evalFake();
    const { code, out } = await evalCli(fake, twoCases(), "--judge-model", "opus");
    expect(code).toBe(2);
    expect(stderr).toContain("claude-opus-5-5");
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(join(out, "report.json"))).toBe(false);
  });

  it(
    "runs when --judge-model equals the reviewer model and --allow-same-judge is given",
    async () => {
      const fake = evalFake();
      const { code } = await evalJson(
        fake,
        casesDir([{ name: "only", golden: [PLANTED()] }]),
        "--repeat",
        "1",
        "--judge-model",
        "opus",
        "--allow-same-judge",
      );
      expect(code, stderr).toBe(0);
      expect(fake.calls.length).toBeGreaterThan(0);
    },
    RUN_TIMEOUT,
  );

  it(
    "exits 2 after a run whose config gives a reviewer the judge model, with no judge query and no report",
    async () => {
      const cases = casesDir([
        { name: "same", from: sameJudgeTemplate, golden: [{ ...PLANTED(), category: "security" }] },
      ]);
      const fake = evalFake();
      const { code, out } = await evalCli(fake, cases, "--repeat", "2", "--format", "json");
      expect(code).toBe(2);
      expect(stderr).toContain("conventions");
      expect(judgeCalls(fake)).toHaveLength(0);
      expect(fake.calls.filter((c) => c.role === "triage")).toHaveLength(1);
      expect(existsSync(join(out, "report.json"))).toBe(false);
      expect(stdout).toBe("");
    },
    RUN_TIMEOUT,
  );
});

describe("pr-review eval: the report outputs (R5.5, R5.6, R5.7)", () => {
  it(
    "writes report.json equal to the JSON document on stdout",
    async () => {
      const { code, out } = await evalCli(
        evalFake(),
        twoCases(),
        "--repeat",
        "1",
        "--format",
        "json",
      );
      expect(code, stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8"))).toEqual(
        JSON.parse(stdout),
      );
    },
    RUN_TIMEOUT,
  );

  it(
    "prints a table per case and the summary by default, and writes report.json",
    async () => {
      const { code, out } = await evalCli(evalFake(), twoCases(), "--repeat", "1");
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("a-planted");
      expect(stdout).toContain("b-unmatched");
      expect(stdout).toMatch(/^recall\s+0\.500\s+0\.500\s+0\.500\s*$/m);
      expect(stdout).toMatch(/^findings per case\s+2\.000\s+2\.000\s+2\.000\s*$/m);
      const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Report;
      expect(report.aggregate.recall.mean).toBe(0.5);
    },
    RUN_TIMEOUT,
  );
});

function baselineFile(parts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recall: 0.5,
    precision: 0.25,
    margin: { recall: 0.05, precision: 0.05 },
    cases_ref: null,
    repeat: 1,
    written_at: "2026-10-16T12:00:00.000Z",
    tool_version: "0.1.0",
    ...parts,
  };
}

describe("pr-review eval: the gate and the baseline (R6)", () => {
  // The eval of twoCases() gives mean recall 0.5 and mean precision 0.25.
  function writeBaselineFile(parts: Record<string, unknown> = {}): string {
    const file = join(newDir("baseline"), "baseline.json");
    writeFileSync(file, JSON.stringify(baselineFile(parts)));
    return file;
  }

  it(
    "passes the gate for a recall drop within the margin",
    async () => {
      const file = writeBaselineFile({ recall: 0.75, margin: { recall: 0.25, precision: 0.25 } });
      const { code, report } = await evalJson(
        evalFake(),
        twoCases(),
        "--repeat",
        "1",
        "--baseline",
        file,
      );
      expect(code, stderr).toBe(0);
      expect(report?.gate).toEqual({
        passed: true,
        recall_drop: 0.25,
        precision_drop: 0,
        margin: { recall: 0.25, precision: 0.25 },
      });
    },
    RUN_TIMEOUT,
  );

  it.each<[string, Record<string, unknown>, number, number]>([
    ["recall", { recall: 1, margin: { recall: 0.25, precision: 0.25 } }, 0.5, 0],
    ["precision", { precision: 1, margin: { recall: 0.25, precision: 0.25 } }, 0, 0.75],
  ])(
    "fails the gate for a %s drop above the margin, exits 3 and prints the drops and the margin",
    async (_label, parts, recallDrop, precisionDrop) => {
      const file = writeBaselineFile(parts);
      const { code, report } = await evalJson(
        evalFake(),
        twoCases(),
        "--repeat",
        "1",
        "--baseline",
        file,
      );
      expect(code).toBe(3);
      expect(report?.gate).toEqual({
        passed: false,
        recall_drop: recallDrop,
        precision_drop: precisionDrop,
        margin: { recall: 0.25, precision: 0.25 },
      });
      expect(stderr).toContain(`recall drop ${recallDrop}`);
      expect(stderr).toContain(`precision drop ${precisionDrop}`);
      expect(stderr).toContain("margin 0.25");
    },
    RUN_TIMEOUT,
  );

  it(
    "passes the gate for a precision drop within the margin",
    async () => {
      const file = writeBaselineFile({ precision: 0.5, margin: { recall: 0.25, precision: 0.25 } });
      const { code, report } = await evalJson(
        evalFake(),
        twoCases(),
        "--repeat",
        "1",
        "--baseline",
        file,
      );
      expect(code, stderr).toBe(0);
      expect(report?.gate?.passed).toBe(true);
    },
    RUN_TIMEOUT,
  );

  it("exits 2 with no query for a baseline path that does not exist", async () => {
    const fake = evalFake();
    const missing = join(work, "no-such-baseline.json");
    const { code } = await evalCli(fake, twoCases(), "--baseline", missing);
    expect(code).toBe(2);
    expect(stderr).toContain(missing);
    expect(fake.calls).toHaveLength(0);
  });

  it("exits 2 with no query for a baseline file that is not valid", async () => {
    const fake = evalFake();
    const file = writeBaselineFile({ recall: "high" });
    const { code } = await evalCli(fake, twoCases(), "--baseline", file);
    expect(code).toBe(2);
    expect(stderr).toContain(file);
    expect(fake.calls).toHaveLength(0);
  });

  it(
    "warns and exits 0 when the baseline cases_ref differs from the cases ref and the gate passes",
    async () => {
      const cases = twoCases();
      await git(cases, ["init", "--quiet", "--initial-branch=main"]);
      await git(cases, ["add", "-A"]);
      await git(cases, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Cases"]);
      const head = await git(cases, ["rev-parse", "HEAD"]);
      const file = writeBaselineFile({ cases_ref: "d".repeat(40) });
      const { code, report } = await evalJson(
        evalFake(),
        cases,
        "--repeat",
        "1",
        "--baseline",
        file,
      );
      expect(code, stderr).toBe(0);
      expect(report?.cases_ref).toBe(head);
      expect(stderr).toContain("d".repeat(40));
      expect(stderr).toContain(head);
      expect(stderr).toMatch(/new baseline/);
    },
    RUN_TIMEOUT,
  );

  it(
    "reports a null cases ref for a plain directory inside a git work tree, with no warning",
    async () => {
      const inner = join(fx.repo, "eval-cases-plain");
      twoCasesInto(inner);
      const file = writeBaselineFile({ cases_ref: "d".repeat(40) });
      const { code, report } = await evalJson(
        evalFake(),
        inner,
        "--repeat",
        "1",
        "--baseline",
        file,
      );
      expect(code, stderr).toBe(0);
      expect(report?.cases_ref).toBeNull();
      expect(stderr).not.toMatch(/new baseline/);
    },
    RUN_TIMEOUT,
  );

  it(
    "writes a new baseline with the values of the report when no file exists",
    async () => {
      const file = join(newDir("baseline"), "baseline.json");
      const { code, report } = await evalJson(
        evalFake(),
        twoCases(),
        "--repeat",
        "1",
        "--baseline",
        file,
        "--write-baseline",
      );
      expect(code, stderr).toBe(0);
      expect(report?.gate).toBeNull();
      const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        recall: 0.5,
        precision: 0.25,
        margin: { recall: 0.05, precision: 0.05 },
        cases_ref: null,
        repeat: 1,
        tool_version: (
          JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
            version: string;
          }
        ).version,
      });
      expect(typeof written.written_at).toBe("string");
    },
    RUN_TIMEOUT,
  );

  it(
    "replaces a baseline far above the eval, keeps its margin, and reports no gate",
    async () => {
      const file = writeBaselineFile({
        recall: 1,
        precision: 1,
        margin: { recall: 0.1, precision: 0.1 },
      });
      const { code, report } = await evalJson(
        evalFake(),
        twoCases(),
        "--repeat",
        "1",
        "--baseline",
        file,
        "--write-baseline",
      );
      expect(code, stderr).toBe(0);
      expect(report?.gate).toBeNull();
      const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({
        recall: 0.5,
        precision: 0.25,
        margin: { recall: 0.1, precision: 0.1 },
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "leaves the baseline unchanged when a repeat failed",
    async () => {
      const file = writeBaselineFile({ recall: 1, precision: 1 });
      const before = readFileSync(file, "utf8");
      const { code, report } = await evalJson(
        evalFake(),
        brokenCases(),
        "--repeat",
        "1",
        "--baseline",
        file,
        "--write-baseline",
      );
      expect(code).toBe(1);
      expect(report?.gate).toBeNull();
      expect(readFileSync(file, "utf8")).toBe(before);
    },
    RUN_TIMEOUT,
  );
});

function twoCasesInto(root: string): void {
  mkdirSync(root, { recursive: true });
  casesDir(
    [
      { name: "a-planted", golden: [PLANTED()] },
      { name: "b-unmatched", golden: [UNMATCHED] },
    ],
    root,
  );
}
