// R4.5: a case with description_from "commits" gives the run no description.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import { isRecordFileName } from "../src/record/write.js";
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
  const root = tempDir("description-from", made);
  const template = await makeTemplate(fx, root);
  cases = casesFrom(template, join(root, "cases"), [
    { name: "plain", golden: [] },
    { name: "from-commits", golden: [] },
  ]);
  for (const name of ["plain", "from-commits"]) {
    const file = join(cases, name, "case.json");
    const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    meta.title = "CASE-TITLE-XYZ";
    meta.body = "CASE-BODY-XYZ";
    if (name === "from-commits") meta.description_from = "commits";
    writeFileSync(file, JSON.stringify(meta));
  }
}, 60_000);

function fake() {
  const raw = {
    model: "m",
    durationMs: 1,
    stopReason: "end_turn",
    subtype: "success",
    usage: {},
    costUsd: 0.01,
  };
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
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

function recordsUnder(dir: string): RunRecord[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return recordsUnder(full);
    return isRecordFileName(name) ? [JSON.parse(readFileSync(full, "utf8")) as RunRecord] : [];
  });
}

describe("description_from in an eval repeat", () => {
  it("gives the run no description for commits, and the title and body otherwise", async () => {
    const out = tempDir("description-from-out", made);
    const client = fake();
    const code = await exitCodeOf(
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
        "--reviewers",
        "diff-bugs",
      ]),
    );
    expect(code, output.stderr).toBe(0);
    const [plain] = recordsUnder(join(out, "plain"));
    const [commits] = recordsUnder(join(out, "from-commits"));
    expect(plain?.identity.description).toContain("CASE-TITLE-XYZ");
    expect(plain?.identity.description).toContain("CASE-BODY-XYZ");
    expect(commits?.identity.description_meta.source).toBe("commits");
    expect(commits?.identity.description).not.toContain("CASE-TITLE-XYZ");
    expect(commits?.identity.description).not.toContain("CASE-BODY-XYZ");
    expect(commits?.identity.description.trim()).not.toBe("");
  }, 120_000);
});
