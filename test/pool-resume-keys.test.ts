// R5: a kept result is for the same prompt. A changed prompt file makes a
// new call. The prompt text comes from a mock of the prompt loader, and each
// run loads the pool modules again, because the pool caches prompt files.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  makeFixtureCase,
  RECORD_FIXTURE,
  type FixtureCase,
  type Item,
} from "./fixtures/pool-fakes.js";

const CASE = "fixture-7";
const prompts = vi.hoisted(() => ({ file: "", suffix: "" }));

vi.mock("../src/prompts/load.js", async (original) => {
  const real = await original<typeof import("../src/prompts/load.js")>();
  return {
    ...real,
    loadPrompt: (path: string) => {
      const loaded = real.loadPrompt(path);
      return path === prompts.file ? { ...loaded, body: loaded.body + prompts.suffix } : loaded;
    },
  };
});

let work = "";
let fx: FixtureCase;
let count = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pr-review-pool-keys-"));
  fx = await makeFixtureCase(work, CASE);
}, 60_000);

afterAll(() => {
  for (const dir of [fx?.repo, work]) if (dir) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  prompts.file = "";
  prompts.suffix = "";
});

const K1: Item = {
  file: "src/stats.ts",
  start_line: 11,
  end_line: 11,
  category: "bug",
  claim: "MARK-K1 The code at this line is wrong.",
  evidence: "evidence of MARK-K1",
};
const verdicts = {
  "MARK-K1": { score: 80, start_line: 11, end_line: 11 },
  "MARK-R1": { score: 80, start_line: 14, end_line: 14 },
  "MARK-R2": { score: 80, start_line: 13, end_line: 13 },
};

async function poolRun(root: string, out: string, flags: string[]) {
  vi.resetModules();
  const fakes = await import("./fixtures/pool-fakes.js");
  const plan = { claudeReviews: [[K1]], gptReviews: [[]], claude: verdicts, gpt: verdicts };
  const codexDir = join(root, `codex-${++count}`);
  fakes.installCodex(codexDir, plan);
  const client = fakes.fakeClient(plan);
  fakes.captureOutput();
  const caseDir = join(root, "cases", CASE);
  const code = await fakes.cli(
    client,
    "pool",
    caseDir,
    "--out",
    out,
    "--reviews",
    "1",
    "--record",
    RECORD_FIXTURE,
    ...flags,
  );
  vi.unstubAllEnvs();
  return { code, count: (role: string) => client.calls.filter((c) => c.role === role).length };
}

describe("pr-review pool --resume, a changed prompt", () => {
  it.each([
    ["pool-review.md", { review: 1, grouper: 0, adjudicator: 0 }],
    ["pool-group.md", { review: 0, grouper: 1, adjudicator: 0 }],
    ["pool-adjudicate.md", { review: 0, grouper: 0, adjudicator: 3 }],
  ])(
    "makes the calls of %s again, and no other Claude call",
    async (file, expected) => {
      count += 1;
      const root = join(work, `run-${count}`);
      mkdirSync(root);
      cpSync(fx.template, join(root, "cases", CASE), { recursive: true });
      const out = join(root, "out");
      expect((await poolRun(root, out, [])).code).toBe(0);

      prompts.file = file;
      prompts.suffix = "\nA new sentence of the prompt.";
      const second = await poolRun(root, out, ["--resume"]);
      expect(second.code).toBe(0);
      expect(second.count("pool-reviewer")).toBe(expected.review);
      expect(second.count("pool-grouper")).toBe(expected.grouper);
      expect(second.count("adjudicator")).toBe(expected.adjudicator);
    },
    120_000,
  );
});
