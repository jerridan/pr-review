// The review fixes of pr-review replay (PR 57): resume of failed results,
// the remaining count, the judge after a stop, old records, the key of a
// candidate, the cost of the stored arm, and the usage errors.
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_STOPPED } from "../src/cli.js";
import type { ReplayReport, ResultsFile } from "../src/eval/replay/index.js";
import { isRecordFileName } from "../src/record/write.js";
import { captureOutput, cleanup, makeFixture, output, tempDir } from "./fixtures/eval-fixture.js";
import {
  finding,
  makeReplayInputs,
  replay,
  replayFake,
  type Made,
  type ReplayFakeOptions,
} from "./fixtures/replay-fixture.js";

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

async function replayInto(
  out: string,
  client: ReturnType<typeof replayFake>,
  ...extra: string[]
): Promise<number> {
  return replay(client, [
    "--cases",
    inputs.cases,
    "--out",
    out,
    "--format",
    "json",
    "--concurrency",
    "1",
    ...extra,
  ]);
}

const fromFull = (dir = inputs.full) => ["--from", dir];
const reportOf = (): ReplayReport => JSON.parse(output.stdout) as ReplayReport;
const resultsOf = (out: string, name: string): ResultsFile =>
  JSON.parse(readFileSync(join(out, name, "results.json"), "utf8")) as ResultsFile;
const entriesOf = (out: string, name: string, claim: string) =>
  resultsOf(out, name).entries.filter((e) => e.finding.claim === claim);
const callsOf = (client: ReturnType<typeof replayFake>, role: string) =>
  client.calls.filter((c) => c.role === role);

// Run once with a fake that fails some calls, then resume with a fake that
// fails none. Give the counts of both runs.
async function failThenResume(fail: ReplayFakeOptions, ...extra: string[]) {
  const out = tempDir("patch-resume", made);
  const code = await replayInto(out, replayFake(fail), ...fromFull(), ...ARM, ...extra);
  expect(code, output.stderr).toBe(0);
  const first = reportOf();
  const client = replayFake();
  const again = await replayInto(out, client, ...fromFull(), ...ARM, ...extra, "--resume");
  expect(again, output.stderr).toBe(0);
  return { out, first, second: reportOf(), client };
}

describe("replay --resume after a failed call (items 1, 3, 12)", () => {
  it("runs a failed verifier call again, and counts it as remaining before", async () => {
    const { out, first, second, client } = await failThenResume({ failVerifier: ["CLAIM-ALPHA"] });
    expect(first.remaining).toBe(1);
    expect(callsOf(client, "verifier")).toHaveLength(1);
    expect(client.calls[0]?.userMessage).toContain("CLAIM-ALPHA");
    expect(second.remaining).toBe(0);
    expect(entriesOf(out, "a-case", "CLAIM-ALPHA")[0]?.decision).toEqual({ passed: true });
  }, 120_000);

  it("runs a failed severity call again, and counts it as remaining before", async () => {
    const { out, first, second, client } = await failThenResume(
      { failSeverity: ["CLAIM-ALPHA"] },
      "--severity",
      "finding:sonnet:high",
    );
    expect(first.remaining).toBe(1);
    const failed = first.scopes.find((s) => s.source === null)?.total.failed;
    expect(failed).toBe(1);
    expect(callsOf(client, "verifier")).toEqual([]);
    expect(callsOf(client, "severity-finding")).toHaveLength(1);
    expect(second.remaining).toBe(0);
    expect(entriesOf(out, "a-case", "CLAIM-ALPHA")[0]?.severity).toMatchObject({
      label: "blocking",
    });
  }, 120_000);

  it("asks the whole case again when a pr answer leaves out an index", async () => {
    const { first, second, client } = await failThenResume(
      { omit: ["CLAIM-P1"] },
      "--severity",
      "pr:sonnet:high",
    );
    expect(first.remaining).toBe(1);
    const calls = callsOf(client, "severity-pr");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userMessage).toContain("CLAIM-ALPHA");
    expect(calls[0]?.userMessage).toContain("CLAIM-P1");
    expect(second.remaining).toBe(0);
  }, 120_000);
});

describe("replay: the judge after a --max-cost stop (item 2)", () => {
  it("asks no judge question after the stop, and caches no answer for a refused one", async () => {
    const from = tempDir("patch-nocache", made);
    cpSync(inputs.full, from, { recursive: true });
    rmSync(join(from, "b-case", "1", "judge-cache.json"));
    // An external finding near both goldens of b-case: two more questions.
    const dir = tempDir("patch-ext", made);
    writeFileSync(
      join(dir, "b-case.json"),
      JSON.stringify({
        source: "outside",
        findings: [
          finding("src/stats.ts", 13, "bug", "CLAIM-EXT", "return total / values.length;"),
        ],
      }),
    );
    const client = replayFake({ judgeCost: 0.3 });
    const out = tempDir("patch-stop", made);
    const code = await replayInto(
      out,
      client,
      ...fromFull(from),
      "--candidates",
      dir,
      ...ARM,
      "--max-cost",
      "0.25",
    );
    expect(code, output.stderr).toBe(EXIT_STOPPED);
    expect(client.calls.map((c) => c.role)).toEqual(["judge"]);
    const cache = JSON.parse(readFileSync(join(out, "b-case", "judge-cache.json"), "utf8")) as {
      answers: Record<string, string>;
    };
    expect(Object.values(cache.answers)).toEqual(["yes"]);
    expect(reportOf().judge.uncached).toBeGreaterThan(0);
    expect(output.stderr).toMatch(/posted figures are partial/);
  }, 120_000);
});

// Read the record of one case of a copy of the full eval, give it to
// "edit", and write it back.
function editRecord(dir: string, name: string, edit: (record: Record<string, unknown>) => void) {
  const repeat = join(dir, name, "1");
  const file = readdirSync(repeat).find(isRecordFileName);
  if (!file) throw new Error(`no record in ${repeat}`);
  const record = JSON.parse(readFileSync(join(repeat, file), "utf8")) as Record<string, unknown>;
  edit(record);
  writeFileSync(join(repeat, file), JSON.stringify(record));
  return file;
}

type Verification = { sources?: { reviewer: string; pass: number }[] };
const verificationsOf = (record: Record<string, unknown>) =>
  (record.stages as { verifications: Verification[] }).verifications;

describe("replay: the records (items 4, 9)", () => {
  it("exits 2 for a full record with no sources, and names the record, before any call", async () => {
    const from = tempDir("patch-old", made);
    cpSync(inputs.full, from, { recursive: true });
    const file = editRecord(from, "a-case", (record) => {
      for (const v of verificationsOf(record)) delete v.sources;
    });
    const client = replayFake();
    const code = await replayInto(
      tempDir("patch-old-out", made),
      client,
      ...fromFull(from),
      ...ARM,
    );
    expect(code).toBe(2);
    expect(output.stderr).toContain(file);
    expect(output.stderr).toMatch(/sources/);
    expect(client.calls).toEqual([]);
  }, 120_000);

  it("keeps two candidates with the same file, span and claim from two reviewers", async () => {
    const from = tempDir("patch-twin", made);
    cpSync(inputs.full, from, { recursive: true });
    editRecord(from, "a-case", (record) => {
      const list = verificationsOf(record);
      const twin = JSON.parse(JSON.stringify(list[0])) as Verification;
      twin.sources = [{ reviewer: "security", pass: 1 }];
      list.push(twin);
    });
    const client = replayFake();
    const out = tempDir("patch-twin-out", made);
    expect(await replayInto(out, client, ...fromFull(from), ...ARM), output.stderr).toBe(0);
    expect(callsOf(client, "verifier")).toHaveLength(7);
    expect(
      entriesOf(out, "a-case", "CLAIM-ALPHA")
        .map((e) => e.reviewer)
        .sort(),
    ).toEqual(["diff-bugs", "security"]);
  }, 120_000);
});

describe("replay --arm stored: the cost (item 11)", () => {
  it("names the cost of the stored calls apart from the spend of this run", async () => {
    const client = replayFake();
    const out = tempDir("patch-stored", made);
    expect(await replayInto(out, client, ...fromFull(), "--arm", "stored"), output.stderr).toBe(0);
    const report = reportOf();
    expect(report.cost.total_usd).toBe(0);
    // The eval made 6 first verifier calls at $0.10 and 3 escalations at $0.20.
    expect(report.cost.stored_usd).toBeCloseTo(6 * 0.1 + 3 * 0.2);
  }, 120_000);
});

describe("replay: usage errors (item 12)", () => {
  it("exits 2 with no --from and no --candidates, with no call", async () => {
    const client = replayFake();
    const code = await replayInto(tempDir("patch-none", made), client, ...ARM);
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/give --from, --candidates or both/);
    expect(client.calls).toEqual([]);
  });

  it("exits 2 for --arm stored with --candidates, with no call", async () => {
    const dir = tempDir("patch-stored-ext", made);
    const client = replayFake();
    const code = await replayInto(
      tempDir("patch-stored-ext-out", made),
      client,
      ...fromFull(),
      "--candidates",
      dir,
      "--arm",
      "stored",
    );
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/--arm stored .*--candidates/);
    expect(client.calls).toEqual([]);
  });
});
