// R6: "pr-review label --resume" through the command, with a fake SDK
// client and a fake codex on PATH.
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
import { Command, CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GoldenFinding } from "../src/eval/case.js";
import { registerLabelCommand } from "../src/eval/label/index.js";
import type { QueryMeta, QueryOutcome } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

// The fake codex: logs its argv, fails when the prompt holds a marker that
// the plan lists as failing, and accepts every other label.
const SHIM_SCRIPT = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("-o") + 1];
appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ argv }) + "\\n");
const prompt = argv.at(-1) ?? "";
const marker = (prompt.match(/MARK-[A-Za-z0-9]+/) ?? ["default"])[0];
try {
  writeFileSync(join(dir, "labels-at-" + marker + ".json"), readFileSync(process.env.FAKE_LABELS, "utf8"), { flag: "wx" });
} catch {}
const failing = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).failing;
if (failing.includes(marker)) {
  process.stderr.write("ERROR: You have hit your usage limit.");
  process.exit(1);
}
writeFileSync(out, JSON.stringify({ accept: true, policy_section: "Labels", reason: "ok" }));
`;

const META: QueryMeta = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

let work = "";
let template = "";
let fixtureRepo = "";
let plantedFile = "";
let plantedLine = 0;
let count = 0;

beforeAll(async () => {
  const { stdout } = await run("bash", [join(ROOT, "scripts/make-fixture.sh")]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  fixtureRepo = value("FIXTURE");
  const [file, line] = value("PLANTED").split(":");
  plantedFile = file ?? "";
  plantedLine = Number(line);
  work = mkdtempSync(join(tmpdir(), "pr-review-label-resume-"));
  const templates = join(work, "templates");
  mkdirSync(templates);
  await run(
    "bash",
    [join(ROOT, "scripts/make-case.sh"), fixtureRepo, value("BASE"), value("HEAD"), "plain"],
    { cwd: templates },
  );
  template = join(templates, "plain");
}, 60_000);

afterAll(() => {
  for (const dir of [fixtureRepo, work]) if (dir) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

function finding(marker: string): GoldenFinding {
  return {
    file: plantedFile,
    start_line: plantedLine,
    end_line: plantedLine,
    category: "test",
    severity: "nit",
    claim: `The claim ${marker}.`,
  };
}

const goldenSet = (): GoldenFinding[] => ["MARK-R1", "MARK-R2", "MARK-R3"].map(finding);

// A cases directory with one case "r-three".
function casesDir(): string {
  count += 1;
  const root = join(work, `cases-${count}`);
  const dir = join(root, "r-three");
  mkdirSync(root);
  cpSync(template, dir, { recursive: true });
  const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as Record<string, unknown>;
  meta.name = "r-three";
  writeFileSync(join(dir, "case.json"), JSON.stringify(meta));
  writeGolden(root, goldenSet());
  return root;
}

function writeGolden(cases: string, findings: GoldenFinding[]): void {
  writeFileSync(join(cases, "r-three", "golden.json"), JSON.stringify({ findings }));
}

type Result = {
  code: number;
  stdout: string;
  stderr: string;
  scorerCalls: string[];
  judgeCalls: string[];
  /** The labels.json on disk when the judge first saw the finding with this marker. */
  labelsAt: (marker: string) => { findings: { claim: string }[] } | null;
};

// One label run. "failing" lists the markers for which the fake codex fails.
async function labelRun(cases: string, failing: string[], flags: string[] = []): Promise<Result> {
  count += 1;
  const codexDir = join(work, `codex-${count}`);
  mkdirSync(codexDir);
  writeFileSync(join(codexDir, "shim.mjs"), SHIM_SCRIPT);
  writeFileSync(
    join(codexDir, "codex"),
    `#!/bin/sh\nexec node '${join(codexDir, "shim.mjs")}' "$@"\n`,
    {
      mode: 0o755,
    },
  );
  writeFileSync(join(codexDir, "plan.json"), JSON.stringify({ failing }));
  vi.stubEnv("PATH", `${codexDir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_CODEX_DIR", codexDir);
  vi.stubEnv("FAKE_LABELS", join(cases, "r-three", "labels.json"));
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  const client = createFakeSdkClient((): QueryOutcome<unknown> => ({
    ok: true,
    output: { severity: "blocking", category: "bug", policy_section: "Labels", rationale: "r" },
    raw: META,
  }));
  const program = new Command();
  program.name("pr-review").exitOverride((err) => {
    if (err.exitCode === 0) throw err;
    throw new CommanderError(2, err.code, err.message);
  });
  registerLabelCommand(program, { client });
  process.exitCode = undefined;
  let code: number;
  try {
    await program.parseAsync([
      "node",
      "pr-review",
      "label",
      "--cases",
      cases,
      "--runs",
      "2",
      "--concurrency",
      "1",
      "--write-golden",
      ...flags,
    ]);
    code = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    code = err.exitCode;
  }
  const logPath = join(codexDir, "log.jsonl");
  const judge = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { argv: string[] }).argv.at(-1) ?? "")
    : [];
  const result = {
    code,
    stdout,
    stderr,
    scorerCalls: client.calls.map((c) => c.userMessage),
    judgeCalls: judge,
    labelsAt: (marker: string) => {
      const path = join(codexDir, `labels-at-${marker}.json`);
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    },
  };
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  return result;
}

const markers = (texts: string[]) => texts.map((t) => /MARK-R\d/.exec(t)?.[0]);
const read = (cases: string, name: string) => readFileSync(join(cases, "r-three", name), "utf8");

describe("pr-review label --resume", () => {
  it("makes no call for a finding whose runs all completed, labels the others, and writes the full golden", async () => {
    const cases = casesDir();
    const first = await labelRun(cases, ["MARK-R2"]);
    expect(first.code).toBe(1);
    const afterFirst = JSON.parse(read(cases, "golden.json")) as {
      findings: { severity: string }[];
    };
    expect(afterFirst.findings.map((f) => f.severity)).toEqual(["blocking", "nit", "blocking"]);

    const second = await labelRun(cases, [], ["--resume"]);
    expect(second.code).toBe(0);
    expect(markers(second.scorerCalls)).toEqual(["MARK-R2", "MARK-R2"]);
    expect(markers(second.judgeCalls)).toEqual(["MARK-R2", "MARK-R2"]);
    const golden = JSON.parse(read(cases, "golden.json")) as { findings: { severity: string }[] };
    expect(golden.findings.map((f) => f.severity)).toEqual(["blocking", "blocking", "blocking"]);
    const summary = JSON.parse(read(cases, "../label-summary.json").toString()) as {
      cases: { reused?: number[]; scorer_cost_usd: number }[];
    };
    expect(summary.cases[0]?.reused).toEqual([0, 2]);
    expect(summary.cases[0]?.scorer_cost_usd).toBeCloseTo(0.02);
    expect(second.stdout).toMatch(/resume r-three: reused findings 0, 2/);
  }, 120_000);

  it("writes the files that one run with no failure writes", async () => {
    const resumed = casesDir();
    await labelRun(resumed, ["MARK-R2"]);
    await labelRun(resumed, [], ["--resume"]);
    const clean = casesDir();
    expect((await labelRun(clean, [])).code).toBe(0);
    // current_severity is the severity in golden.json when the run starts. The first run
    // of the resumed case already wrote its labels there, so the field is left out.
    const plain = (cases: string, name: string) =>
      read(cases, name).replace(/\s*"current_severity": "[a-z_]+",?/g, "");
    for (const name of ["labels.json", "human-queue.json", "disagreements.json"]) {
      expect(plain(resumed, name)).toBe(plain(clean, name));
    }
    expect(read(resumed, "golden.json")).toBe(read(clean, "golden.json"));
  }, 120_000);

  it("makes every call without --resume", async () => {
    const cases = casesDir();
    await labelRun(cases, ["MARK-R2"]);
    const second = await labelRun(cases, []);
    expect(second.stderr).toBe("");
    expect(second.scorerCalls).toHaveLength(6);
    expect(second.judgeCalls).toHaveLength(6);
  }, 120_000);

  it("labels again a finding whose text changed", async () => {
    const cases = casesDir();
    await labelRun(cases, ["MARK-R2"]);
    writeGolden(cases, [
      { ...finding("MARK-R1"), claim: "The claim MARK-R1 changed." },
      ...goldenSet().slice(1),
    ]);
    const second = await labelRun(cases, [], ["--resume"]);
    expect(markers(second.scorerCalls).sort()).toEqual([
      "MARK-R1",
      "MARK-R1",
      "MARK-R2",
      "MARK-R2",
    ]);
  }, 120_000);

  it("reuses nothing, and says so, after a change of the run count", async () => {
    const cases = casesDir();
    await labelRun(cases, ["MARK-R2"]);
    const second = await labelRun(cases, [], ["--resume", "--runs", "3"]);
    expect(second.scorerCalls).toHaveLength(9);
    expect(second.stderr).toMatch(/another digest/);
  }, 120_000);

  it("reuses nothing, and says so, for a labels.json with no digest", async () => {
    const cases = casesDir();
    await labelRun(cases, ["MARK-R2"]);
    const path = join(cases, "r-three", "labels.json");
    const labels = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete labels.digest;
    writeFileSync(path, JSON.stringify(labels));
    const second = await labelRun(cases, [], ["--resume"]);
    expect(second.scorerCalls).toHaveLength(6);
    expect(second.stderr).toMatch(/r-three[^\n]*no digest/);
  }, 120_000);

  it("labels every finding when there is no labels.json", async () => {
    const cases = casesDir();
    const first = await labelRun(cases, [], ["--resume"]);
    expect(first.code).toBe(0);
    expect(first.scorerCalls).toHaveLength(6);
  }, 120_000);

  it("labels again a finding whose category changed", async () => {
    const cases = casesDir();
    await labelRun(cases, ["MARK-R2"]);
    writeGolden(cases, [{ ...goldenSet()[0]!, category: "bug" }, ...goldenSet().slice(1)]);
    const second = await labelRun(cases, [], ["--resume"]);
    expect(markers(second.scorerCalls).sort()).toEqual([
      "MARK-R1",
      "MARK-R1",
      "MARK-R2",
      "MARK-R2",
    ]);
  }, 120_000);

  it("reuses nothing, and says so, after a change of the diff of the case", async () => {
    const cases = casesDir();
    await labelRun(cases, ["MARK-R2"]);
    const diff = join(cases, "r-three", "diff.patch");
    writeFileSync(diff, `${readFileSync(diff, "utf8")}\n`);
    const second = await labelRun(cases, [], ["--resume"]);
    expect(second.scorerCalls).toHaveLength(6);
    expect(second.stderr).toMatch(/r-three[^\n]*another digest/);
  }, 120_000);

  it("keeps the finished findings in labels.json while the case is still running", async () => {
    const cases = casesDir();
    const first = await labelRun(cases, []);
    const seen = first.labelsAt("MARK-R3");
    expect(seen?.findings.map((f) => /MARK-R\d/.exec(f.claim)?.[0])).toEqual([
      "MARK-R1",
      "MARK-R2",
    ]);
    expect(first.labelsAt("MARK-R1")).toBeNull();
  }, 120_000);

  it("labels again a finding whose kept entry is damaged, with no crash", async () => {
    const cases = casesDir();
    await labelRun(cases, []);
    const path = join(cases, "r-three", "labels.json");
    const labels = JSON.parse(readFileSync(path, "utf8")) as {
      findings: { runs: { calls: unknown[] }[] }[];
    };
    const damaged = labels.findings[0]?.runs[0];
    if (damaged) damaged.calls = [null];
    writeFileSync(path, JSON.stringify(labels));
    const second = await labelRun(cases, [], ["--resume"]);
    expect(second.code).toBe(0);
    expect(markers(second.scorerCalls)).toEqual(["MARK-R1", "MARK-R1"]);
  }, 120_000);

  it.each([
    ["is not JSON", "{not json", /not JSON/],
    ["is not a labels file", '{"digest":"x"}', /not a labels file/],
  ])(
    "reuses nothing, with no crash, for a labels.json that %s",
    async (_name, text, message) => {
      const cases = casesDir();
      writeFileSync(join(cases, "r-three", "labels.json"), text);
      const result = await labelRun(cases, [], ["--resume"]);
      expect(result.code).toBe(0);
      expect(result.scorerCalls).toHaveLength(6);
      expect(result.stderr).toMatch(message);
    },
    120_000,
  );

  it("prints only JSON on stdout with --format json and --resume", async () => {
    const cases = casesDir();
    await labelRun(cases, ["MARK-R2"]);
    const second = await labelRun(cases, [], ["--resume", "--format", "json"]);
    const summary = JSON.parse(second.stdout) as { cases: { reused?: number[] }[] };
    expect(summary.cases[0]?.reused).toEqual([0, 2]);
  }, 120_000);
});
