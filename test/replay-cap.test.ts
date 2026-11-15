// pr-review replay --verifier-cap: the dollar cap of one verifier call of an arm.
import { cpSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JUDGE_DEFAULTS,
  ROLE_DEFAULTS,
  SEVERITY_FINDING_DEFAULTS,
  SEVERITY_PR_DEFAULTS,
} from "../src/config/models.js";
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

  it("counts a capped call as unsure and not as failed", async () => {
    const client = replayFake({
      limitVerifier: ["CLAIM-P1", "CLAIM-F"],
      failVerifier: ["CLAIM-U"],
    });
    const { code } = await run(client, ARM);
    expect(code, output.stderr).toBe(0);
    const report = JSON.parse(output.stdout) as ReplayReport;
    const total = report.scopes.find((s) => s.source === null)?.total;
    expect(total?.capped).toBe(2);
    expect(total?.failed).toBe(1);
  }, 120_000);

  it("does not call a capped candidate again on a resume at the same cap", async () => {
    const first = await run(replayFake({ limitVerifier: ["CLAIM-P1", "CLAIM-F"] }), ARM);
    expect(first.code, output.stderr).toBe(0);
    const client = replayFake();
    const again = await run(client, [...ARM, "--resume"], first.out);
    expect(again.code, output.stderr).toBe(0);
    expect(client.calls.filter((c) => c.role === "verifier")).toEqual([]);
    const report = JSON.parse(output.stdout) as ReplayReport;
    expect(report.remaining).toBe(0);
    expect(report.scopes.find((s) => s.source === null)?.total.capped).toBe(2);
  }, 120_000);

  it("refuses --verifier-cap with --arm stored", async () => {
    const client = replayFake();
    const code = await replay(client, [
      "--cases",
      inputs.cases,
      "--from",
      inputs.full,
      "--out",
      tempDir("replay-cap", made),
      "--arm",
      "stored",
      "--verifier-cap",
      "0.2",
    ]);
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/--verifier-cap/);
    expect(client.calls).toEqual([]);
  });

  it("shows the capped count in the total row of the table", async () => {
    const client = replayFake({ limitVerifier: ["CLAIM-P1", "CLAIM-F"] });
    await run(client, ARM, undefined, "table");
    const rows = output.stdout
      .split("\n")
      .filter((l) => /^(case|total)\s/.test(l))
      .map((l) => l.trim().split(/\s{2,}/));
    const at = rows[0]?.indexOf("capped") ?? -1;
    expect(at).toBeGreaterThan(-1);
    expect(rows.find((r) => r[0] === "total")?.[at]).toBe("2");
  }, 120_000);

  it("states the bound of --max-cost from the verifier, severity and judge caps", async () => {
    await replay(replayFake(), ["--help"]);
    const help = output.stdout.replace(/\s+/g, " ");
    expect(help).toContain(
      `verifier cap (--verifier-cap, default $${ROLE_DEFAULTS.verifier.maxBudgetUsd})`,
    );
    expect(help).toContain(`$${SEVERITY_PR_DEFAULTS.maxBudgetUsd} with --severity pr`);
    expect(help).toContain(`$${SEVERITY_FINDING_DEFAULTS.maxBudgetUsd} with --severity finding`);
    expect(help).toContain(`judge cap ($${JUDGE_DEFAULTS.maxBudgetUsd})`);
  });

  it("names --verifier-cap in the help of --max-cost, and says codex ignores it", async () => {
    const code = await replay(replayFake(), ["--help"]);
    expect(code).toBe(0);
    expect(output.stdout).toMatch(/--max-cost <usd>[\s\S]*--verifier-cap/);
    expect(output.stdout).toMatch(/--verifier-cap <usd>[\s\S]*codex/i);
  });

  it("says in the help that the stored arm can ask the judge, and that --max-cost counts it", async () => {
    const code = await replay(replayFake(), ["--help"]);
    expect(code).toBe(0);
    expect(output.stdout).toMatch(/--arm <arm>[\s\S]*judge[\s\S]*--max-cost/);
  });
});

describe("pr-review replay --judge-cache", () => {
  it("lets a second arm with the same shared cache ask the judge nothing", async () => {
    // A copy of the eval directory with no judge cache.
    const from = tempDir("replay-nocache", made);
    cpSync(inputs.full, from, { recursive: true });
    for (const name of readdirSync(from).filter((n) => n.endsWith("-case"))) {
      rmSync(join(from, name, "1", "judge-cache.json"), { force: true, recursive: false });
    }
    const shared = tempDir("replay-shared", made);
    const args = (out: string) => [
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
      "--judge-cache",
      shared,
      ...ARM,
    ];
    const one = replayFake();
    expect(await replay(one, args(tempDir("replay-j1", made))), output.stderr).toBe(0);
    expect(one.calls.filter((c) => c.role === "judge").length).toBeGreaterThan(0);
    const two = replayFake();
    expect(await replay(two, args(tempDir("replay-j2", made))), output.stderr).toBe(0);
    expect(two.calls.filter((c) => c.role === "judge")).toEqual([]);
  }, 120_000);

  it("names --judge-cache in the help, with the advice to share it between arms", async () => {
    await replay(replayFake(), ["--help"]);
    expect(output.stdout).toMatch(/--judge-cache <dir>[\s\S]*every\s+arm/i);
  });
});
