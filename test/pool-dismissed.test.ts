// R1: "pr-review pool --dismissed" through the CLI entry, with a fake SDK
// client and a fake codex on PATH.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  allInOne,
  byTag,
  captureOutput,
  cli,
  codexCalls,
  fakeClient,
  installCodex,
  makeFixtureCase,
  type FixtureCase,
  type Item,
  type Plan,
  type Verdict,
} from "./fixtures/pool-fakes.js";

const CASE = "fixture-7";
const OTHER_HEAD = "2222222222222222222222222222222222222222";
const SECRET = "VERIFIER-SECRET rationale of the verifier.";

let work = "";
let fx: FixtureCase;
let count = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pr-review-pool-dismissed-"));
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

function item(marker: string, start: number, end = start): Item {
  return {
    file: "src/stats.ts",
    start_line: start,
    end_line: end,
    category: "bug",
    claim: `${marker} The code at this line is wrong.`,
    evidence: `evidence of ${marker}`,
  };
}

const at = (score: number, start: number, end = start): Verdict => ({
  score,
  start_line: start,
  end_line: end,
});

// A finding as the record holds it: more fields than the pool reads.
const full = (f: Item) => ({
  ...f,
  severity_estimate: "suggestion",
  confidence: "high",
  explanation: "explanation",
  needs_context: false,
});

type Dismissal = { finding: Item; label: "dont_post" | "not_real" };

function verification(d: Dismissal) {
  return {
    finding: full(d.finding),
    first: null,
    final: {
      in_scope: true,
      claim_holds: false,
      introduced_by_pr: false,
      quotes: [],
      rationale: SECRET,
      score: 3,
      severity: d.label,
    },
    passed: false,
  };
}

function recordFile(
  path: string,
  head: string,
  reviewed: Item[],
  dismissed: Dismissal[],
  extra: { finding: Item; label: string; passed: boolean }[] = [],
): string {
  const value = {
    identity: { repo: "example/fixture", pr: 7, head },
    stages: {
      reviewers: [{ name: "diff-bugs", pass: 1, findings: reviewed.map(full) }],
      verifications: [
        ...dismissed.map(verification),
        ...extra.map((e) => ({
          ...verification({ finding: e.finding, label: "dont_post" }),
          passed: e.passed,
          final: {
            ...verification({ finding: e.finding, label: "dont_post" }).final,
            severity: e.label,
          },
        })),
      ],
    },
  };
  writeFileSync(path, JSON.stringify(value));
  return path;
}

type Setup = { caseDir: string; out: string; root: string; head: string; codexDir: string };

function setup(plan: Plan) {
  count += 1;
  const root = join(work, `run-${count}`);
  mkdirSync(root);
  const caseDir = join(root, "cases", CASE);
  cpSync(fx.template, caseDir, { recursive: true });
  const codexDir = join(root, "codex");
  installCodex(codexDir, plan);
  const head = (JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as { head: string })
    .head;
  const s: Setup = { caseDir, out: join(root, "out"), root, head, codexDir };
  return { s, client: fakeClient(plan), io: captureOutput() };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const markerOf = (text: string) => /MARK-[A-Za-z0-9]+/.exec(text)?.[0] ?? "";

type Golden = { findings: { claim: string; severity: string; note?: string }[] };
type PoolOut = { items: { id: string; claim: string }[] };
type AdjOut = { items: { id: string; outcome: string }[] };
type KeyOut = Record<string, { members: Record<string, unknown>[] }>;

// D1: both 49 (a dismissed golden).      D2: Claude 49, GPT 50.
// D3: Claude 50, GPT 49.                 D4: both 80 (kept, dismissed as dont_post).
// D5: dismissed, no reviewer finding.    K1: kept, overlaps D1, not dismissed.
// B1: blind review, both 49.             D7: dismissed in a record of another head, both 49.
// D8: Claude 49, GPT 80.
const D1 = item("MARK-D1", 3, 4);
const D2 = item("MARK-D2", 9);
const D3 = item("MARK-D3", 10);
const D4 = item("MARK-D4", 8);
const D5 = item("MARK-D5", 6);
const K1 = item("MARK-K1", 4, 5);
const B1 = item("MARK-B1", 11);
const D7 = item("MARK-D7", 12);
const D8 = item("MARK-D8", 7);

const PLAN: Plan = {
  claudeReviews: [[B1]],
  gptReviews: [[]],
  claude: {
    "MARK-D1": at(49, 3, 4),
    "MARK-D2": at(49, 9),
    "MARK-D3": at(50, 10),
    "MARK-D4": at(80, 8),
    "MARK-K1": at(90, 4, 5),
    "MARK-B1": at(49, 11),
    "MARK-D7": at(49, 12),
    "MARK-D8": at(49, 7),
  },
  gpt: {
    "MARK-D1": at(49, 3, 4),
    "MARK-D2": at(50, 9),
    "MARK-D3": at(49, 10),
    "MARK-D4": at(80, 8),
    "MARK-K1": at(90, 4, 5),
    "MARK-B1": at(49, 11),
    "MARK-D7": at(49, 12),
    "MARK-D8": at(80, 7),
  },
};

function records(s: Setup): string[] {
  return [
    recordFile(
      join(s.root, "same-head.json"),
      s.head,
      [D1, D2, D3, D4, D8, K1],
      [
        { finding: D1, label: "not_real" },
        { finding: D2, label: "not_real" },
        { finding: D3, label: "dont_post" },
        { finding: D4, label: "dont_post" },
        { finding: D5, label: "not_real" },
        { finding: D8, label: "not_real" },
      ],
      [{ finding: K1, label: "dont_post", passed: true }],
    ),
    recordFile(
      join(s.root, "other-head.json"),
      OTHER_HEAD,
      [D7],
      [{ finding: D7, label: "not_real" }],
    ),
  ];
}

async function run(flag: boolean) {
  const { s, client, io } = setup(PLAN);
  const [a, b] = records(s);
  const code = await cli(
    client,
    "pool",
    s.caseDir,
    "--out",
    s.out,
    "--reviews",
    "1",
    "--write-golden",
    ...(flag ? ["--dismissed"] : []),
    "--record",
    a ?? "",
    "--record",
    b ?? "",
  );
  const pool = readJson<PoolOut>(join(s.out, CASE, "pool.json"));
  const adj = readJson<AdjOut>(join(s.out, CASE, "adjudications.json"));
  const golden = readJson<Golden>(join(s.caseDir, "golden.json"));
  const key = readJson<KeyOut>(join(s.out, CASE, "pool-key.json"));
  const outcome = (m: string) =>
    adj.items.find((i) => i.id === pool.items.find((p) => markerOf(p.claim) === m)?.id)?.outcome;
  const goldenOf = (m: string) => golden.findings.find((f) => markerOf(f.claim) === m);
  return { s, client, io, code, pool, adj, golden, key, outcome, goldenOf };
}

describe("pr-review pool --dismissed", () => {
  let r: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    r = await run(true);
  }, 120_000);

  it("writes a golden of severity unsure for a dismissed finding that both families score 49", () => {
    expect(r.code).toBe(0);
    expect(r.outcome("MARK-D1")).toBe("dismissed_golden");
    expect(r.goldenOf("MARK-D1")).toMatchObject({ severity: "unsure" });
    const note = r.goldenOf("MARK-D1")?.note ?? "";
    expect(note).toContain("same-head.json");
    expect(note).toContain("not_real");
    expect(note).toContain("49");
  });

  it("writes no golden for scores 49 and 50, or 50 and 49", () => {
    expect(r.goldenOf("MARK-D2")).toBeUndefined();
    expect(r.goldenOf("MARK-D3")).toBeUndefined();
  });

  it("keeps a dismissed finding that both families keep, and names the label in its note", () => {
    expect(r.outcome("MARK-D4")).toBe("golden");
    const note = r.goldenOf("MARK-D4")?.note ?? "";
    expect(note).toContain("dont_post");
    expect(note).toContain("same-head.json");
  });

  it("counts no dismissed finding of a record with another head", () => {
    expect(r.goldenOf("MARK-D7")).toBeUndefined();
    const member = Object.values(r.key)
      .flatMap((e) => e.members)
      .find((m) => markerOf(String(m.claim)) === "MARK-D7");
    expect(member).toBeDefined();
    expect(member).not.toHaveProperty("dismissed");
  });

  it("names a dismissed finding with no reviewer finding as unmatched in the summary", () => {
    const out = r.io.stdout();
    expect(out).toMatch(
      /fixture-7: dismissed 6 counted, 1 unmatched, 1 kept, 1 dismissed_golden, 3 no golden/,
    );
    expect(out).toMatch(/unmatched[^\n]*MARK-D5/);
  });

  it("gives the reason of an item with no golden: a score from 50 to 74, or no agreement", () => {
    const out = r.io.stdout();
    expect(out).toMatch(
      /no golden for dismissed item p\d+: a score from 50 to 74 \(Claude 49, GPT 50\)/,
    );
    expect(out).toMatch(
      /no golden for dismissed item p\d+: a score from 50 to 74 \(Claude 50, GPT 49\)/,
    );
    expect(out).toMatch(
      /no golden for dismissed item p\d+: the families do not agree \(Claude 49, GPT 80\)/,
    );
  });

  it("keeps a dismissed golden apart from the kept item that overlaps it", () => {
    expect(r.goldenOf("MARK-D1")).toBeDefined();
    expect(r.goldenOf("MARK-K1")).toBeDefined();
    expect(r.client.calls.filter((c) => c.role === "pool-grouper")).toHaveLength(1);
  });

  it("writes no golden for a blind-review item that both families score 49", () => {
    expect(r.outcome("MARK-B1")).toBe("not_kept");
    expect(r.goldenOf("MARK-B1")).toBeUndefined();
  });

  it("marks the members in pool-key.json only", () => {
    const marks = Object.values(r.key)
      .flatMap((e) => e.members)
      .filter((m) => m.dismissed !== undefined)
      .map((m) => [markerOf(String(m.claim)), m.dismissed]);
    expect(marks.sort()).toEqual([
      ["MARK-D1", "not_real"],
      ["MARK-D2", "not_real"],
      ["MARK-D3", "dont_post"],
      ["MARK-D4", "dont_post"],
      ["MARK-D8", "not_real"],
    ]);
    const pool = readFileSync(join(r.s.out, CASE, "pool.json"), "utf8");
    expect(pool).not.toContain("dismissed");
  });

  it("sends no adjudication request the label or the reason of the verifier", () => {
    const sdk = r.client.calls
      .filter((c) => c.role === "adjudicator")
      .map((c) => `${c.systemPrompt}\n${c.userMessage}`);
    const gpt = codexCalls(r.s.codexDir)
      .filter((c) => c.kind === "adjudicate")
      .map((c) => c.argv.at(-1) ?? "");
    expect(sdk.length).toBeGreaterThan(0);
    expect(gpt.length).toBeGreaterThan(0);
    for (const text of [...sdk, ...gpt]) {
      for (const word of ["VERIFIER-SECRET", "dont_post", "not_real", "dismissed"]) {
        expect(text).not.toContain(word);
      }
    }
  });
});

describe("pr-review pool without --dismissed", () => {
  it("writes no golden for a dismissed finding that both families score 49", async () => {
    const r = await run(false);
    expect(r.goldenOf("MARK-D1")).toBeUndefined();
    expect(r.outcome("MARK-D1")).toBe("not_kept");
    expect(r.goldenOf("MARK-D4")?.note ?? "").not.toContain("dont_post");
    expect(r.io.stdout()).not.toContain("dismissed");
    const marked = Object.values(r.key)
      .flatMap((e) => e.members)
      .filter((m) => m.dismissed !== undefined);
    expect(marked).toEqual([]);
  }, 120_000);
});

describe("pr-review pool --dismissed, a joined item", () => {
  it("names the label of a dismissed item that the join folds into another item", async () => {
    const J1 = item("MARK-J1", 5, 6);
    const J2 = item("MARK-J2", 6, 7);
    const plan: Plan = {
      claudeReviews: [[]],
      gptReviews: [[]],
      groupers: [byTag, allInOne],
      claude: { "MARK-J1": at(80, 5, 6), "MARK-J2": at(90, 6, 7) },
      gpt: { "MARK-J1": at(80, 5, 6), "MARK-J2": at(90, 6, 7) },
    };
    const { s, client } = setup(plan);
    const record = recordFile(
      join(s.root, "same-head.json"),
      s.head,
      [J1, J2],
      [{ finding: J1, label: "dont_post" }],
    );
    const code = await cli(
      client,
      "pool",
      s.caseDir,
      "--out",
      s.out,
      "--reviews",
      "1",
      "--write-golden",
      "--dismissed",
      "--record",
      record,
    );
    expect(code).toBe(0);
    const golden = readJson<Golden>(join(s.caseDir, "golden.json"));
    expect(golden.findings.map((f) => markerOf(f.claim))).toEqual(["MARK-J2"]);
    expect(golden.findings[0]?.note).toContain("dont_post");
    expect(golden.findings[0]?.note).toContain("same-head.json");
  }, 60_000);
});
