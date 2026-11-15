// D4c R6: the severity step of pr-review replay. It labels each candidate
// that the verifier says holds and is in scope, with no tools, and its
// label replaces the verifier label in the decision.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReplayReport, ResultsFile } from "../src/eval/replay/index.js";
import { readPolicy } from "../src/eval/label/policy.js";
import { isRecordFileName } from "../src/record/write.js";
import type { RunRecord } from "../src/schemas/record.js";
import { buildQueryOptions } from "../src/sdk/options.js";
import {
  captured,
  captureOutput,
  cleanup,
  makeFixture,
  output,
  tempDir,
} from "./fixtures/eval-fixture.js";
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

async function replayInto(
  out: string,
  client: ReturnType<typeof replayFake>,
  ...extra: string[]
): Promise<number> {
  return replay(client, [
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
}

const resultsOf = (out: string, name: string): ResultsFile =>
  JSON.parse(readFileSync(join(out, name, "results.json"), "utf8")) as ResultsFile;
const entryOf = (out: string, name: string, claim: string) => {
  const entry = resultsOf(out, name).entries.find((e) => e.finding.claim === claim);
  if (!entry) throw new Error(`no entry ${claim}`);
  return entry;
};
const severityCalls = (client: ReturnType<typeof replayFake>) =>
  client.calls.filter((c) => c.role === "severity-finding" || c.role === "severity-pr");

function descriptionOf(name: string): string {
  const dir = join(inputs.full, name, "1");
  const file = readdirSync(dir).find((f) => isRecordFileName(f) && statSync(join(dir, f)).isFile());
  const record = JSON.parse(readFileSync(join(dir, file ?? ""), "utf8")) as RunRecord;
  return record.identity.description;
}

// ALPHA, P1, P2, NEAR and U hold and are in scope. F does not hold.
const HELD = 5;

describe("pr-review replay --severity finding", () => {
  let client: ReturnType<typeof replayFake>;
  let out = "";
  beforeAll(async () => {
    out = tempDir("severity-finding", made);
    // The step labels ALPHA dont_post: then it does not post.
    client = replayFake({ labels: { "CLAIM-ALPHA": "dont_post" }, severityCost: 0.05 });
    // A beforeAll hook is outside of the capture of each test.
    const code = await captured(() =>
      replayInto(out, client, ...ARM, "--severity", "finding:opus:high"),
    );
    if (code !== 0) throw new Error(`the replay exited ${code}: ${output.stderr}`);
  }, 120_000);

  it("makes one call for each candidate that holds and is in scope", () => {
    const calls = severityCalls(client);
    expect(calls).toHaveLength(HELD);
    expect(calls.every((c) => c.role === "severity-finding")).toBe(true);
    expect(calls.some((c) => c.userMessage.includes("CLAIM-F"))).toBe(false);
  });

  it("sends no tools, and the model, the effort and the limits of the role", () => {
    for (const call of severityCalls(client)) {
      expect(call.tools).toBeUndefined();
      const sdk = buildQueryOptions(call, { allowApiKey: false, env: {} });
      expect(sdk.tools).toEqual([]);
      expect(sdk).toMatchObject({
        model: "claude-opus-5-5",
        effort: "high",
        maxTurns: 5,
        maxBudgetUsd: 0.5,
      });
    }
  });

  it("gives the policy, the finding, the verifier quotes and the description in the message", () => {
    const alpha = severityCalls(client).find((c) => c.userMessage.includes("CLAIM-ALPHA"));
    const policy = readPolicy().trim().split("\n");
    expect(alpha?.userMessage).toContain(policy[0]);
    expect(alpha?.userMessage).toContain(policy.at(-1));
    expect(alpha?.userMessage).toContain("for (let i = 0; i <= values.length; i++) {");
    expect(alpha?.userMessage).toContain("return total / values.length");
    expect(alpha?.userMessage).toContain(descriptionOf("a-case").split("\n")[0]);
  });

  it("uses the label of the step in the decision and in the severity figures", () => {
    const alpha = entryOf(out, "a-case", "CLAIM-ALPHA");
    expect(alpha.severity).toMatchObject({
      label: "dont_post",
      call: { model: "claude-opus-5-5", effort: "high", cost_usd: 0.05 },
    });
    expect(alpha.decision).toEqual({ passed: false });
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as ReplayReport;
    const total = report.scopes.find((s) => s.source === null)?.total;
    expect(total?.severity).toMatchObject({ count: 5, same: 4, blocking_not_posted: 1 });
    expect(total?.posted).toMatchObject({ posted: 1 });
    expect(total?.severity_cost_usd).toBeCloseTo(HELD * 0.05);
    // The verifier and the step together, for each verified candidate.
    expect(total?.cost_per_finding).toBeCloseTo((6 * 0.1 + HELD * 0.05) / 6);
  });

  it("makes no call again on a resume with the same step", async () => {
    const again = replayFake({ labels: { "CLAIM-ALPHA": "dont_post" } });
    expect(
      await replayInto(out, again, ...ARM, "--severity", "finding:opus:high", "--resume"),
    ).toBe(0);
    expect(again.calls).toEqual([]);
  }, 120_000);
});

describe("pr-review replay --severity pr", () => {
  it("makes one call for each case, with all its candidates that hold", async () => {
    const out = tempDir("severity-pr", made);
    const client = replayFake({ labels: { "CLAIM-NEAR": "nit" } });
    const code = await replayInto(out, client, ...ARM, "--severity", "pr:sonnet:medium");
    expect(code, output.stderr).toBe(0);
    const calls = severityCalls(client);
    expect(calls.map((c) => c.role)).toEqual(["severity-pr", "severity-pr"]);
    const a = calls.find((c) => c.userMessage.includes("CLAIM-ALPHA"));
    for (const claim of ["CLAIM-ALPHA", "CLAIM-P1", "CLAIM-P2"]) {
      expect(a?.userMessage).toContain(claim);
    }
    expect(a?.userMessage).not.toContain("CLAIM-F");
    const sdk = buildQueryOptions(a ?? calls[0]!, { allowApiKey: false, env: {} });
    expect(sdk).toMatchObject({ tools: [], maxTurns: 5, maxBudgetUsd: 1 });
    expect(entryOf(out, "b-case", "CLAIM-NEAR").severity?.label).toBe("nit");
    expect(entryOf(out, "b-case", "CLAIM-NEAR").decision).toEqual({ passed: true });
  }, 120_000);

  it("adds only the severity calls on a resume of a run with no step", async () => {
    const out = tempDir("severity-add", made);
    expect(await replayInto(out, replayFake(), ...ARM), output.stderr).toBe(0);
    const client = replayFake();
    const code = await replayInto(
      out,
      client,
      ...ARM,
      "--severity",
      "finding:sonnet:high",
      "--resume",
    );
    expect(code, output.stderr).toBe(0);
    expect(client.calls.filter((c) => c.role === "verifier")).toEqual([]);
    expect(severityCalls(client)).toHaveLength(HELD);
  }, 120_000);

  it("takes --severity with the stored arm", async () => {
    const out = tempDir("severity-stored", made);
    const client = replayFake();
    const code = await replayInto(
      out,
      client,
      "--arm",
      "stored",
      "--severity",
      "finding:sonnet:high",
    );
    expect(code, output.stderr).toBe(0);
    expect(client.calls.filter((c) => c.role === "verifier")).toEqual([]);
    // The stored first results: ALPHA, P1, P2, NEAR and U hold.
    expect(severityCalls(client)).toHaveLength(5);
  }, 120_000);
});
