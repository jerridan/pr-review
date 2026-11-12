// R2: "pr-review adjudicate" through the CLI entry, with a fake SDK client
// and a fake codex on PATH.
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  captureOutput,
  cli,
  codexCalls,
  fakeClient,
  installCodex,
  makeFixtureCase,
  RECORD_FIXTURE,
  type FixtureCase,
  type Plan,
} from "./fixtures/pool-fakes.js";

const CASE = "fixture-7";

let work = "";
let fx: FixtureCase;
let count = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pr-review-pool-adjudicate-"));
  fx = await makeFixtureCase(work, CASE);
}, 60_000);

afterAll(() => {
  for (const dir of [fx?.repo, work]) if (dir) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

function setup(plan: Plan) {
  count += 1;
  const root = join(work, `run-${count}`);
  mkdirSync(root);
  const caseDir = join(root, CASE);
  cpSync(fx.template, caseDir, { recursive: true });
  const codexDir = join(root, "codex");
  installCodex(codexDir, plan);
  return { root, caseDir, codexDir, client: fakeClient(plan), io: captureOutput() };
}

const P1_FINDING = {
  file: "src/stats.ts",
  start_line: 11,
  end_line: 11,
  category: "bug",
  claim: "MARK-P1 The loop reads one element past the end of the list.",
  evidence: "for (let i = 0; i <= values.length; i++) {",
};

function scores(claude: number, gpt: number): Plan {
  return {
    claude: { "MARK-P1": { score: claude, start_line: 11, end_line: 11 } },
    gpt: { "MARK-P1": { score: gpt, start_line: 10, end_line: 12 } },
  };
}

describe("pr-review adjudicate --record --fingerprint", () => {
  it("prints the finding, both results and kept for 75 and 75", async () => {
    const s = setup(scores(75, 75));
    const code = await cli(
      s.client,
      "adjudicate",
      s.caseDir,
      "--record",
      RECORD_FIXTURE,
      "--fingerprint",
      "fp-7f3a9c",
    );
    expect(code).toBe(0);
    expect(JSON.parse(s.io.stdout())).toEqual({
      finding: P1_FINDING,
      claude: { score: 75, reason: "fake reason", start_line: 11, end_line: 11 },
      gpt: { score: 75, reason: "fake reason", start_line: 10, end_line: 12 },
      kept: true,
    });
  }, 60_000);

  it("does not keep a finding scored 75 and 74", async () => {
    const s = setup(scores(75, 74));
    await cli(
      s.client,
      "adjudicate",
      s.caseDir,
      "--record",
      RECORD_FIXTURE,
      "--fingerprint",
      "fp-7f3a9c",
    );
    expect(JSON.parse(s.io.stdout())).toMatchObject({ kept: false });
  }, 60_000);

  it("finds a fingerprint in stages.capped", async () => {
    const s = setup({});
    await cli(
      s.client,
      "adjudicate",
      s.caseDir,
      "--record",
      RECORD_FIXTURE,
      "--fingerprint",
      "fp-capped-5d1e",
    );
    expect(JSON.parse(s.io.stdout())).toMatchObject({
      finding: { claim: "MARK-C1 The sum can overflow for large values.", start_line: 12 },
    });
  }, 60_000);

  it("sends neither family a record-only field of the finding", async () => {
    const s = setup(scores(80, 80));
    await cli(
      s.client,
      "adjudicate",
      s.caseDir,
      "--record",
      RECORD_FIXTURE,
      "--fingerprint",
      "fp-7f3a9c",
    );
    const sdk = s.client.calls;
    const gpt = codexCalls(s.codexDir);
    expect(sdk).toHaveLength(1);
    expect(gpt).toHaveLength(1);
    const texts = [
      ...sdk.map((c) => `${c.systemPrompt}\n${c.userMessage}`),
      ...gpt.map((c) => c.argv.at(-1) ?? ""),
    ];
    for (const text of texts) {
      expect(text).toContain("MARK-P1");
      for (const secret of [
        "fp-7f3a9c",
        "VERIFIER-SECRET",
        "SPAN-SECRET",
        "RECORD-SECRET",
        "diff-bugs",
      ]) {
        expect(text).not.toContain(secret);
      }
      // The verifier score of the finding is 63; the fixture diff holds no 63.
      expect(text).not.toMatch(/\b63\b/);
      expect(text).not.toMatch(/severity_estimate|confidence/);
    }
  }, 60_000);

  it("exits non-zero, with no model call, for an unknown fingerprint", async () => {
    const s = setup({});
    const code = await cli(
      s.client,
      "adjudicate",
      s.caseDir,
      "--record",
      RECORD_FIXTURE,
      "--fingerprint",
      "fp-none",
    );
    expect(code).not.toBe(0);
    expect(s.io.stderr()).toContain("fp-none");
    expect(s.client.calls).toHaveLength(0);
    expect(codexCalls(s.codexDir)).toHaveLength(0);
  }, 60_000);

  it("sends codex the read-only sandbox, the pinned model and an output schema", async () => {
    const s = setup(scores(80, 80));
    await cli(
      s.client,
      "adjudicate",
      s.caseDir,
      "--record",
      RECORD_FIXTURE,
      "--fingerprint",
      "fp-7f3a9c",
    );
    const [only] = codexCalls(s.codexDir);
    if (!only) throw new Error("codex did not run");
    const a = only.argv;
    const schema = a[a.indexOf("--output-schema") + 1] ?? "";
    const out = a[a.indexOf("-o") + 1] ?? "";
    expect(a).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-C",
      s.client.calls[0]?.cwd,
      "-s",
      "read-only",
      "-m",
      "gpt-6.1-sol",
      "-c",
      "model_reasoning_effort=high",
      "--output-schema",
      schema,
      "-o",
      out,
      a.at(-1),
    ]);
    expect(only.schemaExists).toBe(true);
  }, 60_000);
});

describe("pr-review adjudicate --finding", () => {
  it("reads a finding file without evidence and writes the result to --out", async () => {
    const s = setup(scores(90, 76));
    const { evidence: _e, ...noEvidence } = P1_FINDING;
    const path = join(s.root, "finding.json");
    writeFileSync(path, JSON.stringify(noEvidence));
    const out = join(s.root, "result.json");
    const code = await cli(s.client, "adjudicate", s.caseDir, "--finding", path, "--out", out);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      finding: { ...noEvidence, evidence: "" },
      kept: true,
    });
  }, 60_000);

  it("reports a failed call as failed, not as a score, and does not keep the finding", async () => {
    const s = setup({
      claude: { "MARK-P1": "fail" },
      gpt: { "MARK-P1": { score: 99, start_line: 11, end_line: 11 } },
    });
    const path = join(s.root, "finding.json");
    writeFileSync(path, JSON.stringify(P1_FINDING));
    const code = await cli(s.client, "adjudicate", s.caseDir, "--finding", path);
    expect(code).toBe(1);
    const result = JSON.parse(s.io.stdout()) as { claude: object; kept: boolean };
    expect(result.claude).toHaveProperty("failed");
    expect(result.claude).not.toHaveProperty("score");
    expect(result.kept).toBe(false);
  }, 60_000);

  it("exits 2 when the finding file lacks a field", async () => {
    const s = setup({});
    const path = join(s.root, "finding.json");
    writeFileSync(path, JSON.stringify({ file: "src/stats.ts", claim: "x" }));
    expect(await cli(s.client, "adjudicate", s.caseDir, "--finding", path)).toBe(2);
    expect(s.client.calls).toHaveLength(0);
  });

  it("exits 2 with both --finding and --record, or with neither", async () => {
    const s = setup({});
    const path = join(s.root, "finding.json");
    writeFileSync(path, JSON.stringify(P1_FINDING));
    expect(
      await cli(
        s.client,
        "adjudicate",
        s.caseDir,
        "--finding",
        path,
        "--record",
        RECORD_FIXTURE,
        "--fingerprint",
        "fp-7f3a9c",
      ),
    ).toBe(2);
    expect(await cli(s.client, "adjudicate", s.caseDir)).toBe(2);
    expect(await cli(s.client, "adjudicate", s.caseDir, "--record", RECORD_FIXTURE)).toBe(2);
  });
});
