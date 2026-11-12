// R1: "pr-review pool" through the CLI entry, with a fake SDK client and a
// fake codex on PATH.
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
import { loadPrompt } from "../src/prompts/load.js";
import {
  allInOne,
  byTag,
  captureOutput,
  cli,
  CODEX_BANNER,
  CODEX_ERROR,
  codexCalls,
  failGrouping,
  fakeClient,
  installCodex,
  makeFixtureCase,
  RECORD_FIXTURE,
  type FixtureCase,
  type Item,
  type Plan,
} from "./fixtures/pool-fakes.js";

const CASE = "fixture-7";
const SIX = ["file", "start_line", "end_line", "category", "claim", "evidence"];

let work = "";
let fx: FixtureCase;
let count = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pr-review-pool-cli-"));
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

function item(marker: string, start: number, end = start, over: Partial<Item> = {}): Item {
  return {
    file: "src/stats.ts",
    start_line: start,
    end_line: end,
    category: "bug",
    claim: `${marker} The code at this line is wrong.`,
    evidence: `evidence of ${marker}`,
    ...over,
  };
}

type Setup = {
  caseDir: string;
  out: string;
  codexDir: string;
  client: ReturnType<typeof fakeClient>;
  io: ReturnType<typeof captureOutput>;
};

/** A new case directory, an out directory, and the fakes for "plan". */
function setup(plan: Plan): Setup {
  count += 1;
  const root = join(work, `run-${count}`);
  mkdirSync(root);
  const caseDir = join(root, "cases", CASE);
  cpSync(fx.template, caseDir, { recursive: true });
  const codexDir = join(root, "codex");
  installCodex(codexDir, plan);
  return {
    caseDir,
    out: join(root, "out"),
    codexDir,
    client: fakeClient(plan),
    io: captureOutput(),
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type PoolItem = Item & { id: string };
type KeyEntry = { members: (Item & { source: string })[] };
type Family =
  { score: number; reason: string; start_line: number; end_line: number } | { failed: string };
type Adjudication = { id: string; claude: Family; gpt: Family; kept: boolean; outcome: string };

// The main scenario. Each marker names one finding.
//   K1: kept (75 and 80).           N1: not kept (74 and 90).
//   F1: the Claude call fails.      I1: in both reviews, identical.
//   G1, G2: grouped by the model; G2 represents the group.
//   O1, O2: kept, their spans overlap; the second grouping joins them.
//   S1: kept, no valid span.        R1, R2: from the record.
//   R1: the Claude span is past the end of the file, so the GPT span wins.
const I1 = item("MARK-I1", 13);
const MAIN: Plan = {
  claudeReviews: [
    [
      item("MARK-K1", 11),
      item("MARK-F1", 12),
      I1,
      item("MARK-G1 GROUP-a", 2),
      item("MARK-O1", 3, 5),
      item("MARK-S1", 9),
    ],
  ],
  gptReviews: [
    [
      item("MARK-N1", 10),
      { ...I1, evidence: "other evidence" },
      item("MARK-G2 GROUP-a", 2, 3),
      item("MARK-O2", 4, 6),
    ],
  ],
  groupers: [byTag, allInOne],
  claude: {
    "MARK-K1": { score: 75, start_line: 11, end_line: 11 },
    "MARK-N1": { score: 74, start_line: 10, end_line: 10 },
    "MARK-F1": "fail",
    "MARK-O1": { score: 80, start_line: 3, end_line: 5 },
    "MARK-O2": { score: 90, start_line: 4, end_line: 6 },
    "MARK-S1": { score: 80, start_line: 100, end_line: 101 },
    "MARK-R1": { score: 90, start_line: 30, end_line: 30 },
  },
  gpt: {
    "MARK-K1": { score: 80, start_line: 11, end_line: 11 },
    "MARK-N1": { score: 90, start_line: 10, end_line: 10 },
    "MARK-F1": { score: 90, start_line: 12, end_line: 12 },
    "MARK-O1": { score: 80, start_line: 3, end_line: 5 },
    "MARK-O2": { score: 85, start_line: 4, end_line: 6 },
    "MARK-S1": { score: 80, start_line: 200, end_line: 200 },
    "MARK-R1": { score: 90, start_line: 14, end_line: 14 },
  },
};

const GOLDEN_BEFORE = JSON.stringify({
  findings: [
    {
      file: "src/stats.ts",
      start_line: 1,
      end_line: 1,
      category: "bug",
      severity: "nit",
      claim: "GOLDEN-SECRET claim of the old golden.",
    },
  ],
});

function markerOf(text: string): string {
  return /MARK-[A-Za-z0-9]+/.exec(text)?.[0] ?? "";
}

describe("pr-review pool, the main scenario", () => {
  let s: Setup;
  let code = 0;
  let pool: { items: PoolItem[] };
  let key: Record<string, KeyEntry>;
  let adj: { items: Adjudication[] };
  const byMarker = (m: string) => pool.items.find((i) => markerOf(i.claim) === m);
  const adjOf = (m: string) => adj.items.find((a) => a.id === byMarker(m)?.id);

  beforeAll(async () => {
    s = setup(MAIN);
    writeFileSync(join(s.caseDir, "golden.json"), GOLDEN_BEFORE);
    code = await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--record",
      RECORD_FIXTURE,
      "--reviews",
      "1",
    );
    pool = readJson(join(s.out, CASE, "pool.json"));
    key = readJson(join(s.out, CASE, "pool-key.json"));
    adj = readJson(join(s.out, CASE, "adjudications.json"));
  }, 60_000);

  it("exits 1, because one adjudication call failed", () => {
    expect(code).toBe(1);
  });

  it("writes pool.json with ids p01 up and the six fields only", () => {
    expect(Object.keys(pool)).toEqual(["items"]);
    expect(pool.items.map((i) => i.id)).toEqual(
      pool.items.map((_, n) => `p${String(n + 1).padStart(2, "0")}`),
    );
    for (const i of pool.items) expect(Object.keys(i).sort()).toEqual(["id", ...SIX].sort());
  });

  it("names no source, reviewer, model, severity or confidence in pool.json", () => {
    const text = readFileSync(join(s.out, CASE, "pool.json"), "utf8");
    for (const word of [
      "claude",
      "gpt",
      "record",
      "pool-record.json",
      "diff-bugs",
      "tests",
      "severity",
      "confidence",
      "score",
      "RECORD-SECRET",
    ]) {
      expect(text).not.toContain(word);
    }
  });

  it("joins two identical items with no model call, and groups G1 and G2 under G2", () => {
    const markers = pool.items.map((i) => markerOf(i.claim)).sort();
    expect(markers).toEqual(
      [
        "MARK-F1",
        "MARK-G2",
        "MARK-I1",
        "MARK-K1",
        "MARK-N1",
        "MARK-O1",
        "MARK-O2",
        "MARK-R1",
        "MARK-R2",
        "MARK-S1",
      ].sort(),
    );
    const i1 = byMarker("MARK-I1");
    expect(i1?.evidence).toBe(I1.evidence);
    expect(key[i1?.id ?? ""]?.members.map((m) => m.source).sort()).toEqual([
      "claude-review-1",
      "gpt-review-1",
    ]);
    const g = byMarker("MARK-G2");
    expect(key[g?.id ?? ""]?.members.map((m) => markerOf(m.claim)).sort()).toEqual([
      "MARK-G1",
      "MARK-G2",
    ]);
  });

  it("maps every id in pool-key.json back to its sources", () => {
    expect(Object.keys(key).sort()).toEqual(pool.items.map((i) => i.id).sort());
    expect(key[byMarker("MARK-K1")?.id ?? ""]?.members.map((m) => m.source)).toEqual([
      "claude-review-1",
    ]);
    expect(key[byMarker("MARK-N1")?.id ?? ""]?.members.map((m) => m.source)).toEqual([
      "gpt-review-1",
    ]);
    expect(key[byMarker("MARK-R1")?.id ?? ""]?.members.map((m) => m.source)).toEqual([
      "record:pool-record.json:diff-bugs",
    ]);
    expect(key[byMarker("MARK-R2")?.id ?? ""]?.members.map((m) => m.source)).toEqual([
      "record:pool-record.json:tests",
    ]);
  });

  it("does not order pool.json by source", () => {
    const sourceOrder = [
      "MARK-K1",
      "MARK-F1",
      "MARK-I1",
      "MARK-G2",
      "MARK-O1",
      "MARK-S1",
      "MARK-N1",
      "MARK-O2",
      "MARK-R1",
      "MARK-R2",
    ];
    expect(pool.items.map((i) => markerOf(i.claim))).not.toEqual(sourceOrder);
  });

  it("keeps an item scored 75 and 80, and not an item scored 74 and 90", () => {
    expect(adjOf("MARK-K1")).toMatchObject({
      kept: true,
      claude: { score: 75, start_line: 11, end_line: 11 },
      gpt: { score: 80 },
    });
    expect(adjOf("MARK-N1")).toMatchObject({
      kept: false,
      claude: { score: 74 },
      gpt: { score: 90 },
    });
  });

  it("keeps out an item whose adjudication call failed, and marks it failed", () => {
    const f1 = adjOf("MARK-F1");
    expect(f1?.kept).toBe(false);
    expect(f1?.outcome).toBe("failed");
    expect(f1?.claude).toHaveProperty("failed");
    expect(f1?.gpt).toMatchObject({ score: 90 });
  });

  it("reports a kept item with no valid span as no_span", () => {
    expect(adjOf("MARK-S1")).toMatchObject({ kept: true, outcome: "no_span" });
  });

  it("prints a summary line with the items, kept, failed and the cost", () => {
    expect(s.io.stdout()).toMatch(
      /fixture-7: 10 items, 5 kept, 1 failed, 3 goldens, 1 no_span, cost \$\d+\.\d{2}/,
    );
  });

  it("writes reviews.json with the findings of each blind review and the Claude cost", () => {
    expect(readJson(join(s.out, CASE, "reviews.json"))).toEqual({
      reviews: [
        { source: "claude-review-1", ok: true, findings: 6, cost_usd: 0.01 },
        { source: "gpt-review-1", ok: true, findings: 4 },
      ],
    });
  });

  it("gives the findings of each blind review in the summary line", () => {
    expect(s.io.stdout()).toMatch(/fixture-7: .*reviews claude 6, gpt 4\n/);
  });

  it("leaves an existing golden.json unchanged without --write-golden", () => {
    expect(readFileSync(join(s.caseDir, "golden.json"), "utf8")).toBe(GOLDEN_BEFORE);
  });

  it("sends the blind reviews no record text and no golden text", () => {
    const sdk = s.client.calls.filter((c) => c.role === "pool-reviewer");
    const gpt = codexCalls(s.codexDir).filter((c) => c.kind === "review");
    expect(sdk).toHaveLength(1);
    expect(gpt).toHaveLength(1);
    const texts = [
      ...sdk.map((c) => `${c.systemPrompt}\n${c.userMessage}`),
      ...gpt.map((c) => c.argv.at(-1) ?? ""),
    ];
    for (const text of texts) {
      for (const secret of ["MARK-R1", "MARK-R2", "RECORD-SECRET", "GOLDEN-SECRET", "diff-bugs"]) {
        expect(text).not.toContain(secret);
      }
      expect(text).toContain("Add an average helper");
      expect(text).toContain("This PR adds the average function.");
      expect(text).toContain("src/stats.ts");
    }
  });

  it("runs the blind reviews and the adjudications with read-only tools in the case checkout", () => {
    const reviewers = s.client.calls.filter((c) => c.role !== "pool-grouper");
    const checkout = reviewers[0]?.cwd ?? "";
    expect(checkout).not.toBe("");
    expect(reviewers.every((c) => c.cwd === checkout)).toBe(true);
    expect(checkout).not.toBe(s.caseDir);
    // The run removes its checkout at the end.
    expect(existsSync(checkout)).toBe(false);
  });

  it("sends codex the read-only sandbox, the pinned model and an output schema", () => {
    const calls = codexCalls(s.codexDir);
    expect(calls.map((c) => c.kind)).toContain("review");
    expect(calls.map((c) => c.kind)).toContain("adjudicate");
    for (const c of calls) {
      const a = c.argv;
      expect(a.slice(0, 4)).toEqual([
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
      ]);
      expect(a[a.indexOf("-s") + 1]).toBe("read-only");
      expect(a[a.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
      expect(a[a.indexOf("-c") + 1]).toBe("model_reasoning_effort=high");
      expect(c.schemaExists).toBe(true);
      expect(a[a.indexOf("-C") + 1]).toBe(s.client.calls[0]?.cwd);
    }
  });

  it("takes the text of every model request from the pool prompt files", () => {
    const files: Record<string, string> = {
      "pool-reviewer": "pool-review.md",
      "pool-grouper": "pool-group.md",
      adjudicator: "pool-adjudicate.md",
    };
    for (const c of s.client.calls) {
      expect(c.systemPrompt).toBe(loadPrompt(files[c.role] ?? "").body);
    }
    for (const c of codexCalls(s.codexDir)) {
      const file = c.kind === "review" ? "pool-review.md" : "pool-adjudicate.md";
      expect(c.argv.at(-1)?.startsWith(loadPrompt(file).body.trimEnd())).toBe(true);
    }
  });

  it("makes two grouping calls: the pool, then the overlapping kept items", () => {
    expect(s.client.calls.filter((c) => c.role === "pool-grouper")).toHaveLength(2);
  });
});

describe("pr-review pool --write-golden", () => {
  type Golden = { findings: Record<string, unknown>[] };

  it("writes one golden per kept item with a span, with severity unsure and both scores", async () => {
    // The plan of the main scenario, with no failed call.
    const s = setup({
      ...MAIN,
      claude: { ...MAIN.claude, "MARK-F1": { score: 10, start_line: 12, end_line: 12 } },
    });
    writeFileSync(join(s.caseDir, "golden.json"), GOLDEN_BEFORE);
    await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--record",
      RECORD_FIXTURE,
      "--reviews",
      "1",
      "--write-golden",
    );
    const golden = readJson<Golden>(join(s.caseDir, "golden.json"));
    const byClaim = (m: string) => golden.findings.find((f) => markerOf(String(f.claim)) === m);
    expect(golden.findings.map((f) => markerOf(String(f.claim))).sort()).toEqual([
      "MARK-K1",
      "MARK-O2",
      "MARK-R1",
    ]);
    for (const f of golden.findings) expect(f.severity).toBe("unsure");
    expect(byClaim("MARK-K1")).toMatchObject({
      file: "src/stats.ts",
      start_line: 11,
      end_line: 11,
      category: "bug",
    });
    expect(String(byClaim("MARK-K1")?.note)).toMatch(/75/);
    expect(String(byClaim("MARK-K1")?.note)).toMatch(/80/);
    // The Claude span of R1 is past the end of the file, so the GPT span is the golden span.
    expect(byClaim("MARK-R1")).toMatchObject({ start_line: 14, end_line: 14 });
    // O1 and O2 overlap and the grouping joins them: O2 has the higher lower score.
    expect(byClaim("MARK-O2")).toMatchObject({ start_line: 4, end_line: 6 });
  }, 60_000);

  it("writes an empty list, a clean case, when no item is kept", async () => {
    const s = setup({ claudeReviews: [[item("MARK-K1", 11)]], gptReviews: [[]] });
    writeFileSync(join(s.caseDir, "golden.json"), GOLDEN_BEFORE);
    const code = await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--reviews",
      "1",
      "--write-golden",
    );
    expect(code).toBe(0);
    expect(readJson(join(s.caseDir, "golden.json"))).toEqual({ findings: [] });
  }, 60_000);
});

describe("pr-review pool, the other paths", () => {
  it("joins two identical items into one pool item with no model call", async () => {
    const same = item("MARK-K1", 11);
    const s = setup({ claudeReviews: [[same]], gptReviews: [[{ ...same, category: "test" }]] });
    // The category differs, but file, lines and claim are identical.
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--reviews", "1");
    expect(code).toBe(0);
    const pool = readJson<{ items: PoolItem[] }>(join(s.out, CASE, "pool.json"));
    expect(pool.items).toHaveLength(1);
    expect(pool.items[0]?.category).toBe("bug");
    expect(s.client.calls.filter((c) => c.role === "pool-grouper")).toHaveLength(0);
  }, 60_000);

  it("exits non-zero and writes no pool when the grouping call fails", async () => {
    const s = setup({
      claudeReviews: [[item("MARK-K1", 11)]],
      gptReviews: [[item("MARK-N1", 10)]],
      groupers: [failGrouping, failGrouping],
    });
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--reviews", "1");
    expect(code).not.toBe(0);
    expect(s.io.stderr()).toMatch(/group/i);
    expect(existsSync(join(s.out, CASE, "pool.json"))).toBe(false);
    expect(s.client.calls.filter((c) => c.role === "adjudicator")).toHaveLength(0);
  }, 60_000);

  it("exits non-zero, with no model call, for a record of another PR", async () => {
    const s = setup({});
    const record = readJson<{ identity: { pr: number } }>(RECORD_FIXTURE);
    record.identity.pr = 8;
    const path = join(s.out, "..", "other.json");
    writeFileSync(path, JSON.stringify(record));
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--record", path);
    expect(code).not.toBe(0);
    expect(s.io.stderr()).toMatch(/8/);
    expect(s.client.calls).toHaveLength(0);
    expect(codexCalls(s.codexDir)).toHaveLength(0);
  }, 60_000);

  it("runs two blind reviews of each family by default", async () => {
    const s = setup({});
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out);
    expect(code).toBe(0);
    expect(s.io.stdout()).toMatch(/fixture-7: 0 items, .*reviews claude 0\+0, gpt 0\+0\n/);
    const reviews = readJson<{ reviews: { source: string; findings: number }[] }>(
      join(s.out, CASE, "reviews.json"),
    );
    expect(reviews.reviews.map((r) => [r.source, r.findings])).toEqual([
      ["claude-review-1", 0],
      ["claude-review-2", 0],
      ["gpt-review-1", 0],
      ["gpt-review-2", 0],
    ]);
    expect(s.client.calls.filter((c) => c.role === "pool-reviewer")).toHaveLength(2);
    expect(codexCalls(s.codexDir).filter((c) => c.kind === "review")).toHaveLength(2);
    expect(readJson(join(s.out, CASE, "pool.json"))).toEqual({ items: [] });
  }, 60_000);

  it("gives the end of the codex stderr in a failed GPT review, on disk and on stderr", async () => {
    const s = setup({ claudeReviews: [[item("MARK-K1", 11)]], gptReviews: ["fail", "fail"] });
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--reviews", "1");
    expect(code).toBe(1);
    const line = s.io
      .stderr()
      .split("\n")
      .find((l) => l.includes("a review failed: gpt-review-1"));
    expect(line).toContain("codex exited with code 1");
    expect(line).toContain(CODEX_ERROR);
    expect(line).not.toContain(CODEX_BANNER);
    const reviews = readJson<{ reviews: Record<string, unknown>[] }>(
      join(s.out, CASE, "reviews.json"),
    );
    const gpt = reviews.reviews.find((r) => r.source === "gpt-review-1");
    expect(gpt).toMatchObject({ ok: false });
    expect(String(gpt?.failed)).toContain(CODEX_ERROR);
    expect(s.io.stdout()).toMatch(/reviews claude 1, gpt failed\n/);
  }, 60_000);

  it("gives the end of the codex stderr in a failed GPT adjudication", async () => {
    const s = setup({
      claudeReviews: [[item("MARK-K1", 11)]],
      claude: { "MARK-K1": { score: 80, start_line: 11, end_line: 11 } },
      gpt: { "MARK-K1": "fail" },
    });
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--reviews", "1");
    expect(code).toBe(1);
    const adj = readJson<{ items: Adjudication[] }>(join(s.out, CASE, "adjudications.json"));
    const failed = (adj.items[0]?.gpt as { failed: string }).failed;
    expect(failed).toContain("codex exited with code 1");
    expect(failed).toContain(CODEX_ERROR);
    expect(failed).not.toContain(CODEX_BANNER);
    expect(failed.length).toBeLessThan(700);
  }, 60_000);

  it("pools a case directory that has no golden.json", async () => {
    const s = setup({ claudeReviews: [[item("MARK-K1", 11)]] });
    expect(existsSync(join(s.caseDir, "golden.json"))).toBe(false);
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--reviews", "1");
    expect(code).toBe(0);
    expect(existsSync(join(s.caseDir, "golden.json"))).toBe(false);
  }, 60_000);

  it("exits 2 without --out", async () => {
    const s = setup({});
    expect(await cli(s.client, "pool", s.caseDir)).toBe(2);
  });
});

// Change case.json of a set-up case.
function editMeta(s: Setup, change: (meta: Record<string, unknown>) => void): void {
  const path = join(s.caseDir, "case.json");
  const meta = readJson<Record<string, unknown>>(path);
  change(meta);
  writeFileSync(path, JSON.stringify(meta));
}

// Write the fixture record with a change, and give its path.
function editedRecord(s: Setup, change: (record: Record<string, any>) => void): string {
  const record = readJson<Record<string, any>>(RECORD_FIXTURE);
  change(record);
  const path = join(s.out, "..", "edited.json");
  writeFileSync(path, JSON.stringify(record));
  return path;
}

const KEPT = { score: 80, start_line: 11, end_line: 11 };

describe("pr-review pool --write-golden, after a failed call", () => {
  it("leaves golden.json unchanged and says so when an adjudication call failed", async () => {
    const s = setup({
      claudeReviews: [[item("MARK-K1", 11)]],
      gptReviews: [[]],
      claude: { "MARK-K1": "fail" },
      gpt: { "MARK-K1": KEPT },
    });
    writeFileSync(join(s.caseDir, "golden.json"), GOLDEN_BEFORE);
    const code = await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--reviews",
      "1",
      "--write-golden",
    );
    expect(code).toBe(1);
    expect(readFileSync(join(s.caseDir, "golden.json"), "utf8")).toBe(GOLDEN_BEFORE);
    expect(s.io.stderr()).toMatch(/golden\.json[^\n]*unchanged/);
  }, 60_000);

  it("leaves golden.json unchanged and says so when a blind review failed", async () => {
    const s = setup({
      claudeReviews: [[item("MARK-K1", 11)]],
      gptReviews: ["fail", "fail"],
      claude: { "MARK-K1": KEPT },
      gpt: { "MARK-K1": KEPT },
    });
    writeFileSync(join(s.caseDir, "golden.json"), GOLDEN_BEFORE);
    const code = await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--reviews",
      "1",
      "--write-golden",
    );
    expect(code).toBe(1);
    expect(readFileSync(join(s.caseDir, "golden.json"), "utf8")).toBe(GOLDEN_BEFORE);
    expect(s.io.stderr()).toMatch(/golden\.json[^\n]*unchanged/);
  }, 60_000);
});

describe("pr-review pool, the record check", () => {
  it("exits 2 before any call when a record finding is not valid", async () => {
    const s = setup({});
    const path = editedRecord(s, (r) => {
      delete r.stages.reviewers[0].findings[0].claim;
    });
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--record", path);
    expect(code).toBe(2);
    expect(s.io.stderr()).toMatch(/not a valid finding/);
    expect(s.client.calls).toHaveLength(0);
    expect(codexCalls(s.codexDir)).toHaveLength(0);
  }, 60_000);

  it("exits 2 before any call for a record of another repo", async () => {
    const s = setup({});
    const path = editedRecord(s, (r) => {
      r.identity.repo = "example/other";
    });
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--record", path);
    expect(code).toBe(2);
    expect(s.io.stderr()).toMatch(/example\/other/);
    expect(s.client.calls).toHaveLength(0);
    expect(codexCalls(s.codexDir)).toHaveLength(0);
  }, 60_000);

  it("takes the repo of a record from its GitHub slug when identity.repo is a path", async () => {
    const s = setup({});
    const path = editedRecord(s, (r) => {
      r.identity.repo = "/home/runner/work/fixture/fixture";
      r.identity.github = { slug: "Example/Fixture" };
    });
    const code = await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--reviews",
      "1",
      "--record",
      path,
    );
    expect(code).toBe(0);
  }, 60_000);

  it("exits 2 for a record when the origin of the case is not a pull request URL", async () => {
    const s = setup({});
    editMeta(s, (m) => {
      m.origin = "";
    });
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--record", RECORD_FIXTURE);
    expect(code).toBe(2);
    expect(s.io.stderr()).toMatch(/origin/);
    expect(s.client.calls).toHaveLength(0);
  }, 60_000);
});

describe("pr-review pool, the join of the kept items", () => {
  it("keeps adjudications.json when the second grouping fails", async () => {
    const s = setup({
      claudeReviews: [[item("MARK-O1", 3, 5), item("MARK-O2", 4, 6)]],
      gptReviews: [[]],
      groupers: [byTag, failGrouping, failGrouping],
      claude: {
        "MARK-O1": { score: 80, start_line: 3, end_line: 5 },
        "MARK-O2": { score: 90, start_line: 4, end_line: 6 },
      },
      gpt: {
        "MARK-O1": { score: 80, start_line: 3, end_line: 5 },
        "MARK-O2": { score: 85, start_line: 4, end_line: 6 },
      },
    });
    writeFileSync(join(s.caseDir, "golden.json"), GOLDEN_BEFORE);
    const code = await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--reviews",
      "1",
      "--write-golden",
    );
    expect(code).toBe(1);
    expect(s.io.stderr()).toMatch(/group/i);
    const adj = readJson<{ items: Adjudication[] }>(join(s.out, CASE, "adjudications.json"));
    expect(adj.items.map((a) => a.kept)).toEqual([true, true]);
    expect(readFileSync(join(s.caseDir, "golden.json"), "utf8")).toBe(GOLDEN_BEFORE);
  }, 60_000);

  it("groups the overlapping kept items of each component apart, and never across components", async () => {
    // Two pairs in two files. The pairs do not overlap each other.
    const inFormat = (marker: string, start: number, end: number) =>
      item(marker, start, end, { file: "src/format.ts" });
    const seen: string[][] = [];
    const spy: Plan["groupers"] = [
      byTag,
      (items) => {
        seen.push(items.map((i) => i.claim.slice(0, 7)).sort());
        return allInOne(items);
      },
      (items) => {
        seen.push(items.map((i) => i.claim.slice(0, 7)).sort());
        return allInOne(items);
      },
    ];
    const both = (start: number, end: number) => ({ score: 80, start_line: start, end_line: end });
    const verdicts = {
      "MARK-A1": both(3, 5),
      "MARK-A2": both(4, 6),
      "MARK-B1": both(2, 3),
      "MARK-B2": both(3, 4),
    };
    const s = setup({
      claudeReviews: [
        [
          item("MARK-A1", 3, 5),
          item("MARK-A2", 4, 6),
          inFormat("MARK-B1", 2, 3),
          inFormat("MARK-B2", 3, 4),
        ],
      ],
      gptReviews: [[]],
      groupers: spy,
      claude: verdicts,
      gpt: verdicts,
    });
    const code = await cli(
      s.client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--reviews",
      "1",
      "--write-golden",
    );
    expect(code).toBe(0);
    expect(seen.sort()).toEqual([
      ["MARK-A1", "MARK-A2"],
      ["MARK-B1", "MARK-B2"],
    ]);
    const golden = readJson<{ findings: { file: string }[] }>(join(s.caseDir, "golden.json"));
    expect(golden.findings.map((f) => f.file).sort()).toEqual(["src/format.ts", "src/stats.ts"]);
    expect(s.client.calls.filter((c) => c.role === "pool-grouper")).toHaveLength(3);
  }, 60_000);
});

describe("pr-review pool, the size of a codex prompt", () => {
  const LIMIT = 120_000;
  const euro = (n: number) => "€".repeat(n);

  it("holds a review prompt under the limit in bytes for a multi-byte diff, title and body", async () => {
    const s = setup({ claudeReviews: [[]], gptReviews: [[]] });
    // 60000 characters of 3 bytes each are under 65536 characters, and over 131072 bytes.
    writeFileSync(
      join(s.caseDir, "diff.patch"),
      `${readFileSync(join(s.caseDir, "diff.patch"), "utf8")}\n+${euro(60_000)}\n`,
    );
    editMeta(s, (m) => {
      m.title = euro(30_000);
      m.body = euro(60_000);
    });
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--reviews", "1");
    expect(code).toBe(0);
    const prompts = codexCalls(s.codexDir).map((c) => c.argv.at(-1) ?? "");
    expect(prompts).toHaveLength(1);
    expect(Buffer.byteLength(prompts[0] ?? "")).toBeLessThan(LIMIT);
    const cut = String(loadPrompt("pool-review.md").frontmatter.cut_text).split("{{limit}}")[0];
    expect(prompts[0]).toContain(cut);
  }, 60_000);

  it("holds an adjudication prompt under the limit in bytes for a multi-byte finding", async () => {
    const s = setup({
      claudeReviews: [[item("MARK-K1", 11, 11, { claim: `MARK-K1 ${euro(60_000)}`, evidence: euro(60_000) })]],
      gptReviews: [[]],
      claude: { "MARK-K1": KEPT },
    });
    writeFileSync(
      join(s.caseDir, "diff.patch"),
      `${readFileSync(join(s.caseDir, "diff.patch"), "utf8")}\n+${euro(60_000)}\n`,
    );
    const code = await cli(s.client, "pool", s.caseDir, "--out", s.out, "--reviews", "1");
    expect(code).toBe(0);
    const prompts = codexCalls(s.codexDir)
      .filter((c) => c.kind === "adjudicate")
      .map((c) => c.argv.at(-1) ?? "");
    expect(prompts).toHaveLength(1);
    expect(Buffer.byteLength(prompts[0] ?? "")).toBeLessThan(LIMIT);
  }, 60_000);
});
