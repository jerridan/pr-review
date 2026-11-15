// D4c S4 and R6b: pr-review eval --models sets the model and the effort of
// the reviewers of a run, and each query entry of the record holds the
// effort of its call.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import { isRecordFileName } from "../src/record/write.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import {
  captured,
  captureOutput,
  casesFrom,
  cleanup,
  exitCodeOf,
  makeTemplate,
  output,
  tempDir,
} from "./fixtures/eval-fixture.js";

const run = promisify(execFile);
const FIXTURE_SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

const made: string[] = [];
afterAll(() => cleanup(made));
captureOutput();

// The repo config of the case: the verifier and the escalation get their
// own effort, and the tests reviewer gets a model and an effort that
// --models replaces.
const CONFIG = [
  "models:",
  "  verifier:",
  "    effort: medium",
  "  verifier-escalation:",
  "    effort: low",
  "reviewers:",
  "  tests:",
  "    model: opus",
  "    effort: high",
  "",
].join("\n");

let cases = "";
beforeAll(async () => {
  const root = tempDir("models", made);
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
  cases = casesFrom(template, join(root, "cases"), [{ name: "case-a", golden: [] }]);
}, 60_000);

const meta = (costUsd = 0.01): QueryMeta => ({
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd,
});

// The planted bug of the fixture. diff-bugs gives it on each pass.
const PLANTED = {
  file: "src/stats.ts",
  start_line: 11,
  end_line: 11,
  category: "bug",
  severity_estimate: "blocking",
  confidence: "high",
  claim: "The loop reads one element past the end.",
  evidence: "for (let i = 0; i <= values.length; i++) {",
  explanation: "e",
  needs_context: false,
};

// The first verifier gives a score in the middle band, so the finding
// escalates. The escalation confirms it.
function fake() {
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const ok = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: meta() });
    const verdict = (score: number) =>
      ok({
        in_scope: true,
        claim_holds: true,
        introduced_by_pr: true,
        quotes: ["i <= values.length"],
        rationale: "r",
        score,
        severity: "blocking",
      });
    switch (req.role) {
      case "triage":
        return ok({
          tier: "full",
          reason: "r",
          confidence: "high",
          categories: ["bug"],
          hotspots: [],
          file_notes: [],
          summary: "s",
        });
      case "reviewer":
        return ok({ findings: req.reviewerName === "diff-bugs" ? [PLANTED] : [] });
      case "verifier":
        return verdict(70);
      case "verifier-escalation":
        return verdict(95);
      case "judge":
        return ok({ same_issue: "no", reason: "r" });
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
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
      "--reviewers",
      "diff-bugs,tests",
      "--passes",
      "diff-bugs=2",
      "--no-extras",
      ...extra,
    ]),
  );
}

function recordsUnder(dir: string): RunRecord[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return recordsUnder(full);
    if (!isRecordFileName(name)) return [];
    return [JSON.parse(readFileSync(full, "utf8")) as RunRecord];
  });
}

// diff-bugs gets its own value. tests gets the value of "all", over the
// repo config.
const MODELS = "all=haiku:medium,diff-bugs=opus:max";

describe("pr-review eval --models (S4)", () => {
  let record: RunRecord | undefined;
  let client: ReturnType<typeof fake>;
  beforeAll(async () => {
    const out = tempDir("models-out", made);
    client = fake();
    const code = await captured(() => evalWith(out, client, "--models", MODELS));
    if (code !== 0) throw new Error(`the eval exited ${code}: ${output.stderr}`);
    [record] = recordsUnder(out);
  }, 120_000);

  it("gives the record the model and the effort of the option for each reviewer", () => {
    const selected = record?.identity.selected_reviewers.map((r) => [r.name, r.model, r.effort]);
    expect(selected?.sort()).toEqual([
      ["diff-bugs", "claude-opus-5-5", "max"],
      ["tests", "claude-haiku-5-5", "medium"],
    ]);
  });

  it("sends each reviewer query with the model and the effort of the option", () => {
    const sent = client.calls
      .filter((c) => c.role === "reviewer")
      .map((c) => [c.reviewerName, c.overrides?.model, c.overrides?.effort]);
    expect(sent.sort()).toEqual([
      ["diff-bugs", "claude-opus-5-5", "max"],
      ["diff-bugs", "claude-opus-5-5", "max"],
      ["tests", "claude-haiku-5-5", "medium"],
    ]);
  });

  it("does not change the verifier, the escalation or triage", () => {
    const efforts = client.calls
      .filter((c) => c.role !== "reviewer")
      .map((c) => [c.role, c.overrides?.model, c.overrides?.effort]);
    expect(efforts).toContainEqual(["verifier", undefined, "medium"]);
    expect(efforts).toContainEqual(["verifier-escalation", undefined, "low"]);
    expect(efforts).toContainEqual(["triage", undefined, undefined]);
  });

  it("gives each query entry of the record the effort of its call (R6b)", () => {
    const entries = record?.cost.queries.map((q) => [q.role, q.reviewer ?? null, q.effort]);
    expect(entries?.sort()).toEqual([
      ["reviewer", "diff-bugs", "max"],
      ["reviewer", "diff-bugs", "max"],
      ["reviewer", "tests", "medium"],
      ["triage", null, "medium"],
      ["verifier", null, "medium"],
      ["verifier-escalation", null, "low"],
    ]);
  });

  it("still parses a record whose query entries have no effort (0.13.0)", () => {
    const old = JSON.parse(JSON.stringify(record)) as { cost: { queries: object[] } };
    for (const q of old.cost.queries) delete (q as { effort?: string }).effort;
    expect(RecordSchema.safeParse(old).success).toBe(true);
  });
});

describe("pr-review eval --models: resume and the judge", () => {
  it("refuses to resume a run with other --models", async () => {
    const out = tempDir("models-resume", made);
    expect(await evalWith(out, fake(), "--models", "tests=haiku:low")).toBe(0);
    const client = fake();
    const code = await evalWith(out, client, "--models", "tests=haiku:high", "--resume");
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/other options/);
    expect(client.calls).toEqual([]);
  }, 120_000);

  it("reads a result file with no models field as a run with no option", async () => {
    const out = tempDir("models-old", made);
    expect(await evalWith(out, fake())).toBe(0);
    const path = join(out, "case-a", "1", "result.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { options: Record<string, unknown> };
    delete file.options.models;
    writeFileSync(path, JSON.stringify(file));
    const client = fake();
    expect(await evalWith(out, client, "--resume")).toBe(0);
    expect(client.calls).toEqual([]);
  }, 120_000);

  it("exits 2 when the option gives a reviewer the judge model, with no model call", async () => {
    const client = fake();
    const code = await evalWith(
      tempDir("models-judge", made),
      client,
      "--models",
      "tests=sonnet:low",
    );
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/tests use the judge model claude-sonnet-5-5/);
    expect(client.calls).toEqual([]);
  }, 120_000);

  it("runs a reviewer with the judge model when --allow-same-judge is given", async () => {
    const out = tempDir("models-allow", made);
    const code = await evalWith(out, fake(), "--models", "tests=sonnet:low", "--allow-same-judge");
    expect(code, output.stderr).toBe(0);
    const tests = recordsUnder(out)[0]?.identity.selected_reviewers.find((r) => r.name === "tests");
    expect(tests).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
  }, 120_000);
});

describe("pr-review eval --models: usage errors", () => {
  const usage: [string, string[], RegExp][] = [
    ["an unknown reviewer", ["--models", "nope=opus:low"], /unknown reviewer nope/],
    ["an unknown model alias", ["--models", "tests=gpt:low"], /Unknown model "gpt"/],
    ["an unknown effort", ["--models", "tests=opus:huge"], /effort "huge"/],
    ["a pair with no effort", ["--models", "tests=opus"], /"tests=opus"/],
    [
      "--models with --baseline",
      ["--models", "tests=opus:low", "--baseline", "b.json"],
      /not comparable to the baseline/,
    ],
    [
      "--models with --write-baseline",
      ["--models", "tests=opus:low", "--write-baseline", "--baseline", "b.json"],
      /not comparable to the baseline/,
    ],
  ];
  for (const [what, flags, message] of usage) {
    it(`exits 2 for ${what}, with no model call`, async () => {
      const client = fake();
      const code = await evalWith(tempDir("models-usage", made), client, ...flags);
      expect(code).toBe(2);
      expect(output.stderr).toMatch(message);
      expect(client.calls).toEqual([]);
    }, 60_000);
  }
});
