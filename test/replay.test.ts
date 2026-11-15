// D4c S2: pr-review replay verifies the stored candidates of an eval again
// with the first verifier only, and reports the figures of the arm.
import { execFile } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_STOPPED } from "../src/cli.js";
import type { Figures, ReplayReport, ResultsFile } from "../src/eval/replay/index.js";
import { loadPrompt } from "../src/prompts/load.js";
import { isRecordFileName } from "../src/record/write.js";
import { VerifierResultSchema } from "../src/schemas/verifier.js";
import type { RunRecord } from "../src/schemas/record.js";
import {
  captured,
  captureOutput,
  casesFrom,
  cleanup,
  makeFixture,
  makeTemplate,
  output,
  tempDir,
} from "./fixtures/eval-fixture.js";
import {
  ALPHA,
  ESCALATION_COST,
  EVAL_FIRST,
  finding,
  makeReplayInputs,
  replay,
  replayFake,
  type Made,
} from "./fixtures/replay-fixture.js";

const run = promisify(execFile);
const FIXTURE_SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

const made: string[] = [];
afterAll(() => cleanup(made));
captureOutput();

let inputs: Made;
beforeAll(async () => {
  const fx = await makeFixture();
  made.push(fx.repo);
  inputs = await makeReplayInputs(made, fx);
}, 240_000);

const ARM = ["--verifier", "claude:sonnet:high"];

// Run the replay of the full eval directory into a new --out directory.
async function replayFull(client: ReturnType<typeof replayFake>, ...extra: string[]) {
  const out = tempDir("replay-out", made);
  const code = await replay(client, [
    "--cases",
    inputs.cases,
    "--from",
    inputs.full,
    "--out",
    out,
    "--format",
    "json",
    "--concurrency",
    "1",
    ...extra,
  ]);
  return { code, out };
}

const reportOf = (): ReplayReport => JSON.parse(output.stdout) as ReplayReport;

const scopeOf = (report: ReplayReport, source: string | null) => {
  const scope = report.scopes.find((s) => s.source === source);
  if (!scope) throw new Error(`no scope ${String(source)}`);
  return scope;
};
const caseOf = (report: ReplayReport, name: string, source: string | null = null): Figures => {
  const row = scopeOf(report, source).cases.find((c) => c.case === name);
  if (!row) throw new Error(`no case ${name}`);
  return row;
};

const resultsOf = (out: string, name: string): ResultsFile =>
  JSON.parse(readFileSync(join(out, name, "results.json"), "utf8")) as ResultsFile;

const entryOf = (out: string, name: string, claim: string) => {
  const entry = resultsOf(out, name).entries.find((e) => e.finding.claim === claim);
  if (!entry) throw new Error(`no entry ${claim}`);
  return entry;
};

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

describe("pr-review replay: the claude arm with the score prompt", () => {
  let client: ReturnType<typeof replayFake>;
  let out = "";
  let report: ReplayReport;
  beforeAll(async () => {
    client = replayFake();
    // A beforeAll hook is outside of the capture of each test.
    await captured(async () => {
      const result = await replayFull(client, ...ARM);
      if (result.code !== 0) throw new Error(`the replay exited ${result.code}: ${output.stderr}`);
      out = result.out;
      report = reportOf();
    });
  }, 120_000);

  it("asks one first verifier query per candidate, and no escalation and no merge", () => {
    const roles = client.calls.map((c) => c.role);
    expect(roles.filter((r) => r === "verifier")).toHaveLength(6);
    expect(roles.filter((r) => r !== "verifier")).toEqual([]);
    const claims = client.calls.map((c) => /CLAIM-[A-Z0-9]+/.exec(c.userMessage)?.[0]).sort();
    expect(claims).toEqual([
      "CLAIM-ALPHA",
      "CLAIM-F",
      "CLAIM-NEAR",
      "CLAIM-P1",
      "CLAIM-P2",
      "CLAIM-U",
    ]);
  });

  it("sends each query with the model and the effort of the arm, and the verifier input", () => {
    const first = client.calls[0];
    expect(first?.systemPrompt).toBe(loadPrompt("verifier.md").body);
    expect(first?.schema).toBe(VerifierResultSchema);
    expect(first?.overrides).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    // The verifier input: the head file, the diff of the file, the description.
    const alpha = client.calls.find((c) => c.userMessage.includes("CLAIM-ALPHA"));
    expect(alpha?.userMessage).toContain("export function average");
    expect(alpha?.userMessage).toContain("+  for (let i = 0; i <= values.length; i++) {");
    const record = recordsUnder(join(inputs.full, "a-case"))[0];
    expect(alpha?.userMessage).toContain(record?.identity.description.split("\n")[0]);
  });

  it("matches each candidate to a golden of every label before the verifier", () => {
    expect(entryOf(out, "a-case", "CLAIM-ALPHA").golden).toEqual({ index: 0, label: "blocking" });
    expect(entryOf(out, "a-case", "CLAIM-P1").golden).toEqual({ index: 1, label: "suggestion" });
    expect(entryOf(out, "a-case", "CLAIM-P2").golden).toEqual({ index: 2, label: "dont_post" });
    expect(entryOf(out, "a-case", "CLAIM-F").golden).toEqual({ index: 3, label: "not_real" });
    // NEAR matches through the judge, from the cache of the --from repeat.
    expect(entryOf(out, "b-case", "CLAIM-NEAR").golden).toEqual({ index: 0, label: "blocking" });
    expect(entryOf(out, "b-case", "CLAIM-U").golden).toEqual({ index: 1, label: "unsure" });
  });

  it("stores each candidate with its sources, result, decision and call", () => {
    const alpha = entryOf(out, "a-case", "CLAIM-ALPHA");
    expect(alpha.repeat).toBe(1);
    expect(alpha.sources).toEqual([
      { reviewer: "diff-bugs", pass: 1 },
      { reviewer: "diff-bugs", pass: 2 },
    ]);
    expect(alpha.result).toMatchObject({ score: 95, claim_holds: true, in_scope: true });
    expect(alpha.decision).toEqual({ passed: true });
    expect(alpha.in_band).toBe(false);
    expect(alpha.call).toMatchObject({ model: "claude-sonnet-5-5", effort: "high", cost_usd: 0.1 });
    const p1 = entryOf(out, "a-case", "CLAIM-P1");
    expect(p1.in_band).toBe(true);
    expect(p1.decision).toEqual({ passed: false });
    expect(entryOf(out, "b-case", "CLAIM-U").decision).toEqual({ passed: false, unsure: "claim" });
  });

  it("gives the figures before the verifier, the truth and the severity, per case", () => {
    const a = caseOf(report, "a-case");
    expect(a.candidates).toBe(4);
    expect(a.before).toEqual({ goldens: 2, by_label: { blocking: 1, suggestion: 1, nit: 0 } });
    expect(a.truth).toEqual({
      real: { count: 3, held: 3, share: 1 },
      false: { count: 1, rejected: 1, share: 1 },
      unsure_goldens: 0,
    });
    expect(a.severity).toMatchObject({ count: 3, same: 3, post_same: 3, blocking_not_posted: 0 });
    const b = caseOf(report, "b-case");
    expect(b.truth).toEqual({
      real: { count: 1, held: 1, share: 1 },
      false: { count: 0, rejected: 0, share: null },
      unsure_goldens: 1,
    });
  });

  it("gives the posted figures, scored as the eval does", () => {
    const a = caseOf(report, "a-case");
    expect(a.posted).toEqual({
      posted: 1,
      goldens: 1,
      by_label: { blocking: 1, suggestion: 0, nit: 0 },
      false_posted: 0,
      recall: 0.5,
      precision: 1,
    });
    expect(caseOf(report, "b-case").posted).toMatchObject({ posted: 1, goldens: 1, recall: 1 });
  });

  it("gives the by-score figures in ranges of 10", () => {
    const a = caseOf(report, "a-case");
    expect(a.by_score).toEqual([
      { bucket: "20-29", count: 1, real: 0, real_share: 0 },
      { bucket: "70-79", count: 1, real: 1, real_share: 1 },
      { bucket: "90-100", count: 2, real: 2, real_share: 1 },
    ]);
    const b = caseOf(report, "b-case");
    expect(b.by_score).toEqual([
      { bucket: "50-59", count: 1, real: 0, real_share: 0 },
      { bucket: "90-100", count: 1, real: 1, real_share: 1 },
    ]);
  });

  it("sums the figures over the cases", () => {
    const total = scopeOf(report, null).total;
    expect(total.candidates).toBe(6);
    expect(total.before.by_label).toEqual({ blocking: 2, suggestion: 1, nit: 0 });
    expect(total.truth.real).toEqual({ count: 4, held: 4, share: 1 });
    expect(total.severity).toMatchObject({ count: 5, same: 5 });
    expect(total.posted).toMatchObject({ posted: 2, goldens: 2, precision: 1 });
    expect(total.posted?.recall).toBeCloseTo(2 / 3);
    expect(total).toMatchObject({ in_band: 1, unsure: 1, failed: 0, verifications: 6 });
    expect(total.cost_usd).toBeCloseTo(0.6);
    expect(total.cost_per_verification).toBeCloseTo(0.1);
  });

  it("gives the figures of each reviewer source", () => {
    expect(report.scopes.map((s) => s.source)).toEqual([null, "diff-bugs", "security"]);
    expect(scopeOf(report, "diff-bugs").total.candidates).toBe(3);
    expect(scopeOf(report, "security").total.candidates).toBe(3);
    expect(caseOf(report, "a-case", "security").posted).toMatchObject({ posted: 0 });
  });

  it("states that the figures compare only with other replays", () => {
    expect(report.note).toMatch(/compare only with other replays/);
    expect(report.note).toMatch(/--arm stored/);
  });

  it("writes report.json and prints a table by default", async () => {
    expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8"))).toEqual(report);
    const dir = tempDir("replay-table", made);
    cpSync(out, dir, { recursive: true });
    const code = await replay(replayFake(), [
      "--cases",
      inputs.cases,
      "--from",
      inputs.full,
      "--out",
      dir,
      "--resume",
      ...ARM,
    ]);
    expect(code, output.stderr).toBe(0);
    expect(output.stdout).toMatch(/compare only with other replays/);
    expect(output.stdout).toMatch(/a-case/);
  });
});

describe("pr-review replay: the prompt forms", () => {
  it("sends the truth prompt, and gives the truth figures only, with no posted or severity figures", async () => {
    const client = replayFake({ form: "truth" });
    const { code } = await replayFull(client, ...ARM, "--prompt", "truth");
    expect(code, output.stderr).toBe(0);
    expect(client.calls[0]?.systemPrompt).toBe(loadPrompt("verifier-truth.md").body);
    expect(client.calls[0]?.schema).not.toBe(VerifierResultSchema);
    const total = scopeOf(reportOf(), null).total;
    expect(total.truth.real).toEqual({ count: 4, held: 4, share: 1 });
    expect(total.posted).toBeNull();
    expect(total.severity).toBeNull();
    expect(total.by_score.map((b) => b.bucket)).toEqual(["20-29", "50-59", "70-79", "90-100"]);
  }, 120_000);

  it("sends the bands prompt, and maps each band to its score for the decision", async () => {
    const client = replayFake({ form: "bands" });
    const { code, out } = await replayFull(client, ...ARM, "--prompt", "bands");
    expect(code, output.stderr).toBe(0);
    expect(client.calls[0]?.systemPrompt).toBe(loadPrompt("verifier-bands.md").body);
    expect(loadPrompt("verifier-bands.md").frontmatter.bands).toEqual({
      contradicted: 5,
      unlikely: 25,
      possible: 50,
      likely: 75,
      certain: 95,
    });
    expect(entryOf(out, "a-case", "CLAIM-ALPHA").result).toMatchObject({
      band: "certain",
      score: 95,
    });
    expect(entryOf(out, "a-case", "CLAIM-ALPHA").decision).toEqual({ passed: true });
    // "likely" is 75: in the band, and below the threshold.
    expect(entryOf(out, "a-case", "CLAIM-P1")).toMatchObject({
      in_band: true,
      decision: { passed: false },
    });
    const total = scopeOf(reportOf(), null).total;
    expect(total.by_score.map((b) => [b.bucket, b.count])).toEqual([
      ["unlikely", 1],
      ["possible", 1],
      ["likely", 1],
      ["certain", 3],
    ]);
    expect(total.in_band).toBe(1);
  }, 120_000);
});

describe("pr-review replay: the stored arm", () => {
  it("gives the stored first results with no verifier query, and the escalation figures", async () => {
    const client = replayFake();
    const { code, out } = await replayFull(client, "--arm", "stored");
    expect(code, output.stderr).toBe(0);
    expect(client.calls).toEqual([]);
    const report = reportOf();
    expect(report.escalation?.total).toEqual({
      escalated: 3,
      changed: 2,
      cost_usd: expect.closeTo(3 * ESCALATION_COST, 6) as number,
    });
    expect(report.escalation?.cases.map((c) => [c.case, c.escalated, c.changed])).toEqual([
      ["a-case", 2, 2],
      ["b-case", 1, 0],
    ]);
    // P1 passes on its first result alone; the stored escalation failed it.
    expect(entryOf(out, "a-case", "CLAIM-P1").decision).toEqual({ passed: true });
  }, 120_000);

  it("gives the same decision as the normal run for a first result that does not escalate", async () => {
    const stored = await replayFull(replayFake(), "--arm", "stored");
    expect(stored.code, output.stderr).toBe(0);
    // A claude arm whose verifier gives the first results of the eval.
    const same = await replayFull(replayFake({ results: EVAL_FIRST }), ...ARM);
    expect(same.code, output.stderr).toBe(0);
    for (const name of ["a-case", "b-case"]) {
      const [record] = recordsUnder(join(inputs.full, name));
      for (const v of record?.stages.verifications ?? []) {
        if (v.escalated !== undefined) continue;
        expect(entryOf(stored.out, name, v.finding.claim).decision?.passed).toBe(v.passed);
        expect(entryOf(same.out, name, v.finding.claim).decision?.passed).toBe(v.passed);
      }
    }
  }, 120_000);

  it("exits 2 for the stored arm over a stage 1 record, with no call", async () => {
    const client = replayFake();
    const code = await replay(client, [
      "--cases",
      inputs.cases,
      "--from",
      inputs.stage1,
      "--out",
      tempDir("replay-stored-s1", made),
      "--arm",
      "stored",
    ]);
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/stage 1 record/);
    expect(client.calls).toEqual([]);
  }, 60_000);
});

describe("pr-review replay: stage 1 records", () => {
  it("stores the same candidates, with the same sources, that a full run verifies", () => {
    const full = recordsUnder(inputs.full);
    const stage1 = recordsUnder(inputs.stage1);
    expect(stage1).toHaveLength(2);
    stage1.forEach((record, i) => {
      expect(record.identity.mode).toBe("stage1");
      expect(
        record.stages.candidates?.map((c) => ({ finding: c.finding, sources: c.sources })),
      ).toEqual(
        full[i]?.stages.verifications.map((v) => ({ finding: v.finding, sources: v.sources })),
      );
    });
  });

  it("replays the candidates of a stage 1 record", async () => {
    const client = replayFake();
    const out = tempDir("replay-s1", made);
    const code = await replay(client, [
      "--cases",
      inputs.cases,
      "--from",
      inputs.stage1,
      "--out",
      out,
      "--format",
      "json",
      ...ARM,
    ]);
    expect(code, output.stderr).toBe(0);
    expect(client.calls.filter((c) => c.role === "verifier")).toHaveLength(6);
    expect(entryOf(out, "a-case", "CLAIM-ALPHA").sources).toEqual([
      { reviewer: "diff-bugs", pass: 1 },
      { reviewer: "diff-bugs", pass: 2 },
    ]);
  }, 120_000);
});

describe("pr-review replay: the selection of candidates", () => {
  it("keeps only the candidates of the named reviewers", async () => {
    const client = replayFake();
    const { code } = await replayFull(client, ...ARM, "--reviewers", "security");
    expect(code, output.stderr).toBe(0);
    const claims = client.calls.map((c) => /CLAIM-[A-Z0-9]+/.exec(c.userMessage)?.[0]).sort();
    expect(claims).toEqual(["CLAIM-F", "CLAIM-P2", "CLAIM-U"]);
    expect(reportOf().scopes.map((s) => s.source)).toEqual([null, "security"]);
  }, 120_000);

  it("gives the same sample for the same seed, and another sample for another seed", async () => {
    const sample = async (seed: string) => {
      const { code } = await replayFull(replayFake(), ...ARM, "--sample", "3", "--seed", seed);
      expect(code, output.stderr).toBe(0);
      return reportOf().sample;
    };
    const first = await sample("1");
    expect(first).toMatchObject({ kind: "3", seed: 1 });
    expect(first.candidates).toHaveLength(3);
    expect(await sample("1")).toEqual(first);
    const other = await sample("7");
    expect(other.candidates).not.toEqual(first.candidates);
    expect(scopeOf(reportOf(), null).total.verifications).toBe(3);
  }, 240_000);

  it("takes every candidate that matches a golden with golden-plus-equal", async () => {
    const { code } = await replayFull(replayFake(), ...ARM, "--sample", "golden-plus-equal");
    expect(code, output.stderr).toBe(0);
    const report = reportOf();
    expect(report.sample).toMatchObject({ kind: "golden-plus-equal", seed: 20261114 });
    expect(report.sample.candidates).toHaveLength(6);
  }, 120_000);
});

describe("pr-review replay: resume and the dollar limit", () => {
  it("stops at the limit, exits 4, and a resume runs only the rest", async () => {
    const { code, out } = await replayFull(replayFake(), ...ARM, "--max-cost", "0.25");
    expect(code, output.stderr).toBe(EXIT_STOPPED);
    expect(output.stderr).toMatch(/3 candidates remain/);
    const done = ["a-case", "b-case"].flatMap((name) => {
      try {
        return resultsOf(out, name).entries;
      } catch {
        return [];
      }
    });
    expect(done).toHaveLength(3);
    const client = replayFake();
    const again = await replay(client, [
      "--cases",
      inputs.cases,
      "--from",
      inputs.full,
      "--out",
      out,
      "--format",
      "json",
      "--resume",
      ...ARM,
    ]);
    expect(again, output.stderr).toBe(0);
    expect(client.calls.filter((c) => c.role === "verifier")).toHaveLength(3);
    expect(scopeOf(reportOf(), null).total.verifications).toBe(6);
  }, 120_000);

  it("counts the judge calls toward the limit", async () => {
    const from = tempDir("replay-nocache", made);
    cpSync(inputs.full, from, { recursive: true });
    rmSync(join(from, "b-case", "1", "judge-cache.json"));
    const client = replayFake({ judgeCost: 0.3 });
    const out = tempDir("replay-judge", made);
    const code = await replay(client, [
      "--cases",
      inputs.cases,
      "--from",
      from,
      "--out",
      out,
      "--format",
      "json",
      "--concurrency",
      "1",
      "--max-cost",
      "0.25",
      ...ARM,
    ]);
    expect(code, output.stderr).toBe(EXIT_STOPPED);
    expect(client.calls.map((c) => c.role)).toEqual(["judge"]);
    expect(output.stderr).toMatch(/6 candidates remain/);
    // The new answer goes to a copy of the cache in --out.
    expect(readdirSync(join(out, "b-case"))).toContain("judge-cache.json");
  }, 120_000);

  it("refuses a resume with another arm in the same directory", async () => {
    const { code, out } = await replayFull(replayFake(), ...ARM);
    expect(code, output.stderr).toBe(0);
    const client = replayFake();
    const again = await replay(client, [
      "--cases",
      inputs.cases,
      "--from",
      inputs.full,
      "--out",
      out,
      "--resume",
      "--verifier",
      "claude:opus:high",
    ]);
    expect(again).toBe(2);
    expect(output.stderr).toMatch(/arm/);
    expect(client.calls).toEqual([]);
  }, 120_000);

  it("states the bound of the overshoot in the help text", () => {
    output.stdout = "";
    return replay(replayFake(), ["--help"]).then((code) => {
      expect(code).toBe(0);
      expect(output.stdout).toMatch(/--max-cost <usd>[\s\S]*concurrency\s+times\s+the\s+largest/);
      expect(output.stdout).toMatch(/compare\s+only\s+with\s+other\s+replays/);
    });
  });
});

describe("pr-review replay: the codex backend and usage", () => {
  it("refuses the codex backend before any call", async () => {
    const client = replayFake();
    const { code } = await replayFull(client, "--verifier", "codex:gpt-6.1-sol:high");
    expect(code).toBe(2);
    expect(output.stderr).toContain(
      "the codex verifier needs the model and effort options of the Codex call",
    );
    expect(client.calls).toEqual([]);
  }, 60_000);

  // Each usage error, with a part of its message.
  const usage: [string, string[], RegExp][] = [
    ["no arm", [], /give --verifier or --arm stored/],
    ["both --arm stored and --verifier", ["--arm", "stored", ...ARM], /not both/],
    ["an unknown backend", ["--verifier", "gemini:x:high"], /backend "gemini"/],
    ["an unknown effort", ["--verifier", "claude:sonnet:huge"], /effort "huge"/],
    ["an unknown prompt form", [...ARM, "--prompt", "story"], /story/],
    ["an unknown severity mode", [...ARM, "--severity", "case:sonnet:high"], /mode "case"/],
  ];
  for (const [what, flags, message] of usage) {
    it(`exits 2 for ${what}, with no call`, async () => {
      const client = replayFake();
      const { code } = await replayFull(client, ...flags);
      expect(code).toBe(2);
      expect(output.stderr).toMatch(message);
      expect(client.calls).toEqual([]);
    }, 60_000);
  }
});

describe("pr-review replay: external candidates", () => {
  const CONFIG = "thresholds:\n  default: 90\n  middle_band: [50, 90]\n";
  let cases = "";
  let title = "";
  beforeAll(async () => {
    const root = tempDir("replay-ext", made);
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "config.yaml"), CONFIG);
    const { stdout } = await run("bash", [FIXTURE_SCRIPT, "--pr-review-dir", join(root, "config")]);
    const value = (key: string) =>
      stdout
        .split("\n")
        .find((l) => l.startsWith(`${key}=`))
        ?.slice(key.length + 1) ?? "";
    const fx = { repo: value("FIXTURE"), base: value("BASE"), head: value("HEAD") };
    made.push(fx.repo);
    const template = await makeTemplate(fx, root);
    cases = casesFrom(template, join(root, "cases"), [{ name: "ext-case", golden: [] }]);
    title = (
      JSON.parse(readFileSync(join(cases, "ext-case", "case.json"), "utf8")) as { title: string }
    ).title;
  }, 60_000);

  it("checks each finding as the pipeline does, and uses the source and the default threshold", async () => {
    const dir = tempDir("replay-ext-in", made);
    const HIGH = finding("src/stats.ts", 13, "bug", "CLAIM-HIGH", "total += values[i];");
    writeFileSync(
      join(dir, "ext-case.json"),
      JSON.stringify({
        source: "outside",
        findings: [
          ALPHA,
          HIGH,
          finding("src/stats.ts", 999, "bug", "CLAIM-RANGE", "x"),
          finding("src/stats.ts", 11, "bug", "CLAIM-QUOTE", "this text is in no file"),
        ],
      }),
    );
    const results = {
      // 88 passes at the default threshold of 80, but this repo sets 90.
      "CLAIM-ALPHA": { ...EVAL_FIRST["CLAIM-ALPHA"], score: 88 },
      "CLAIM-HIGH": { ...EVAL_FIRST["CLAIM-ALPHA"], score: 95 },
    } as typeof EVAL_FIRST;
    const client = replayFake({ results });
    const out = tempDir("replay-ext-out", made);
    const code = await replay(client, [
      "--cases",
      cases,
      "--candidates",
      dir,
      "--out",
      out,
      "--format",
      "json",
      ...ARM,
    ]);
    expect(code, output.stderr).toBe(0);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.userMessage).toContain(title);
    const alpha = entryOf(out, "ext-case", "CLAIM-ALPHA");
    expect(alpha).toMatchObject({
      repeat: "external",
      reviewer: "outside",
      decision: { passed: false },
    });
    expect(entryOf(out, "ext-case", "CLAIM-HIGH").decision).toEqual({ passed: true });
    const report = reportOf();
    expect(report.scopes.map((s) => s.source)).toEqual([null, "outside"]);
    expect(scopeOf(report, null).total.dropped).toEqual({ "out-of-range": 1, "bad-quote": 1 });
    expect(caseOf(report, "ext-case").dropped).toEqual({ "out-of-range": 1, "bad-quote": 1 });
  }, 120_000);

  it("exits 2 for a candidates file that does not fit the schema", async () => {
    const dir = tempDir("replay-ext-bad", made);
    writeFileSync(join(dir, "ext-case.json"), JSON.stringify({ source: "x", findings: [{}] }));
    const client = replayFake();
    const code = await replay(client, [
      "--cases",
      cases,
      "--candidates",
      dir,
      "--out",
      tempDir("replay-ext-bad-out", made),
      ...ARM,
    ]);
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/ext-case\.json/);
    expect(client.calls).toEqual([]);
  }, 60_000);
});
