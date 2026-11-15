// pr-review replay --verifier-cap: the dollar cap of one verifier call of an arm.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_DEFAULTS } from "../src/config/models.js";
import type { Figures, ReplayReport } from "../src/eval/replay/index.js";
import { captureOutput, cleanup, makeFixture, output, tempDir } from "./fixtures/eval-fixture.js";
import { makeReplayInputs, replay, replayFake, type Made } from "./fixtures/replay-fixture.js";

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

async function run(
  client: ReturnType<typeof replayFake>,
  extra: string[],
  out = tempDir("replay-cap", made),
  format = "json",
) {
  const code = await replay(client, [
    "--cases",
    inputs.cases,
    "--from",
    inputs.full,
    "--out",
    out,
    "--format",
    format,
    "--concurrency",
    "1",
    ...extra,
  ]);
  return { code, out };
}

const caps = (client: ReturnType<typeof replayFake>) =>
  client.calls.filter((c) => c.role === "verifier").map((c) => c.overrides?.maxBudgetUsd);

describe("pr-review replay --verifier-cap", () => {
  it("gives the dollar cap of the verifier role to each call by default", async () => {
    const client = replayFake();
    const { code } = await run(client, ARM);
    expect(code, output.stderr).toBe(0);
    expect(caps(client)).toEqual(Array(6).fill(ROLE_DEFAULTS.verifier.maxBudgetUsd));
  }, 120_000);

  it("gives the set cap to each call", async () => {
    const client = replayFake();
    const { code } = await run(client, [...ARM, "--verifier-cap", "0.2"]);
    expect(code, output.stderr).toBe(0);
    expect(caps(client)).toEqual(Array(6).fill(0.2));
  }, 120_000);

  it.each(["0", "-1", "abc"])("refuses the cap %s", async (value) => {
    const client = replayFake();
    const { code } = await run(client, [...ARM, "--verifier-cap", value]);
    expect(code).toBe(2);
    expect(client.calls).toEqual([]);
  });

  it("refuses a resume with another cap in the same directory", async () => {
    const first = await run(replayFake(), [...ARM, "--verifier-cap", "0.2"]);
    expect(first.code, output.stderr).toBe(0);
    const client = replayFake();
    const again = await run(client, [...ARM, "--resume", "--verifier-cap", "0.3"], first.out);
    expect(again.code).toBe(2);
    expect(output.stderr).toMatch(/arm/);
    expect(client.calls).toEqual([]);
  }, 120_000);

  it("resumes with the same cap", async () => {
    const first = await run(replayFake(), [...ARM, "--verifier-cap", "0.2"]);
    const client = replayFake();
    const again = await run(client, [...ARM, "--resume", "--verifier-cap", "0.2"], first.out);
    expect(again.code, output.stderr).toBe(0);
    expect(client.calls.filter((c) => c.role === "verifier")).toEqual([]);
  }, 120_000);

  it("counts the calls that stopped on their limit as capped and unsure, in total and per case", async () => {
    const client = replayFake({ limitVerifier: ["CLAIM-P1", "CLAIM-F"] });
    const { code } = await run(client, ARM);
    expect(code, output.stderr).toBe(0);
    const report = JSON.parse(output.stdout) as ReplayReport;
    const scope = report.scopes.find((s) => s.source === null);
    const rows: Figures[] = scope?.cases ?? [];
    expect(scope?.total.capped).toBe(2);
    expect(scope?.total.unsure).toBeGreaterThanOrEqual(2);
    expect(rows.reduce((t, f) => t + f.capped, 0)).toBe(2);
    expect(rows.every((f) => f.capped <= f.unsure)).toBe(true);
  }, 120_000);

  it("shows the capped count in the table", async () => {
    const client = replayFake({ limitVerifier: ["CLAIM-P1"] });
    await run(client, ARM, undefined, "table");
    expect(output.stdout).toMatch(/capped/);
  }, 120_000);

  it("names --verifier-cap in the help of --max-cost, and says codex ignores it", async () => {
    const code = await replay(replayFake(), ["--help"]);
    expect(code).toBe(0);
    expect(output.stdout).toMatch(/--max-cost <usd>[\s\S]*--verifier-cap/);
    expect(output.stdout).toMatch(/--verifier-cap <usd>[\s\S]*codex/i);
  });
});
