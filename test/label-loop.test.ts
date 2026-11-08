import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLES, roleConfig } from "../src/config/models.js";
import type { Case, GoldenFinding } from "../src/eval/case.js";
import { labelCase, type FindingOutcome, type LabelCall } from "../src/eval/label/loop.js";
import { DIFF_SECTION_LIMIT } from "../src/eval/label/prompts.js";
import { loadPrompt } from "../src/prompts/load.js";
import { ScorerResultSchema } from "../src/schemas/label.js";
import type { QueryMeta, QueryOutcome } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import { createSemaphore } from "../src/semaphore.js";

// The fake codex: a shell shim first on PATH that runs a node script. The
// script logs its argv, takes the next step of the plan for the marker in
// the prompt, and writes the out file of that step.
const SHIM_SCRIPT = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("-o") + 1];
appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ argv }) + "\\n");
const prompt = argv.at(-1) ?? "";
const marker = (prompt.match(/MARK-[A-Za-z0-9]+/) ?? ["default"])[0];
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const statePath = join(dir, "state-" + marker);
const n = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
writeFileSync(statePath, String(n + 1));
const list = plan[marker] ?? plan.default ?? [{ accept: true }];
const step = list[Math.min(n, list.length - 1)];
if (step.stderr) process.stderr.write(step.stderr);
if (step.exit) process.exit(step.exit);
if (step.missing) process.exit(0);
if (step.raw !== undefined) writeFileSync(out, step.raw);
else writeFileSync(out, JSON.stringify({ accept: step.accept ?? true, policy_section: step.section ?? "Labels", reason: step.reason ?? "ok" }));
`;

type JudgeStep = { accept?: boolean; section?: string; reason?: string; exit?: number };
type ScorerStep = {
  severity?: string;
  category?: string;
  section?: string;
  rationale?: string;
  fail?: boolean;
};

const META: QueryMeta = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

let codexDir = "";
let caseDir = "";
let checkout = "";

beforeEach(() => {
  codexDir = mkdtempSync(join(tmpdir(), "pr-review-label-loop-codex-"));
  caseDir = mkdtempSync(join(tmpdir(), "pr-review-label-loop-case-"));
  checkout = mkdtempSync(join(tmpdir(), "pr-review-label-loop-checkout-"));
  writeFileSync(join(codexDir, "shim.mjs"), SHIM_SCRIPT);
  writeFileSync(
    join(codexDir, "codex"),
    `#!/bin/sh\nexec node '${join(codexDir, "shim.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${codexDir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_CODEX_DIR", codexDir);
  // A head file of 300 numbered lines, and a diff with two files.
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(checkout, "a.ts"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(caseDir, "diff.patch"),
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -150,1 +150,1 @@",
      "-old A-DIFF-LINE",
      "+line 150",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,1 +1,1 @@",
      "-old B-DIFF-LINE",
      "+new",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of [codexDir, caseDir, checkout]) rmSync(dir, { recursive: true, force: true });
});

function judgePlan(steps: Record<string, JudgeStep[]>): void {
  writeFileSync(join(codexDir, "plan.json"), JSON.stringify(steps));
}

function codexCalls(): number {
  const path = join(codexDir, "log.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
}

/** A fake SDK client that gives the next scorer step for the marker in the message. */
function scorerFake(plan: Record<string, ScorerStep[]>, delayMs = 0) {
  const counts = new Map<string, number>();
  const load = { active: 0, max: 0 };
  const client = createFakeSdkClient(async (req): Promise<QueryOutcome<unknown>> => {
    const marker = /MARK-[A-Za-z0-9]+/.exec(req.userMessage)?.[0] ?? "default";
    const n = counts.get(marker) ?? 0;
    counts.set(marker, n + 1);
    const list = plan[marker] ?? plan.default ?? [{}];
    const step = list[Math.min(n, list.length - 1)] ?? {};
    load.active += 1;
    load.max = Math.max(load.max, load.active);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    load.active -= 1;
    if (step.fail) {
      return { ok: false, failure: { kind: "no-structured-output", message: "bad" }, raw: META };
    }
    return {
      ok: true,
      output: {
        severity: step.severity ?? "blocking",
        category: step.category ?? "bug",
        policy_section: step.section ?? "Labels",
        rationale: step.rationale ?? "r",
      },
      raw: META,
    };
  });
  return { client, load };
}

function golden(marker: string, start = 150, end = 151): GoldenFinding {
  return {
    file: "a.ts",
    start_line: start,
    end_line: end,
    category: "bug",
    severity: "suggestion",
    claim: `The claim ${marker}.`,
  };
}

function testCase(findings: GoldenFinding[]): Case {
  return {
    dir: caseDir,
    name: "c",
    source: "fixture",
    base: "b",
    head: "h",
    title: "t",
    body: "",
    origin: "",
    language: "TypeScript",
    golden: findings,
  };
}

async function label(
  findings: GoldenFinding[],
  client: ReturnType<typeof scorerFake>["client"],
  opts: { runs?: number; concurrency?: number; policy?: string } = {},
): Promise<FindingOutcome[]> {
  return labelCase(
    testCase(findings),
    { client, options: { allowApiKey: false, env: {} }, checkout, runs: opts.runs ?? 3 },
    opts.policy ?? "POLICY-TEXT",
    createSemaphore(opts.concurrency ?? 2),
  );
}

/** The prompt of every judge call, from the logged codex argv. */
function judgePrompts(): string[] {
  const path = join(codexDir, "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv.at(-1) ?? "");
}

/** The JSON object inside the finding block of a prompt. */
function findingBlock(text: string): Record<string, unknown> {
  const match = /<finding_[0-9a-f]+>\n([\s\S]*?)\n<\/finding_[0-9a-f]+>/.exec(text);
  return JSON.parse(match?.[1] ?? "null") as Record<string, unknown>;
}

const kinds = (calls: LabelCall[]): string[] => calls.map((c) => c.kind);

describe("the labeler role", () => {
  it("has the pinned scorer defaults", () => {
    expect(roleConfig("labeler")).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      maxTurns: 5,
      maxBudgetUsd: 0.5,
      timeoutMs: 300_000,
      tools: "none",
    });
  });

  it("is not a run role", () => {
    expect(ROLES).not.toContain("labeler");
  });
});

describe("the scorer schema", () => {
  const result = (severity: string) => ({
    severity,
    category: "bug",
    policy_section: "Labels",
    rationale: "r",
  });

  it("accepts the six labels of the policy", () => {
    for (const s of ["blocking", "suggestion", "nit", "dont_post", "not_real", "unsure"]) {
      expect(ScorerResultSchema.safeParse(result(s)).success, s).toBe(true);
    }
  });

  it("rejects a severity outside the six labels", () => {
    expect(ScorerResultSchema.safeParse(result("critical")).success).toBe(false);
  });
});

describe("the prompt files", () => {
  it("gives the scorer prompt its role, its kind and its two templates", () => {
    const p = loadPrompt("label-scorer.md");
    expect(p.frontmatter.role).toBe("labeler");
    expect(p.frontmatter.kind).toBe("system");
    expect(typeof p.frontmatter.user_message).toBe("string");
    expect(typeof p.frontmatter.feedback_text).toBe("string");
    expect(p.body.trim()).not.toBe("");
  });

  it("gives the judge prompt its role and its kind", () => {
    const p = loadPrompt("label-judge.md");
    expect(p.frontmatter.role).toBe("labeler-judge");
    expect(p.frontmatter.kind).toBe("system");
    expect(typeof p.frontmatter.user_message).toBe("string");
  });
});

describe("the loop", () => {
  it("labels a finding blocking when its three runs converge to blocking on the first pass", async () => {
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({ default: [{ severity: "blocking" }] });
    const [only] = await label([golden("MARK-a")], client);
    expect(only?.entry.chosen).toEqual({ severity: "blocking", category: "bug" });
    expect(only?.entry.runs.map((r) => [r.converged, r.first_pass_accepted])).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ]);
    expect(only?.queueReason).toBeNull();
  });

  it("stops a run after three rejected labels, and the other two runs still set the label", async () => {
    judgePlan({
      default: [{ accept: true }, { accept: false }, { accept: false }, { accept: false }, {}],
    });
    const { client } = scorerFake({ default: [{ severity: "nit" }] });
    const [only] = await label([golden("MARK-a")], client);
    const second = only?.entry.runs[1];
    expect(second?.converged).toBe(false);
    expect(second?.failed).toBe(false);
    expect(kinds(second?.calls ?? [])).toEqual([
      "scorer",
      "judge",
      "scorer",
      "judge",
      "scorer",
      "judge",
    ]);
    expect(only?.entry.chosen?.severity).toBe("nit");
  });

  it("sends the reason of a rejection to the next scorer call", async () => {
    judgePlan({ default: [{ accept: false, reason: "REASON-first-rejection" }, {}] });
    const { client } = scorerFake({ default: [{ severity: "nit" }] });
    await label([golden("MARK-a")], client, { runs: 1 });
    const [first, second] = client.calls;
    expect(first?.userMessage).not.toContain("REASON-first-rejection");
    expect(second?.userMessage).toContain("REASON-first-rejection");
  });

  it("gives no label, and queues the finding, when three runs converge to three labels", async () => {
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({
      default: [{ severity: "blocking" }, { severity: "suggestion" }, { severity: "nit" }],
    });
    const [only] = await label([golden("MARK-a")], client);
    expect(only?.entry.chosen).toBeNull();
    expect(only?.queueReason).toBe("no_majority");
  });

  it("gives no label, and queues the finding, when two runs do not converge", async () => {
    judgePlan({ default: [...Array<JudgeStep>(6).fill({ accept: false }), { accept: true }] });
    const { client } = scorerFake({ default: [{ severity: "nit" }] });
    const [only] = await label([golden("MARK-a")], client);
    expect(only?.entry.runs.map((r) => r.converged)).toEqual([false, false, true]);
    expect(only?.entry.chosen).toBeNull();
    expect(only?.queueReason).toBe("too_few_converged");
  });

  it("keeps the calls of one run out of the scorer requests of another run", async () => {
    judgePlan({ default: [{ accept: false, reason: "REASON-run-one" }, { accept: true }] });
    const { client } = scorerFake({
      default: [{ rationale: "RATIONALE-run-one" }, { rationale: "RATIONALE-rescore" }, {}],
    });
    await label([golden("MARK-a")], client);
    const messages = client.calls.map((c) => c.userMessage);
    // Run one makes two scorer calls. Runs two and three make one each.
    expect(messages).toHaveLength(4);
    expect(messages[1]).toContain("REASON-run-one");
    expect(messages[1]).toContain("RATIONALE-run-one");
    for (const later of messages.slice(2)) {
      expect(later).not.toContain("REASON-run-one");
      expect(later).not.toContain("RATIONALE-run-one");
      expect(later).not.toContain("RATIONALE-rescore");
    }
  });

  it("sends the 100-line window, numbered, the diff section of the file and the policy", async () => {
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({});
    await label([golden("MARK-a", 150, 151)], client, { runs: 1, policy: "POLICY-TEXT-xyz" });
    const message = client.calls[0]?.userMessage ?? "";
    expect(message).toMatch(/^ 50\| line 50$/m);
    expect(message).toMatch(/^251\| line 251$/m);
    expect(message).not.toMatch(/^ 49\| line 49$/m);
    expect(message).not.toMatch(/^252\| /m);
    expect(message).toContain("A-DIFF-LINE");
    expect(message).not.toContain("B-DIFF-LINE");
    expect(message).toContain("POLICY-TEXT-xyz");
  });

  it("sends no severity and no note of the source label in the finding block of any call", async () => {
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({});
    const withNote = { ...golden("MARK-a"), note: "NOTE-TEXT-xyz" };
    await label([withNote], client, { runs: 1 });
    const messages = [...client.calls.map((c) => c.userMessage), ...judgePrompts()];
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      const block = findingBlock(message);
      expect(block.claim).toBe("The claim MARK-a.");
      expect(block).not.toHaveProperty("severity");
      expect(block).not.toHaveProperty("note");
      expect(message).not.toContain("NOTE-TEXT-xyz");
    }
  });

  it("cuts a diff section over the limit, for the scorer and the judge, and says so", async () => {
    expect(DIFF_SECTION_LIMIT).toBe(65536);
    const body = Array.from({ length: 20000 }, (_, i) => `+filler ${i}`).join("\n");
    writeFileSync(
      join(caseDir, "diff.patch"),
      `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n${body}\n+ENDOFDIFF\n`,
    );
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({});
    await label([golden("MARK-a")], client, { runs: 1 });
    const messages = [client.calls[0]?.userMessage ?? "", judgePrompts()[0] ?? ""];
    for (const message of messages) {
      expect(message).toContain("+filler 100\n");
      expect(message).not.toContain("ENDOFDIFF");
      expect(message).toMatch(/cut[^\n]*65536|65536[^\n]*cut/);
    }
    // Both calls get the same diff text.
    const diffOf = (m: string) => /<diff_[0-9a-f]+>\n([\s\S]*?)\n<\/diff_[0-9a-f]+>/.exec(m)?.[1];
    expect(diffOf(messages[0] ?? "")).toBe(diffOf(messages[1] ?? ""));
    // The prompt of the judge stays under the limit of one argument.
    expect((messages[1] ?? "").length).toBeLessThan(100000);
  });

  it("cuts a head window over the limit, for the scorer and the judge, and says so", async () => {
    writeFileSync(join(checkout, "a.ts"), `${"x".repeat(50000)} ENDOFWINDOW\n`);
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({});
    await label([golden("MARK-a", 1, 1)], client, { runs: 1 });
    for (const message of [client.calls[0]?.userMessage ?? "", judgePrompts()[0] ?? ""]) {
      expect(message).not.toContain("ENDOFWINDOW");
      expect(message).toMatch(/cut[^\n]*32768/);
    }
  });

  it("sends a diff section under the limit whole, with no cut line", async () => {
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({});
    await label([golden("MARK-a")], client, { runs: 1 });
    expect(client.calls[0]?.userMessage).toContain("A-DIFF-LINE");
    expect(client.calls[0]?.userMessage).not.toContain("65536");
  });

  it("queues a finding with two unresolved runs of four, also when two runs converged", async () => {
    judgePlan({
      default: [{ accept: true }, { accept: true }, ...Array<JudgeStep>(6).fill({ accept: false })],
    });
    const { client } = scorerFake({ default: [{ severity: "nit" }] });
    const [only] = await label([golden("MARK-a")], client, { runs: 4 });
    expect(only?.entry.runs.map((r) => r.converged)).toEqual([true, true, false, false]);
    expect(only?.entry.chosen).toBeNull();
    expect(only?.queueReason).toBe("too_few_converged");
  });

  it("keeps the label when one run of four is unresolved", async () => {
    judgePlan({
      default: [
        { accept: true },
        { accept: true },
        { accept: true },
        ...Array<JudgeStep>(3).fill({ accept: false }),
      ],
    });
    const { client } = scorerFake({ default: [{ severity: "nit" }] });
    const [only] = await label([golden("MARK-a")], client, { runs: 4 });
    expect(only?.entry.chosen?.severity).toBe("nit");
    expect(only?.queueReason).toBeNull();
  });

  it("converges a run whose scorer call fails once and succeeds on the retry", async () => {
    judgePlan({ default: [{ accept: true }] });
    const { client } = scorerFake({ default: [{ fail: true }, { severity: "suggestion" }] });
    const [only] = await label([golden("MARK-a")], client, { runs: 1 });
    const run = only?.entry.runs[0];
    expect(run?.converged).toBe(true);
    expect(run?.severity).toBe("suggestion");
    expect(run?.calls[0]).toMatchObject({ kind: "scorer", error: expect.any(String) });
  });

  it("fails a run whose judge call fails twice, and the other runs still set the label", async () => {
    judgePlan({ default: [{ exit: 1 }, { exit: 1 }, { accept: true }] });
    const { client } = scorerFake({ default: [{ severity: "blocking" }] });
    const [only] = await label([golden("MARK-a")], client);
    const first = only?.entry.runs[0];
    expect(first).toMatchObject({ converged: false, failed: true, error: expect.any(String) });
    expect(kinds(first?.calls ?? [])).toEqual(["scorer", "judge", "judge"]);
    expect(only?.entry.chosen?.severity).toBe("blocking");
  });

  it("has no more than 2 findings in flight with a concurrency of 2", async () => {
    judgePlan({ default: [{ accept: true }] });
    const { client, load } = scorerFake({}, 40);
    const findings = ["MARK-a", "MARK-b", "MARK-c", "MARK-d", "MARK-e"].map((m) => golden(m));
    const outcomes = await label(findings, client, { runs: 1, concurrency: 2 });
    expect(outcomes).toHaveLength(5);
    expect(codexCalls()).toBe(5);
    expect(load.max).toBe(2);
  });
});
