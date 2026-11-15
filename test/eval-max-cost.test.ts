// D4c R3: pr-review eval --max-cost stops before a new repeat when the
// spend of the invocation reaches the limit, and exits with EXIT_STOPPED.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram, EXIT_STOPPED } from "../src/cli.js";
import type { GoldenFinding } from "../src/eval/case.js";
import type { Report } from "../src/eval/report.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
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
afterAll(() => cleanup(made));
captureOutput();

// A golden next to the finding below with no overlap, so the pair is
// ambiguous and goes to the judge.
const GOLDEN: GoldenFinding = {
  file: "src/stats.ts",
  start_line: 11,
  end_line: 11,
  category: "bug",
  severity: "blocking",
  claim: "The loop reads one element past the end.",
};
const NEAR = {
  file: "src/stats.ts",
  start_line: 12,
  end_line: 12,
  category: "bug",
  severity_estimate: "blocking",
  confidence: "high",
  claim: "The sum reads one element past the end.",
  evidence: "total += values[i];",
  explanation: "e",
  needs_context: false,
};

let template = "";
let plain = "";
let judged = "";
beforeAll(async () => {
  const fx = await makeFixture();
  made.push(fx.repo);
  const root = tempDir("max-cost", made);
  template = await makeTemplate(fx, root);
  plain = casesFrom(template, join(root, "plain"), [{ name: "case-a", golden: [] }]);
  judged = casesFrom(template, join(root, "judged"), [{ name: "case-j", golden: [GOLDEN] }]);
}, 60_000);

const meta = (costUsd: number): QueryMeta => ({
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd,
});

type Costs = { triage: number; judge?: number; finding?: boolean; reviewerFails?: boolean };

// Each repeat costs the triage query, plus the judge query when the
// reviewer gives the finding NEAR.
function fake(costs: Costs) {
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const ok = (output: unknown, cost = 0): QueryOutcome<unknown> => ({
      ok: true,
      output,
      raw: meta(cost),
    });
    switch (req.role) {
      case "triage":
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
          costs.triage,
        );
      case "reviewer":
        if (costs.reviewerFails) throw new Error("the reviewer is down");
        return ok({ findings: costs.finding ? [NEAR] : [] });
      case "verifier":
        return ok({
          in_scope: true,
          claim_holds: true,
          introduced_by_pr: true,
          quotes: ["total += values[i]"],
          rationale: "r",
          score: 95,
          severity: "blocking",
        });
      case "judge":
        return ok({ same_issue: "yes", reason: "r" }, costs.judge ?? 0);
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
}

async function evalWith(
  cases: string,
  out: string,
  client: ReturnType<typeof fake>,
  ...extra: string[]
) {
  output.stdout = "";
  output.stderr = "";
  return exitCodeOf(
    createProgram({ client }).parseAsync([
      "node",
      "pr-review",
      "eval",
      "--cases",
      cases,
      "--out",
      out,
      "--reviewers",
      "diff-bugs",
      "--passes",
      "diff-bugs=1",
      "--no-extras",
      "--format",
      "json",
      ...extra,
    ]),
  );
}

const triageCalls = (client: ReturnType<typeof fake>) =>
  client.calls.filter((c) => c.role === "triage").length;

describe("pr-review eval --max-cost (R3)", () => {
  it("stops before a new repeat at the limit, keeps the finished results, and exits 4", async () => {
    const out = tempDir("max-cost-out", made);
    const client = fake({ triage: 1 });
    const code = await evalWith(plain, out, client, "--repeat", "3", "--max-cost", "1.5");
    expect(code, output.stderr).toBe(EXIT_STOPPED);
    expect(EXIT_STOPPED).toBe(4);
    // Repeat 2 starts at $1, below the limit; repeat 3 would start at $2.
    expect(triageCalls(client)).toBe(2);
    expect(existsSync(join(out, "case-a", "1", "result.json"))).toBe(true);
    expect(existsSync(join(out, "case-a", "2", "result.json"))).toBe(true);
    expect(existsSync(join(out, "case-a", "3"))).toBe(false);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Report;
    expect(report.cases[0]?.repeats.map((r) => r.repeat)).toEqual([1, 2]);
    expect(output.stderr).toMatch(/limit/);
    expect(output.stderr).toContain("$2.0000");
    expect(output.stderr).toContain("$1.5000");
    expect(output.stderr).toMatch(/1 repeat remains/);
  }, 120_000);

  it("runs only the rest with --resume", async () => {
    const out = tempDir("max-cost-resume", made);
    await evalWith(plain, out, fake({ triage: 1 }), "--repeat", "3", "--max-cost", "1.5");
    const client = fake({ triage: 1 });
    const code = await evalWith(plain, out, client, "--repeat", "3", "--resume");
    expect(code, output.stderr).toBe(0);
    expect(triageCalls(client)).toBe(1);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Report;
    expect(report.cases[0]?.repeats.map((r) => r.repeat)).toEqual([1, 2, 3]);
  }, 120_000);

  it("counts the judge queries of a repeat in its cost", async () => {
    const out = tempDir("max-cost-judge", made);
    // The run costs $0.50 and the judge $0.50, so repeat 2 would start at $1.
    const client = fake({ triage: 0.5, judge: 0.5, finding: true });
    const code = await evalWith(judged, out, client, "--repeat", "2", "--max-cost", "0.9");
    expect(code, output.stderr).toBe(EXIT_STOPPED);
    expect(client.calls.filter((c) => c.role === "judge")).toHaveLength(1);
    expect(triageCalls(client)).toBe(1);
  }, 120_000);

  it("exits 1 when a repeat failed, also when the limit stopped the eval", async () => {
    const out = tempDir("max-cost-failed", made);
    const client = fake({ triage: 1, reviewerFails: true });
    const code = await evalWith(plain, out, client, "--repeat", "3", "--max-cost", "1.5");
    expect(code).toBe(1);
    // A failed repeat still costs its queries.
    expect(triageCalls(client)).toBe(2);
    expect(output.stderr).toMatch(/1 repeat remains/);
  }, 120_000);

  it("states the bound of the spend in the help text", () => {
    const evalCommand = createProgram({}).commands.find((c) => c.name() === "eval");
    const help = evalCommand?.helpInformation() ?? "";
    // The help text wraps its lines, so any space can be a line break.
    expect(help).toMatch(/--max-cost <usd>[\s\S]*at\s+most\s+one\s+repeat/);
  });
});
