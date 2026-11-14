// D8 R4: an eval run limited to named reviewers, with passes set for the run.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import type { RunRecord } from "../src/schemas/record.js";
import type { QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import {
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
let cases = "";
afterAll(() => cleanup(made));
captureOutput();

beforeAll(async () => {
  const fx = await makeFixture();
  made.push(fx.repo);
  const root = tempDir("reviewers", made);
  const template = await makeTemplate(fx, root);
  cases = casesFrom(template, join(root, "cases"), [{ name: "case-a", golden: [] }]);
}, 60_000);

// Every reviewer finds nothing, so a run is triage and the reviewer queries.
function fake() {
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const raw = {
      model: "m",
      durationMs: 1,
      stopReason: "end_turn",
      subtype: "success",
      usage: {},
      costUsd: 0.01,
    };
    if (req.role === "triage") {
      return {
        ok: true,
        output: {
          tier: "full",
          reason: "r",
          confidence: "high",
          categories: ["bug"],
          hotspots: [],
          file_notes: [],
          summary: "s",
        },
        raw,
      };
    }
    if (req.role === "reviewer") return { ok: true, output: { findings: [] }, raw };
    throw new Error(`unexpected role ${req.role}`);
  });
}

async function evalWith(out: string, client: ReturnType<typeof fake>, ...extra: string[]) {
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
      ...extra,
    ]),
  );
}

function recordsUnder(dir: string): RunRecord[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return recordsUnder(full);
    if (!/^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[0-9a-f]{7}\.json$/.test(name)) return [];
    return [JSON.parse(readFileSync(full, "utf8")) as RunRecord];
  });
}

describe("pr-review eval --reviewers --passes (D8 R4)", () => {
  it("runs only the named reviewers, each with the passes of the run", async () => {
    const out = tempDir("reviewers-out", made);
    const client = fake();
    const code = await evalWith(
      out,
      client,
      "--reviewers",
      "history,tests",
      "--passes",
      "history=2,tests=2",
    );
    expect(code, output.stderr).toBe(0);
    const [record] = recordsUnder(out);
    expect(record?.stages.reviewers.map((r) => [r.name, r.pass]).sort()).toEqual([
      ["history", 1],
      ["history", 2],
      ["tests", 1],
      ["tests", 2],
    ]);
    const asked = new Set(
      client.calls.filter((c) => c.role === "reviewer").map((c) => c.reviewerName),
    );
    expect([...asked].sort()).toEqual(["history", "tests"]);
    // A pass that --passes adds gets the turn budget of every pass: 150
    // turns, $0.05 per turn and 10 s per turn.
    const budgets = client.calls
      .filter((c) => c.role === "reviewer")
      .map((c) => [c.overrides?.maxTurns, c.overrides?.maxBudgetUsd, c.overrides?.timeoutMs]);
    expect(budgets).toEqual(Array.from({ length: 4 }, () => [150, 7.5, 1_500_000]));
  }, 60_000);

  it("refuses to resume a run with other reviewers", async () => {
    const out = tempDir("reviewers-resume", made);
    expect(await evalWith(out, fake(), "--reviewers", "history")).toBe(0);
    const code = await evalWith(out, fake(), "--reviewers", "tests", "--resume");
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/other options/);
  }, 60_000);

  // Each usage error, with a part of its message.
  const usage: [string, string[], RegExp][] = [
    [
      "an unknown name in --reviewers",
      ["--reviewers", "history,no-such-reviewer"],
      /unknown reviewer no-such-reviewer/,
    ],
    [
      "an unknown name in --passes",
      ["--passes", "no-such-reviewer=2"],
      /unknown reviewer no-such-reviewer/,
    ],
    ["a pass count that is not a positive integer", ["--passes", "history=0"], /history=0/],
    ["--passes with --tier fast", ["--passes", "history=2", "--tier", "fast"], /--tier fast/],
    [
      "--reviewers with --baseline",
      ["--reviewers", "history", "--baseline", "b.json"],
      /not comparable to the baseline/,
    ],
    [
      "--reviewers with --write-baseline",
      ["--reviewers", "history", "--write-baseline", "--baseline", "b.json"],
      /not comparable to the baseline/,
    ],
    [
      "--passes with --baseline",
      ["--passes", "history=2", "--baseline", "b.json"],
      /not comparable to the baseline/,
    ],
    [
      "--passes with --write-baseline",
      ["--passes", "history=2", "--write-baseline", "--baseline", "b.json"],
      /not comparable to the baseline/,
    ],
  ];
  for (const [what, flags, message] of usage) {
    it(`exits 2 for ${what}, with no model call`, async () => {
      const client = fake();
      const code = await evalWith(tempDir("reviewers-usage", made), client, ...flags);
      expect(code).toBe(2);
      expect(output.stderr).toMatch(message);
      expect(client.calls).toEqual([]);
    }, 60_000);
  }
});
