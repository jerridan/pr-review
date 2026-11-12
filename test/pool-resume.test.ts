// R5: "pr-review pool --resume" through the CLI entry, with a fake SDK
// client and a fake codex on PATH.
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
  type Item,
  type Plan,
  type Verdict,
} from "./fixtures/pool-fakes.js";

const CASE = "fixture-7";
const FILES = ["reviews.json", "pool.json", "pool-key.json", "adjudications.json"];

let work = "";
let fx: FixtureCase;
let count = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pr-review-pool-resume-"));
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

const K1: Item = {
  file: "src/stats.ts",
  start_line: 11,
  end_line: 11,
  category: "bug",
  claim: "MARK-K1 The code at this line is wrong.",
  evidence: "evidence of MARK-K1",
};

const at = (start: number): Verdict => ({ score: 80, start_line: start, end_line: start });
const VERDICTS: Record<string, Verdict> = {
  "MARK-K1": at(11),
  "MARK-R1": at(14),
  "MARK-R2": at(13),
};
const FAILING: Record<string, Verdict> = {
  "MARK-K1": "fail",
  "MARK-R1": "fail",
  "MARK-R2": "fail",
};

function plan(gptFails: boolean): Plan {
  return {
    claudeReviews: [[K1]],
    gptReviews: [[]],
    claude: VERDICTS,
    gpt: gptFails ? FAILING : VERDICTS,
  };
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function prepare() {
  count += 1;
  const root = join(work, `run-${count}`);
  mkdirSync(root);
  const caseDir = join(root, "cases", CASE);
  cpSync(fx.template, caseDir, { recursive: true });
  return { root, caseDir, out: join(root, "out") };
}

type Prepared = ReturnType<typeof prepare>;

// One pool run in "p" with its own fakes. "record" is the record file.
async function run(p: Prepared, gptFails: boolean, flags: string[] = [], record = RECORD_FIXTURE) {
  const codexDir = join(p.root, `codex-${++count}`);
  installCodex(codexDir, plan(gptFails));
  const client = fakeClient(plan(gptFails));
  const io = captureOutput();
  const code = await cli(
    client,
    "pool",
    p.caseDir,
    "--out",
    p.out,
    "--reviews",
    "1",
    "--write-golden",
    "--record",
    record,
    ...flags,
  );
  const roles = (role: string) => client.calls.filter((c) => c.role === role);
  const gpt = codexCalls(codexDir);
  vi.unstubAllEnvs();
  return { code, client, roles, gpt, io };
}

describe("pr-review pool --resume", () => {
  it("makes no Claude call that succeeded before, makes the missing GPT calls, and writes the goldens", async () => {
    const p = prepare();
    const first = await run(p, true);
    expect(first.code).toBe(1);
    expect(existsSync(join(p.caseDir, "golden.json"))).toBe(false);

    const second = await run(p, false, ["--resume"]);
    expect(second.code).toBe(0);
    expect(second.roles("pool-reviewer")).toHaveLength(0);
    expect(second.roles("pool-grouper")).toHaveLength(0);
    expect(second.roles("adjudicator")).toHaveLength(0);
    expect(second.gpt.filter((c) => c.kind === "review")).toHaveLength(0);
    expect(second.gpt.filter((c) => c.kind === "adjudicate")).toHaveLength(3);
    const golden = JSON.parse(readText(join(p.caseDir, "golden.json"))) as { findings: unknown[] };
    expect(golden.findings).toHaveLength(3);
    expect(second.io.stdout()).toMatch(/fixture-7: resume 6 reused, 3 new/);
  }, 120_000);

  it("writes the files that one run with no failure writes", async () => {
    const resumed = prepare();
    await run(resumed, true);
    await run(resumed, false, ["--resume"]);
    const clean = prepare();
    const result = await run(clean, false);
    expect(result.code).toBe(0);
    for (const name of FILES) {
      expect(readText(join(resumed.out, CASE, name))).toBe(readText(join(clean.out, CASE, name)));
    }
    expect(readText(join(resumed.caseDir, "golden.json"))).toBe(
      readText(join(clean.caseDir, "golden.json")),
    );
  }, 120_000);

  it("makes every call without --resume", async () => {
    const p = prepare();
    await run(p, true);
    const second = await run(p, false);
    expect(second.code).toBe(0);
    expect(second.roles("pool-reviewer")).toHaveLength(1);
    expect(second.roles("adjudicator")).toHaveLength(3);
    expect(second.gpt.filter((c) => c.kind === "review")).toHaveLength(1);
    expect(second.io.stdout()).not.toContain("resume");
  }, 120_000);

  it("does not reuse a result for an item whose text changed", async () => {
    const p = prepare();
    await run(p, true);
    const record = JSON.parse(readText(RECORD_FIXTURE)) as {
      stages: { reviewers: { findings: { claim: string }[] }[] };
    };
    const finding = record.stages.reviewers[0]?.findings[0];
    if (finding) finding.claim = "MARK-R1 The text of this finding changed.";
    const changed = join(p.root, "changed.json");
    writeFileSync(changed, JSON.stringify(record));

    const second = await run(p, false, ["--resume"], changed);
    expect(second.code).toBe(0);
    const asked = second.roles("adjudicator");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.userMessage).toContain("The text of this finding changed.");
    expect(second.roles("pool-reviewer")).toHaveLength(0);
  }, 120_000);
});

type Calls = {
  group: Record<string, unknown>;
  adjudication: Record<string, { score: number }>;
};

function editCalls(p: Prepared, change: (calls: Calls) => void): void {
  const path = join(p.out, CASE, "calls.json");
  const calls = JSON.parse(readText(path)) as Calls;
  change(calls);
  writeFileSync(path, JSON.stringify(calls));
}

describe("pr-review pool --resume, a kept result that is not good", () => {
  it("counts a kept adjudication with a score out of range as a new call", async () => {
    const p = prepare();
    await run(p, false);
    editCalls(p, (calls) => {
      const key = Object.keys(calls.adjudication).find((k) => k.includes("claude"));
      const kept = calls.adjudication[key ?? ""];
      if (kept) kept.score = 150;
    });
    const second = await run(p, false, ["--resume"]);
    expect(second.code).toBe(0);
    expect(second.roles("adjudicator")).toHaveLength(1);
    expect(second.io.stdout()).toMatch(/fixture-7: resume 8 reused, 1 new/);
  }, 120_000);

  it("makes the grouping call again for a kept answer that puts a finding in two groups", async () => {
    const p = prepare();
    await run(p, false);
    editCalls(p, (calls) => {
      const key = Object.keys(calls.group)[0] ?? "";
      calls.group[key] = [
        { members: [0, 1], representative: 0 },
        { members: [1, 2], representative: 1 },
      ];
    });
    const second = await run(p, false, ["--resume"]);
    expect(second.code).toBe(0);
    expect(second.roles("pool-grouper")).toHaveLength(1);
    expect(second.io.stdout()).toMatch(/fixture-7: resume 8 reused, 1 new/);
  }, 120_000);

  it("makes the grouping call again for a kept answer with an index out of range", async () => {
    const p = prepare();
    await run(p, false);
    editCalls(p, (calls) => {
      const key = Object.keys(calls.group)[0] ?? "";
      calls.group[key] = [{ members: [0, 1, 2, 9], representative: 0 }];
    });
    const second = await run(p, false, ["--resume"]);
    expect(second.roles("pool-grouper")).toHaveLength(1);
  }, 120_000);

  it("warns on stderr, and makes every call, when calls.json is not JSON", async () => {
    const p = prepare();
    await run(p, false);
    writeFileSync(join(p.out, CASE, "calls.json"), "{not json");
    const second = await run(p, false, ["--resume"]);
    expect(second.code).toBe(0);
    expect(second.io.stderr()).toMatch(/calls\.json/);
    expect(second.roles("adjudicator")).toHaveLength(3);
    expect(second.io.stdout()).toMatch(/resume 0 reused, 9 new/);
  }, 120_000);

  it("ignores a calls.json written for another case head", async () => {
    const p = prepare();
    await run(p, false);
    const path = join(p.out, CASE, "calls.json");
    const calls = JSON.parse(readText(path)) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...calls, head: "f".repeat(40) }));
    const second = await run(p, false, ["--resume"]);
    expect(second.code).toBe(0);
    expect(second.roles("pool-reviewer")).toHaveLength(1);
    expect(second.roles("adjudicator")).toHaveLength(3);
    expect(second.io.stdout()).toMatch(/resume 0 reused, 9 new/);
  }, 120_000);
});
