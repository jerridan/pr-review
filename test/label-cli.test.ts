import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Command, CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramDeps } from "../src/cli.js";
import { loadCases, type GoldenFinding } from "../src/eval/case.js";
import { registerLabelCommand } from "../src/eval/label/index.js";
import type { QueryMeta, QueryOutcome } from "../src/sdk/client.js";
import { createSdkClient, type QueryFn } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_SCRIPT = join(ROOT, "scripts/make-fixture.sh");
const MAKE_CASE = join(ROOT, "scripts/make-case.sh");
const TIMEOUT = 60_000;

// The fake codex: a shell shim first on PATH that runs a node script. The
// script logs its argv, takes the next step of the plan for the marker in
// the prompt, and writes the out file of that step.
const SHIM_SCRIPT = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("-o") + 1];
appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ argv }) + "\\n");
const prompt = argv.at(-1) ?? "";
const marker = (prompt.match(/MARK-[A-Za-z0-9]+/) ?? ["default"])[0];
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const statePath = join(dir, "state-" + marker);
const n = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
writeFileSync(statePath, String(n + 1));
const list = plan[marker] ?? plan.default ?? [{ accept: true }];
const step = list[Math.min(n, list.length - 1)];
if (step.stderr) process.stderr.write(step.stderr);
if (step.exit) process.exit(step.exit);
if (step.missing) process.exit(0);
if (step.raw !== undefined) writeFileSync(out, step.raw);
else writeFileSync(out, JSON.stringify({ accept: step.accept ?? true, policy_section: step.section ?? "Labels", reason: step.reason ?? "ok" }));
`;

type JudgeStep = { accept?: boolean; section?: string; reason?: string; exit?: number };
type ScorerStep = { severity?: string; category?: string; section?: string };

let work = "";
let template = "";
let fixtureRepo = "";
let plantedFile = "";
let plantedLine = 0;

beforeAll(async () => {
  const { stdout } = await run("bash", [FIXTURE_SCRIPT]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  fixtureRepo = value("FIXTURE");
  const [file, line] = value("PLANTED").split(":");
  plantedFile = file ?? "";
  plantedLine = Number(line);
  work = mkdtempSync(join(tmpdir(), "pr-review-label-cli-"));
  const templates = join(work, "templates");
  mkdirSync(templates);
  await run("bash", [MAKE_CASE, fixtureRepo, value("BASE"), value("HEAD"), "plain"], {
    cwd: templates,
  });
  template = join(templates, "plain");
}, TIMEOUT);

afterAll(() => {
  for (const dir of [fixtureRepo, work]) if (dir) rmSync(dir, { recursive: true, force: true });
});

let stdout = "";
let stderr = "";
let codexDir = "";
let dirCount = 0;

function newDir(label: string): string {
  dirCount += 1;
  const dir = join(work, `${label}-${dirCount}`);
  mkdirSync(dir);
  return dir;
}

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
  codexDir = newDir("codex");
  writeFileSync(join(codexDir, "shim.mjs"), SHIM_SCRIPT);
  writeFileSync(
    join(codexDir, "codex"),
    `#!/bin/sh\nexec node '${join(codexDir, "shim.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${codexDir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_CODEX_DIR", codexDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

function judgePlan(steps: Record<string, JudgeStep[]>): void {
  writeFileSync(join(codexDir, "plan.json"), JSON.stringify(steps));
}

function codexArgvs(): string[][] {
  const path = join(codexDir, "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

const META: QueryMeta = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

function markerOf(text: string): string {
  return /MARK-[A-Za-z0-9]+/.exec(text)?.[0] ?? "default";
}

function scorerOutput(step: ScorerStep): Record<string, string> {
  return {
    severity: step.severity ?? "blocking",
    category: step.category ?? "bug",
    policy_section: step.section ?? "Labels",
    rationale: "r",
  };
}

/** Give the next step of the plan for the marker in "text". */
function stepper<T>(plan: Record<string, T[]>, fallback: T): (text: string) => T {
  const counts = new Map<string, number>();
  return (text) => {
    const marker = markerOf(text);
    const n = counts.get(marker) ?? 0;
    counts.set(marker, n + 1);
    const list = plan[marker] ?? plan.default ?? [fallback];
    return list[Math.min(n, list.length - 1)] ?? fallback;
  };
}

function scorerFake(plan: Record<string, ScorerStep[]>) {
  const next = stepper(plan, {});
  return createFakeSdkClient((req): QueryOutcome<unknown> => ({
    ok: true,
    output: scorerOutput(next(req.userMessage)),
    raw: META,
  }));
}

// Commander exits with 1 on a usage error. This makes it 2, as the CLI does.
function program(deps: ProgramDeps): Command {
  const p = new Command();
  p.name("pr-review").exitOverride((err) => {
    if (err.exitCode === 0) throw err;
    throw new CommanderError(2, err.code, err.message);
  });
  registerLabelCommand(p, deps);
  return p;
}

async function labelCli(deps: ProgramDeps, ...args: string[]): Promise<number> {
  try {
    await program(deps).parseAsync(["node", "pr-review", "label", ...args]);
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

function finding(marker: string, over: Partial<GoldenFinding> = {}): GoldenFinding {
  return {
    file: plantedFile,
    start_line: plantedLine,
    end_line: plantedLine,
    category: "test",
    severity: "nit",
    claim: `The claim ${marker}.`,
    ...over,
  };
}

/** Write a cases directory with one case per entry. */
function casesDir(specs: { name: string; golden: unknown[] }[]): string {
  const root = newDir("cases");
  for (const spec of specs) {
    const dir = join(root, spec.name);
    cpSync(template, dir, { recursive: true });
    const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as Record<
      string,
      unknown
    >;
    meta.name = spec.name;
    writeFileSync(join(dir, "case.json"), JSON.stringify(meta));
    writeFileSync(join(dir, "golden.json"), JSON.stringify({ findings: spec.golden }));
  }
  return root;
}

// Case a-three has three findings, and case b-one has one.
//   A1: every run converges to blocking on the first pass.
//   A2: the judge rejects every label of run 2; runs 1 and 3 converge to suggestion.
//   A3: the three runs converge to three different labels.
//   B1: the runs converge to not_real; run 1 needs one re-score.
function twoCases(): string {
  return casesDir([
    {
      name: "a-three",
      golden: [
        finding("MARK-A1", { note: "a note" }),
        finding("MARK-A2", { severity: "blocking", category: "bug" }),
        finding("MARK-A3"),
      ],
    },
    { name: "b-one", golden: [finding("MARK-B1")] },
  ]);
}

const SCORER_PLAN: Record<string, ScorerStep[]> = {
  "MARK-A1": [{ severity: "blocking", category: "bug", section: "Labels" }],
  "MARK-A2": [
    { severity: "suggestion", section: "Tests" },
    { severity: "blocking", section: "Normal path" },
    { severity: "blocking", section: "Normal path" },
    { severity: "blocking", section: "Normal path" },
    { severity: "suggestion", section: "Tests" },
  ],
  "MARK-A3": [{ severity: "blocking" }, { severity: "suggestion" }, { severity: "nit" }],
  "MARK-B1": [{ severity: "not_real", section: "Claims that are partly true" }],
};

const JUDGE_PLAN: Record<string, JudgeStep[]> = {
  "MARK-A1": [{ accept: true }],
  "MARK-A2": [
    { accept: true },
    { accept: false, reason: "R1" },
    { accept: false, reason: "R2" },
    { accept: false, reason: "R3" },
    { accept: true },
  ],
  "MARK-A3": [{ accept: true }],
  "MARK-B1": [{ accept: false, reason: "again" }, { accept: true }],
};

type RunJson = {
  converged: boolean;
  failed: boolean;
  severity: string | null;
  first_pass_accepted: boolean;
  calls: { kind: string; policy_section: string | null; severity?: string; accept?: boolean }[];
};
type EntryJson = {
  index: number;
  claim: string;
  current_severity: string;
  chosen: { severity: string; category: string } | null;
  runs: RunJson[];
};
type LabelsJson = {
  case: string;
  runs_per_finding: number;
  findings: EntryJson[];
  first_pass_acceptance_rate: number | null;
  run_agreement_rate: number | null;
  run_agreement_excluded: number;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("label over two cases", () => {
  let cases = "";
  let goldenBefore: Record<string, Buffer> = {};
  let code = -1;
  let tableOut = "";

  beforeAll(async () => {
    cases = twoCases();
    goldenBefore = {
      a: readFileSync(join(cases, "a-three", "golden.json")),
      b: readFileSync(join(cases, "b-one", "golden.json")),
    };
  });

  it(
    "exits 0 on a clean run",
    async () => {
      judgePlan(JUDGE_PLAN);
      code = await labelCli({ client: scorerFake(SCORER_PLAN) }, "--cases", cases);
      tableOut = stdout;
      expect(code, stderr).toBe(0);
    },
    TIMEOUT,
  );

  const labels = (name: string) => readJson<LabelsJson>(join(cases, name, "labels.json"));
  const byMarker = (name: string, marker: string): EntryJson | undefined =>
    labels(name).findings.find((f) => f.claim.includes(marker));

  it("gives blocking to the finding whose three runs converge to blocking, and counts the first pass", () => {
    const a1 = byMarker("a-three", "MARK-A1");
    expect(a1?.chosen).toEqual({ severity: "blocking", category: "bug" });
    expect(a1?.runs.map((r) => r.first_pass_accepted)).toEqual([true, true, true]);
  });

  it("runs each finding 3 times when --runs is absent", () => {
    for (const name of ["a-three", "b-one"]) {
      const l = labels(name);
      expect(l.runs_per_finding).toBe(3);
      for (const f of l.findings) expect(f.runs).toHaveLength(3);
    }
  });

  it("gives the finding with one unresolved run the label of the other two runs", () => {
    const a2 = byMarker("a-three", "MARK-A2");
    expect(a2?.runs.map((r) => r.converged)).toEqual([true, false, true]);
    expect(a2?.chosen?.severity).toBe("suggestion");
  });

  it("queues the finding with three different labels, with no label and the reason no_majority", () => {
    const queue = readJson<{ findings: (EntryJson & { reason: string })[] }>(
      join(cases, "a-three", "human-queue.json"),
    );
    expect(queue.findings.map((f) => [markerOf(f.claim), f.chosen, f.reason])).toEqual([
      ["MARK-A3", null, "no_majority"],
    ]);
  });

  it("queues the not_real finding with the reason not_posted_label", () => {
    const queue = readJson<{ findings: (EntryJson & { reason: string })[] }>(
      join(cases, "b-one", "human-queue.json"),
    );
    expect(queue.findings.map((f) => [markerOf(f.claim), f.chosen, f.reason])).toEqual([
      ["MARK-B1", { severity: "not_real", category: "bug" }, "not_posted_label"],
    ]);
  });

  it("logs only the findings whose runs did not all agree or did not all converge", () => {
    const a = readJson<{ findings: EntryJson[] }>(join(cases, "a-three", "disagreements.json"));
    const b = readJson<{ findings: EntryJson[] }>(join(cases, "b-one", "disagreements.json"));
    expect(a.findings.map((f) => markerOf(f.claim))).toEqual(["MARK-A2", "MARK-A3"]);
    expect(b.findings).toEqual([]);
    const a2 = a.findings[0];
    expect(a2?.runs.map((r) => [r.converged, r.severity])).toEqual([
      [true, "suggestion"],
      [false, null],
      [true, "suggestion"],
    ]);
    expect(a2?.runs[1]?.calls.map((c) => [c.kind, c.policy_section])).toEqual([
      ["scorer", "Normal path"],
      ["judge", "Labels"],
      ["scorer", "Normal path"],
      ["judge", "Labels"],
      ["scorer", "Normal path"],
      ["judge", "Labels"],
    ]);
    expect(a.findings[1]?.runs.map((r) => r.severity)).toEqual(["blocking", "suggestion", "nit"]);
  });

  it("writes the two rates per case and pooled over the cases", () => {
    // a-three: first pass 8 of 9 runs; agreement 1 of the 2 all-converged findings.
    // b-one: first pass 2 of 3 runs; agreement 1 of 1.
    expect(labels("a-three").first_pass_acceptance_rate).toBeCloseTo(8 / 9);
    expect(labels("a-three").run_agreement_rate).toBeCloseTo(1 / 2);
    expect(labels("b-one").first_pass_acceptance_rate).toBeCloseTo(2 / 3);
    expect(labels("b-one").run_agreement_rate).toBe(1);
    const summary = readJson<Record<string, unknown>>(join(cases, "label-summary.json"));
    expect(summary.first_pass_acceptance_rate).toBeCloseTo(10 / 12);
    expect(summary.run_agreement_rate).toBeCloseTo(2 / 3);
    expect(summary.cases).toEqual([
      {
        case: "a-three",
        findings: 3,
        labeled: 2,
        queued: 1,
        failed_runs: 0,
        scorer_cost_usd: expect.closeTo(0.11, 6),
      },
      {
        case: "b-one",
        findings: 1,
        labeled: 0,
        queued: 1,
        failed_runs: 0,
        scorer_cost_usd: expect.closeTo(0.04, 6),
      },
    ]);
    expect(summary.scorer_cost_usd).toBeCloseTo(0.15);
  });

  it("counts the findings that the agreement rate leaves out, per case and over the cases", () => {
    // A2 has one run that did not converge, so the rate leaves it out.
    expect(labels("a-three").run_agreement_excluded).toBe(1);
    expect(labels("b-one").run_agreement_excluded).toBe(0);
    const summary = readJson<Record<string, unknown>>(join(cases, "label-summary.json"));
    expect(summary.run_agreement_excluded).toBe(1);
  });

  it("keeps the source severity of each finding in labels.json", () => {
    expect(labels("a-three").findings.map((f) => f.current_severity)).toEqual([
      "nit",
      "blocking",
      "nit",
    ]);
  });

  it("leaves golden.json byte-identical without --write-golden", () => {
    expect(readFileSync(join(cases, "a-three", "golden.json")).equals(goldenBefore.a!)).toBe(true);
    expect(readFileSync(join(cases, "b-one", "golden.json")).equals(goldenBefore.b!)).toBe(true);
  });

  it("prints a table with the columns, one row per case and a totals row", () => {
    const lines = tableOut.trimEnd().split("\n");
    const header = lines[0] ?? "";
    for (const column of [
      "case",
      "findings",
      "labeled",
      "queued",
      "failed runs",
      "first-pass acceptance",
      "run agreement",
      "scorer cost",
    ]) {
      expect(header).toContain(column);
    }
    expect(lines.slice(1).map((l) => l.split(/\s+/)[0])).toEqual(["a-three", "b-one", "total"]);
    expect(lines[3]).toMatch(/^total\s+4\s+2\s+2\s+0\s+0\.833\s+0\.667\s+\$0\.1500$/);
  });
});

describe("label --write-golden", () => {
  it(
    "writes every chosen label, keeps the other entries, fields and key order, and loads",
    async () => {
      const cases = twoCases();
      const before = readJson<{ findings: Record<string, unknown>[] }>(
        join(cases, "a-three", "golden.json"),
      );
      const beforeB = readJson<{ findings: Record<string, unknown>[] }>(
        join(cases, "b-one", "golden.json"),
      );
      judgePlan(JUDGE_PLAN);
      const code = await labelCli(
        { client: scorerFake(SCORER_PLAN) },
        "--cases",
        cases,
        "--write-golden",
      );
      expect(code, stderr).toBe(0);
      const after = readJson<{ findings: Record<string, unknown>[] }>(
        join(cases, "a-three", "golden.json"),
      );
      const [a1, a2, a3] = after.findings;
      // Only the severity changes. The category stays.
      expect(a1).toEqual({ ...before.findings[0], severity: "blocking" });
      expect(a1?.category).toBe("test");
      expect(a2).toEqual({ ...before.findings[1], severity: "suggestion" });
      expect(
        readJson<LabelsJson>(join(cases, "a-three", "labels.json")).findings[0]?.chosen?.category,
      ).toBe("bug");
      expect(a3).toEqual(before.findings[2]);
      after.findings.forEach((f, i) =>
        expect(Object.keys(f)).toEqual(Object.keys(before.findings[i] ?? {})),
      );
      // B1 converges to not_real, which does not post. Its golden still
      // gets the label.
      const afterB = readJson<{ findings: Record<string, unknown>[] }>(
        join(cases, "b-one", "golden.json"),
      );
      expect(afterB.findings).toEqual([{ ...beforeB.findings[0], severity: "not_real" }]);
      const queue = readJson<{ findings: { reason: string }[] }>(
        join(cases, "b-one", "human-queue.json"),
      );
      expect(queue.findings.map((f) => f.reason)).toEqual(["not_posted_label"]);
      const loaded = await loadCases(cases);
      expect(loaded.find((c) => c.name === "a-three")?.golden[0]?.severity).toBe("blocking");
      expect(loaded.find((c) => c.name === "b-one")?.golden[0]?.severity).toBe("not_real");
    },
    TIMEOUT,
  );

  it(
    "writes a dont_post label into golden.json, and keeps the category",
    async () => {
      const cases = casesDir([{ name: "c-one", golden: [finding("MARK-C1")] }]);
      judgePlan({ "MARK-C1": [{ accept: true }] });
      const code = await labelCli(
        { client: scorerFake({ "MARK-C1": [{ severity: "dont_post", category: "bug" }] }) },
        "--cases",
        cases,
        "--write-golden",
      );
      expect(code, stderr).toBe(0);
      const after = readJson<{ findings: Record<string, unknown>[] }>(
        join(cases, "c-one", "golden.json"),
      );
      expect(after.findings).toEqual([{ ...finding("MARK-C1"), severity: "dont_post" }]);
      const [loaded] = await loadCases(cases);
      expect(loaded?.golden[0]?.severity).toBe("dont_post");
    },
    TIMEOUT,
  );
});

describe("label options and exit codes", () => {
  it("says in --help that --write-golden writes every chosen label", async () => {
    const code = await labelCli({ client: scorerFake({}) }, "--help");
    expect(code).toBe(0);
    expect(stdout.replace(/\s+/g, " ")).toContain(
      "--write-golden write every chosen label to golden.json",
    );
  });

  it(
    "prints label-summary.json with --format json, and writes under --out",
    async () => {
      const cases = twoCases();
      const out = join(newDir("out"), "labels");
      judgePlan(JUDGE_PLAN);
      const code = await labelCli(
        { client: scorerFake(SCORER_PLAN) },
        "--cases",
        cases,
        "--format",
        "json",
        "--out",
        out,
      );
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual(readJson(join(out, "label-summary.json")));
      expect(existsSync(join(out, "a-three", "labels.json"))).toBe(true);
      expect(existsSync(join(out, "b-one", "human-queue.json"))).toBe(true);
      expect(existsSync(join(cases, "a-three", "labels.json"))).toBe(false);
      expect(existsSync(join(cases, "label-summary.json"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "labels no other case with --only",
    async () => {
      const cases = twoCases();
      judgePlan(JUDGE_PLAN);
      const code = await labelCli(
        { client: scorerFake(SCORER_PLAN) },
        "--cases",
        cases,
        "--only",
        "b-one",
      );
      expect(code, stderr).toBe(0);
      expect(existsSync(join(cases, "b-one", "labels.json"))).toBe(true);
      expect(existsSync(join(cases, "a-three", "labels.json"))).toBe(false);
      expect(codexArgvs().every((argv) => markerOf(argv.at(-1) ?? "") === "MARK-B1")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "exits 1 when a judge call fails after its retry, and still labels the cases",
    async () => {
      const cases = twoCases();
      judgePlan({ ...JUDGE_PLAN, "MARK-B1": [{ exit: 1 }, { exit: 2 }, { accept: true }] });
      const code = await labelCli({ client: scorerFake(SCORER_PLAN) }, "--cases", cases);
      expect(code).toBe(1);
      const b1 = readJson<LabelsJson>(join(cases, "b-one", "labels.json")).findings[0];
      expect(b1?.runs.map((r) => [r.converged, r.failed])).toEqual([
        [false, true],
        [true, false],
        [true, false],
      ]);
      expect(b1?.chosen?.severity).toBe("not_real");
      expect(existsSync(join(cases, "a-three", "labels.json"))).toBe(true);
      const summary = readJson<{ cases: { failed_runs: number }[] }>(
        join(cases, "label-summary.json"),
      );
      expect(summary.cases.map((c) => c.failed_runs)).toEqual([0, 1]);
    },
    TIMEOUT,
  );

  it(
    "exits 1 when a case checkout fails, and still labels the other case",
    async () => {
      const cases = twoCases();
      writeFileSync(join(cases, "a-three", "repo.bundle"), "not a bundle");
      judgePlan(JUDGE_PLAN);
      const code = await labelCli({ client: scorerFake(SCORER_PLAN) }, "--cases", cases);
      expect(code).toBe(1);
      expect(stderr).toContain("a-three");
      expect(existsSync(join(cases, "b-one", "labels.json"))).toBe(true);
      expect(existsSync(join(cases, "label-summary.json"))).toBe(true);
    },
    TIMEOUT,
  );

  it("exits 2 without --cases", async () => {
    expect(await labelCli({ client: scorerFake({}) })).toBe(2);
  });

  it("exits 2 for a cases directory with no case", async () => {
    expect(await labelCli({ client: scorerFake({}) }, "--cases", newDir("empty"))).toBe(2);
  });

  it("exits 2 for --runs below 1", async () => {
    expect(await labelCli({ client: scorerFake({}) }, "--cases", twoCases(), "--runs", "0")).toBe(
      2,
    );
  });

  it("exits 2 for --concurrency below 1", async () => {
    const code = await labelCli(
      { client: scorerFake({}) },
      "--cases",
      twoCases(),
      "--concurrency",
      "0",
    );
    expect(code).toBe(2);
  });

  it("exits 2 for an --only name that matches no case", async () => {
    const code = await labelCli(
      { client: scorerFake({}) },
      "--cases",
      twoCases(),
      "--only",
      "nosuch",
    );
    expect(code).toBe(2);
    expect(codexArgvs()).toEqual([]);
  });
});

describe("label calls at the process boundary", () => {
  it(
    "sends every scorer call the pinned model and the isolated options, and every judge call the exact argv",
    async () => {
      const cases = twoCases();
      judgePlan(JUDGE_PLAN);
      const recorded: Options[] = [];
      const policy = readFileSync(join(ROOT, "docs/design/severity-policy.md"), "utf8");
      const next = stepper(SCORER_PLAN, {});
      const prompts: string[] = [];
      const fakeQuery: QueryFn = async function* ({ prompt, options }) {
        recorded.push(options);
        prompts.push(prompt);
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0.01,
          structured_output: scorerOutput(next(prompt)),
        } as unknown as SDKMessage;
      };
      const code = await labelCli({ client: createSdkClient(fakeQuery) }, "--cases", cases);
      expect(code, stderr).toBe(0);
      expect(recorded.length).toBe(15);
      const cwds = new Set<string>();
      for (const options of recorded) {
        expect(options).toMatchObject({
          model: "claude-opus-5-5",
          effort: "high",
          settingSources: [],
          persistSession: false,
          permissionMode: "dontAsk",
        });
        expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
        expect(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
        expect(options.cwd).toMatch(/\/repo$/);
        cwds.add(options.cwd ?? "");
      }
      // One checkout per case.
      expect(cwds.size).toBe(2);
      for (const prompt of prompts) expect(prompt).toContain(policy.trim());

      const argvs = codexArgvs();
      expect(argvs).toHaveLength(15);
      for (const argv of argvs) {
        expect(argv).toEqual([
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "-C",
          argv[5],
          "-s",
          "read-only",
          "-m",
          "gpt-6.1-sol",
          "-c",
          "model_reasoning_effort=high",
          "--output-schema",
          argv[13],
          "-o",
          argv[15],
          argv[16],
        ]);
        expect(argv).toHaveLength(17);
        expect(cwds.has(argv[5] ?? "")).toBe(true);
        expect(argv[16]).toContain(policy.trim());
      }
    },
    TIMEOUT,
  );
});
