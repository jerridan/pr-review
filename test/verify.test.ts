import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { runReviewers } from "../src/find/index.js";
import type { GatherResult } from "../src/gather/index.js";
import { mergeFindings } from "../src/merge/index.js";
import { loadPrompt } from "../src/prompts/load.js";
import type { ReviewerDefinition } from "../src/reviewers/loader.js";
import type { Finding } from "../src/schemas/finding.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import { VerifierResultSchema } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient, type FakeScript } from "../src/sdk/fake.js";
import type { RunOptions } from "../src/sdk/options.js";
import { createSemaphore } from "../src/semaphore.js";
import { UNTRUSTED_SYSTEM_LINE } from "../src/untrusted.js";
import {
  DEFAULT_VERIFY_CONFIG,
  verifyConfigFor,
  loadVerifierPrompt,
  verifyFinding,
  type VerifyConfig,
} from "../src/verify/index.js";
import { diffSections } from "../src/gather/diff.js";

const FILE_TEXT = [
  "export function average(values: number[]): number {",
  "  let total = 0;",
  "  for (let i = 0; i <= values.length; i++) {",
  "    total += values[i];",
  "  }",
  "  return total / values.length;",
  "}",
  "",
].join("\n");

const DIFF = [
  "diff --git a/src/stats.ts b/src/stats.ts",
  "--- a/src/stats.ts",
  "+++ b/src/stats.ts",
  "@@ -0,0 +1,7 @@",
  ...FILE_TEXT.trimEnd()
    .split("\n")
    .map((l) => `+${l}`),
  "diff --git a/other.ts b/other.ts",
  "--- a/other.ts",
  "+++ b/other.ts",
  "@@ -1 +1 @@",
  "-OTHER-OLD",
  "+OTHER-NEW",
  "",
].join("\n");

const head = mkdtempSync(join(tmpdir(), "pr-review-verify-"));
mkdirSync(join(head, "src"));
writeFileSync(join(head, "src/stats.ts"), FILE_TEXT);
writeFileSync(join(head, "src/other.ts"), "export const other = 42;\n");
const CODES_TEXT = 'const codes = {\n  200: "ok",\n  404: "missing",\n};\n';
writeFileSync(join(head, "src/codes.ts"), CODES_TEXT);
afterAll(() => rmSync(head, { recursive: true, force: true }));

const OPTIONS: RunOptions = { allowApiKey: false, env: {} };
const META: QueryMeta = {
  model: "claude-sonnet-5-5",
  durationMs: 5,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/stats.ts",
    start_line: 3,
    end_line: 3,
    category: "bug",
    severity_estimate: "nit",
    confidence: "low",
    claim: "CLAIM-loop-reads-past-end",
    evidence: "for (let i = 0; i <= values.length; i++) {",
    explanation: "The bound must be i < values.length.",
    needs_context: false,
    ...overrides,
  };
}

function result(score: number, overrides: Partial<VerifierResult> = {}): VerifierResult {
  return {
    in_scope: true,
    claim_holds: true,
    introduced_by_pr: true,
    quotes: ["i <= values.length"],
    rationale: "The loop reads values[values.length].",
    score,
    severity: "blocking",
    ...overrides,
  };
}

const okOutcome = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });

// The first verifier returns "first"; the escalation verifier returns "second".
function script(
  first: QueryOutcome<unknown> | VerifierResult,
  second?: QueryOutcome<unknown> | VerifierResult,
): FakeScript {
  const wrap = (o: QueryOutcome<unknown> | VerifierResult) => ("ok" in o ? o : okOutcome(o));
  return (req) => {
    if (req.role === "verifier") return wrap(first);
    if (req.role === "verifier-escalation" && second) return wrap(second);
    throw new Error(`unexpected query for role ${req.role}`);
  };
}

function ctx(config: VerifyConfig = DEFAULT_VERIFY_CONFIG) {
  return { cwd: head, diff: DIFF, semaphore: createSemaphore(5), config };
}

const roles = (calls: QueryRequest[]) => calls.map((c) => c.role);

describe("verifyFinding (A6)", () => {
  it("has the default threshold and band", () => {
    expect(DEFAULT_VERIFY_CONFIG).toEqual({ threshold: 80, bandLow: 60, bandHigh: 85 });
    expect(verifyConfigFor(80, DEFAULT_REPO_CONFIG)).toEqual(DEFAULT_VERIFY_CONFIG);
  });

  it("takes the band from the repo config and the threshold from the reviewer", () => {
    const config = {
      ...DEFAULT_REPO_CONFIG,
      thresholds: { default: 70, middle_band: [40, 50] as [number, number] },
    };
    expect(verifyConfigFor(90, config)).toEqual({ threshold: 90, bandLow: 40, bandHigh: 50 });
  });

  it("fails a finding that is not in scope, whatever its score, with no escalation", async () => {
    const fake = createFakeSdkClient(script(result(99, { in_scope: false })));
    const out = await verifyFinding(fake, OPTIONS, finding({ needs_context: true }), ctx());
    expect(out.passed).toBe(false);
    expect(out.escalated).toBeUndefined();
    expect(out.final).toEqual(result(99, { in_scope: false }));
    expect(roles(fake.calls)).toEqual(["verifier"]);
  });

  it("fails a score of 79 and passes a score of 80", async () => {
    const noBand = { ...DEFAULT_VERIFY_CONFIG, bandLow: 101, bandHigh: 101 };
    const low = await verifyFinding(
      createFakeSdkClient(script(result(79))),
      OPTIONS,
      finding(),
      ctx(noBand),
    );
    expect(low.passed).toBe(false);
    const high = await verifyFinding(
      createFakeSdkClient(script(result(80))),
      OPTIONS,
      finding(),
      ctx(noBand),
    );
    expect(high.passed).toBe(true);
    // With the default band both escalate; the escalated score decides.
    const esc79 = await verifyFinding(
      createFakeSdkClient(script(result(80), result(79))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(esc79.passed).toBe(false);
    const esc80 = await verifyFinding(
      createFakeSdkClient(script(result(79), result(80))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(esc80.passed).toBe(true);
  });

  it("escalates at the band edges 60 and 85", async () => {
    for (const score of [60, 85]) {
      const fake = createFakeSdkClient(script(result(score), result(90)));
      const out = await verifyFinding(fake, OPTIONS, finding(), ctx());
      expect(roles(fake.calls)).toEqual(["verifier", "verifier-escalation"]);
      expect(out.escalated).toEqual(result(90));
      expect(out.final).toEqual(result(90));
      expect(out.passed).toBe(true);
    }
  });

  it("does not escalate at 59 and 86", async () => {
    const at59 = createFakeSdkClient(script(result(59)));
    const out59 = await verifyFinding(at59, OPTIONS, finding(), ctx());
    expect(roles(at59.calls)).toEqual(["verifier"]);
    expect(out59.passed).toBe(false);
    const at86 = createFakeSdkClient(script(result(86)));
    const out86 = await verifyFinding(at86, OPTIONS, finding(), ctx());
    expect(roles(at86.calls)).toEqual(["verifier"]);
    expect(out86.passed).toBe(true);
    expect(out86.escalated).toBeUndefined();
  });

  it("escalates a finding with needs_context, whatever its score", async () => {
    const fake = createFakeSdkClient(script(result(97), result(40)));
    const out = await verifyFinding(fake, OPTIONS, finding({ needs_context: true }), ctx());
    expect(roles(fake.calls)).toEqual(["verifier", "verifier-escalation"]);
    expect(out.final).toEqual(result(40));
    expect(out.passed).toBe(false);
  });

  it("applies the threshold to the escalated result", async () => {
    const up = await verifyFinding(
      createFakeSdkClient(script(result(65), result(81))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(up).toEqual({
      first: result(65),
      escalated: result(81),
      final: result(81),
      passed: true,
      pre_existing: false,
    });
    const down = await verifyFinding(
      createFakeSdkClient(script(result(84), result(50))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(down.final).toEqual(result(50));
    expect(down.passed).toBe(false);
    const outOfScope = await verifyFinding(
      createFakeSdkClient(script(result(70), result(95, { in_scope: false }))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(outOfScope.passed).toBe(false);
  });

  it("treats an out-of-range score as a failed query", async () => {
    for (const score of [101, -1, 150]) {
      const out = await verifyFinding(
        createFakeSdkClient(script(result(score))),
        OPTIONS,
        finding(),
        ctx(),
      );
      expect(out.first).toMatchObject({ kind: "out-of-range" });
      expect(out.final).toBeNull();
      expect(out.passed).toBe(false);
    }
  });

  it("drops the finding when the verifier query fails", async () => {
    const failure = { kind: "subtype" as const, message: "error_during_execution" };
    const fake = createFakeSdkClient(script({ ok: false, failure, raw: META }));
    const out = await verifyFinding(fake, OPTIONS, finding({ needs_context: true }), ctx());
    expect(out).toEqual({ first: failure, final: null, passed: false, pre_existing: false });
    expect(roles(fake.calls)).toEqual(["verifier"]);
  });

  it("turns a thrown client error into a failed query", async () => {
    const fake = createFakeSdkClient(() => {
      throw new Error("spawn failed");
    });
    const out = await verifyFinding(fake, OPTIONS, finding(), ctx());
    expect(out.first).toEqual({ kind: "thrown", message: "spawn failed" });
    expect(out.passed).toBe(false);
  });

  it("drops the finding when the escalation fails or is refused", async () => {
    const failure = { kind: "refusal" as const, message: "The stop reason is refusal." };
    const out = await verifyFinding(
      createFakeSdkClient(script(result(82), { ok: false, failure, raw: META })),
      OPTIONS,
      finding(),
      ctx(),
    );
    // A first score of 82 passes the threshold, but the second check did not occur.
    expect(out).toEqual({
      first: result(82),
      escalated: failure,
      final: null,
      passed: false,
      pre_existing: false,
    });
    const oor = await verifyFinding(
      createFakeSdkClient(script(result(70), result(200))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(oor.escalated).toMatchObject({ kind: "out-of-range" });
    expect(oor.final).toBeNull();
    expect(oor.passed).toBe(false);
  });

  it("passes a result only when one of its quotes is in the head file", async () => {
    const noBand = { ...DEFAULT_VERIFY_CONFIG, bandLow: 101, bandHigh: 101 };
    const verify = (r: VerifierResult) =>
      verifyFinding(createFakeSdkClient(script(r)), OPTIONS, finding(), ctx(noBand));

    const none = await verify(result(95, { quotes: [] }));
    expect(none.passed).toBe(false);
    expect(none.final).toEqual(result(95, { quotes: [] }));
    expect(none.rejected).toMatch(/quote/i);

    const wrong = await verify(result(95, { quotes: ["this text is not in the file"] }));
    expect(wrong.passed).toBe(false);
    expect(wrong.rejected).toMatch(/quote/i);

    // A quote that is only in the diff of another file does not count.
    const diffOnly = await verify(result(95, { quotes: ["OTHER-NEW"] }));
    expect(diffOnly.passed).toBe(false);

    const blank = await verify(result(95, { quotes: ["   "] }));
    expect(blank.passed).toBe(false);

    // One good quote is sufficient, and whitespace runs collapse.
    const good = await verify(result(95, { quotes: ["not here", "i   <=\n  values.length"] }));
    expect(good.passed).toBe(true);
    expect(good.rejected).toBeUndefined();
  });

  it("removes the line prefixes that the message and the tools add before it matches a quote", async () => {
    const noBand = { ...DEFAULT_VERIFY_CONFIG, bandLow: 101, bandHigh: 101 };
    const verify = (quotes: string[]) =>
      verifyFinding(
        createFakeSdkClient(script(result(95, { quotes }))),
        OPTIONS,
        finding(),
        ctx(noBand),
      );

    // The numbered lines of the head file block in the user message.
    const numbered = await verify(["3| for (let i = 0; i <= values.length; i++) {"]);
    expect(numbered.passed).toBe(true);
    expect(numbered.rejected).toBeUndefined();

    // A quote of two numbered lines.
    const twoLines = await verify([
      "3|   for (let i = 0; i <= values.length; i++) {\n4|     total += values[i];",
    ]);
    expect(twoLines.passed).toBe(true);

    // The output of the Read tool: the line number, a tab, then the line.
    const read = await verify(["3\t  for (let i = 0; i <= values.length; i++) {"]);
    expect(read.passed).toBe(true);
    expect(read.rejected).toBeUndefined();

    // Two lines of the Read tool output.
    const readTwo = await verify([
      "3\t  for (let i = 0; i <= values.length; i++) {\n4\t    total += values[i];",
    ]);
    expect(readTwo.passed).toBe(true);

    // A legacy Read format with an arrow.
    const arrow = await verify(["     3→  for (let i = 0; i <= values.length; i++) {"]);
    expect(arrow.passed).toBe(true);

    // The output of the Grep tool.
    const grep = await verify(["src/stats.ts:3:  for (let i = 0; i <= values.length; i++) {"]);
    expect(grep.passed).toBe(true);
  });

  it("passes a quote whose inner line starts like a line prefix but is code", async () => {
    const noBand = { ...DEFAULT_VERIFY_CONFIG, bandLow: 101, bandHigh: 101 };
    const quote = 'const codes = {\n  200: "ok",\n  404: "missing",';
    const out = await verifyFinding(
      createFakeSdkClient(script(result(95, { quotes: [quote] }))),
      OPTIONS,
      finding({ file: "src/codes.ts", start_line: 2, end_line: 2, evidence: '200: "ok",' }),
      ctx(noBand),
    );
    expect(out.passed).toBe(true);
    expect(out.rejected).toBeUndefined();
  });

  it("fails a result whose only quote is from a file that the finding does not name", async () => {
    const noBand = { ...DEFAULT_VERIFY_CONFIG, bandLow: 101, bandHigh: 101 };
    const out = await verifyFinding(
      createFakeSdkClient(script(result(95, { quotes: ["export const other = 42;"] }))),
      OPTIONS,
      finding(),
      ctx(noBand),
    );
    expect(out.passed).toBe(false);
    expect(out.rejected).toMatch(/quote/i);
  });

  it("tells the verifier to quote without line prefixes and from the file that the finding names", () => {
    const body = loadPrompt("verifier.md").body;
    expect(body).toMatch(/line numbers/);
    expect(body).toContain("path:line:");
    expect(body).toMatch(/at least one quote .*file that the finding names/i);
  });

  it("applies the quote check to the escalated result", async () => {
    const out = await verifyFinding(
      createFakeSdkClient(script(result(70), result(95, { quotes: ["not in the file"] }))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(out.passed).toBe(false);
    expect(out.final).toEqual(result(95, { quotes: ["not in the file"] }));
    expect(out.rejected).toMatch(/quote/i);
  });

  it("records no quote reason when the result fails for another reason", async () => {
    const out = await verifyFinding(
      createFakeSdkClient(script(result(20, { quotes: [] }))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(out.passed).toBe(false);
    expect(out.rejected).toBeUndefined();
  });

  it("fails a finding whose claim does not hold", async () => {
    const out = await verifyFinding(
      createFakeSdkClient(script(result(95, { claim_holds: false }))),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(out.passed).toBe(false);
  });

  it("sends the finding, the head file and its diff hunk, but not the reviewer name", async () => {
    const fake = createFakeSdkClient(script(result(70), result(90)));
    await verifyFinding(fake, OPTIONS, finding(), ctx());
    const [first, second] = fake.calls as [QueryRequest, QueryRequest];
    const prompt = loadPrompt("verifier.md");
    expect(first.systemPrompt).toBe(prompt.body);
    expect(first.systemPrompt).toContain(UNTRUSTED_SYSTEM_LINE);
    expect(second.systemPrompt).toBe(prompt.body);
    expect(first.schema).toBe(VerifierResultSchema);
    expect(second.schema).toBe(VerifierResultSchema);
    expect(first.cwd).toBe(head);
    expect(first.overrides).toBeUndefined();
    expect(first.reviewerName).toBeUndefined();
    const message = first.userMessage;
    expect(message).toContain("CLAIM-loop-reads-past-end");
    expect(message).toContain("for (let i = 0; i <= values.length; i++) {");
    expect(message).toContain("return total / values.length;");
    expect(message).toContain("+++ b/src/stats.ts");
    expect(message).not.toContain("OTHER-NEW");
    expect(message).not.toContain("diff-bugs");
    expect(message).not.toMatch(/severity_estimate|"confidence"/);
    expect(message).toMatch(/<finding_[0-9a-f]{16}>/);
    expect(second.userMessage).toContain("CLAIM-loop-reads-past-end");
  });

  it("uses the verifier prompt that the context gives, and does not load it again", async () => {
    const loaded = loadVerifierPrompt();
    expect(loaded.system).toBe(loadPrompt("verifier.md").body);
    const fake = createFakeSdkClient(script(result(90)));
    await verifyFinding(fake, OPTIONS, finding(), {
      ...ctx(),
      prompt: { ...loaded, system: "SYSTEM-FROM-CONTEXT" },
    });
    expect(fake.calls[0]?.systemPrompt).toBe("SYSTEM-FROM-CONTEXT");
  });

  it("takes the diff of the finding's file from the sections that the context gives", async () => {
    const fake = createFakeSdkClient(script(result(90)));
    const sections = new Map([["src/stats.ts", "SECTION-FROM-CONTEXT\n"]]);
    await verifyFinding(fake, OPTIONS, finding(), { ...ctx(), diff: "", sections });
    expect(fake.calls[0]?.userMessage).toContain("SECTION-FROM-CONTEXT");
    const split = diffSections(DIFF);
    const second = createFakeSdkClient(script(result(90)));
    await verifyFinding(second, OPTIONS, finding(), { ...ctx(), diff: "", sections: split });
    expect(second.calls[0]?.userMessage).toContain("+++ b/src/stats.ts");
    expect(second.calls[0]?.userMessage).not.toContain("OTHER-NEW");
  });

  it("runs each verifier query inside the semaphore", async () => {
    let active = 0;
    let peak = 0;
    const fake = createFakeSdkClient(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return okOutcome(result(90));
    });
    const shared = { ...ctx(), semaphore: createSemaphore(1) };
    await Promise.all([1, 2, 3].map(() => verifyFinding(fake, OPTIONS, finding(), shared)));
    expect(peak).toBe(1);
  });
});

describe("a verified pre-existing finding (R6)", () => {
  const verify = (r: VerifierResult, config: VerifyConfig = DEFAULT_VERIFY_CONFIG) =>
    verifyFinding(createFakeSdkClient(script(r)), OPTIONS, finding(), ctx(config));

  it("is flagged when it is out of scope, holds, scores at the threshold and quotes the head file", async () => {
    const out = await verify(result(80, { in_scope: false, introduced_by_pr: false }));
    expect(out.pre_existing).toBe(true);
    // The scope gate still fails it, so it is not posted.
    expect(out.passed).toBe(false);
    expect(out.escalated).toBeUndefined();
  });

  it("uses the threshold of the reviewer", async () => {
    const strict = { ...DEFAULT_VERIFY_CONFIG, threshold: 90 };
    expect((await verify(result(89, { in_scope: false }), strict)).pre_existing).toBe(false);
    expect((await verify(result(90, { in_scope: false }), strict)).pre_existing).toBe(true);
  });

  it("is not flagged below the threshold, when the claim does not hold, or in scope", async () => {
    expect((await verify(result(79, { in_scope: false }))).pre_existing).toBe(false);
    expect((await verify(result(95, { in_scope: false, claim_holds: false }))).pre_existing).toBe(
      false,
    );
    expect((await verify(result(95))).pre_existing).toBe(false);
  });

  it("is not flagged when no verifier quote is in the head file", async () => {
    const out = await verify(result(95, { in_scope: false, quotes: ["not in the file at all"] }));
    expect(out.pre_existing).toBe(false);
    expect(out.passed).toBe(false);
  });

  it("is not flagged when the verifier query fails", async () => {
    const failure = { kind: "subtype" as const, message: "x" };
    const out = await verifyFinding(
      createFakeSdkClient(script({ ok: false, failure, raw: META })),
      OPTIONS,
      finding(),
      ctx(),
    );
    expect(out.pre_existing).toBe(false);
  });
});

describe("verification starts per finding", () => {
  const GATHERED: GatherResult = {
    base: "a".repeat(40),
    head: "b".repeat(40),
    changedFiles: [{ path: "src/stats.ts", hunks: 1 }],
    excluded: [],
    sensitive: [],
    diff: DIFF,
    totalHunks: 1,
    mergeBase: "c".repeat(40),
    description: "",
    history: null,
  };

  function def(name: string): ReviewerDefinition {
    return {
      source: "builtin",
      path: `/x/${name}.md`,
      systemPrompt: `SYSTEM ${name}`,
      frontmatter: {
        name,
        description: "d",
        model: "opus",
        effort: "low",
        tools: [],
        triggers: { paths: [], categories: [], min_tier: "fast" },
        passes: 1,
        threshold: 80,
        trusted: true,
      },
    };
  }

  it("starts a verifier call before the slowest reviewer returns", async () => {
    const events: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const fake = createFakeSdkClient(async (req) => {
      if (req.role === "reviewer" && req.reviewerName === "fast") {
        events.push("fast reviewer returns");
        return okOutcome({ findings: [finding()] });
      }
      if (req.role === "reviewer" && req.reviewerName === "slow") {
        await slowGate;
        events.push("slow reviewer returns");
        return okOutcome({ findings: [] });
      }
      events.push("verifier starts");
      // The slow reviewer may return only after a verifier call starts.
      releaseSlow();
      return okOutcome(result(90));
    });
    const semaphore = createSemaphore(5);
    const verifications: Promise<unknown>[] = [];
    await runReviewers(
      fake,
      OPTIONS,
      [
        { def: def("slow"), trigger: "t" },
        { def: def("fast"), trigger: "t" },
      ],
      { gathered: GATHERED, brief: null, cwd: head, semaphore, config: DEFAULT_REPO_CONFIG },
      (f) => {
        verifications.push(
          verifyFinding(fake, OPTIONS, f, {
            cwd: head,
            diff: DIFF,
            semaphore,
            config: DEFAULT_VERIFY_CONFIG,
          }),
        );
      },
    );
    await Promise.all(verifications);
    expect(events).toEqual(["fast reviewer returns", "verifier starts", "slow reviewer returns"]);
  });

  it("sends the diff of a file that the reviewer named with a ./ prefix", async () => {
    const fake = createFakeSdkClient((req) => {
      if (req.role === "reviewer")
        return okOutcome({ findings: [finding({ file: "./src/stats.ts" })] });
      return okOutcome(result(90));
    });
    const semaphore = createSemaphore(5);
    const sections = diffSections(DIFF);
    const verifications: Promise<unknown>[] = [];
    await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      {
        gathered: GATHERED,
        brief: null,
        cwd: head,
        semaphore,
        sections,
        config: DEFAULT_REPO_CONFIG,
      },
      (f) => {
        expect(f.file).toBe("src/stats.ts");
        verifications.push(
          verifyFinding(fake, OPTIONS, f, {
            cwd: head,
            sections,
            prompt: loadVerifierPrompt(),
            semaphore,
            config: DEFAULT_VERIFY_CONFIG,
          }),
        );
      },
    );
    await Promise.all(verifications);
    const verifier = fake.calls.find((c) => c.role === "verifier");
    expect(verifier?.userMessage).toContain("+++ b/src/stats.ts");
    expect(verifier?.userMessage).toContain('"file": "src/stats.ts"');
  });

  it("leaves a finding that fails the verifier out of the posted output", async () => {
    const good = finding();
    const weak = finding({
      start_line: 6,
      end_line: 6,
      claim: "CLAIM-weak",
      evidence: "return total / values.length;",
    });
    const fake = createFakeSdkClient((req) => {
      if (req.role === "reviewer") return okOutcome({ findings: [good, weak] });
      if (req.userMessage.includes("CLAIM-weak")) return okOutcome(result(20));
      return okOutcome(result(95));
    });
    const semaphore = createSemaphore(5);
    const pending: Promise<{ finding: Finding; out: Awaited<ReturnType<typeof verifyFinding>> }>[] =
      [];
    await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      { gathered: GATHERED, brief: null, cwd: head, semaphore, config: DEFAULT_REPO_CONFIG },
      (f) => {
        pending.push(
          verifyFinding(fake, OPTIONS, f, {
            cwd: head,
            diff: DIFF,
            semaphore,
            config: DEFAULT_VERIFY_CONFIG,
          }).then((out) => ({ finding: f, out })),
        );
      },
    );
    const verified = (await Promise.all(pending))
      .filter((v) => v.out.passed && v.out.final)
      .map((v) => ({ finding: v.finding, result: v.out.final as VerifierResult }));
    const merged = await mergeFindings(fake, OPTIONS, verified, {
      cwd: head,
      totalHunks: 1,
      semaphore,
    });
    expect(merged.posted.map((p) => p.claim)).toEqual(["CLAIM-loop-reads-past-end"]);
    expect(merged.capped).toEqual([]);
  });
});

describe("the description block in the verifier message (R2)", () => {
  const blockOrder = (message: string) =>
    [...message.matchAll(/<([a-z][a-z0-9_]*)_[0-9a-f]{16}>\n([\s\S]*?)\n<\/\1_[0-9a-f]{16}>/g)].map(
      (m) => ({ label: m[1] ?? "", text: m[2] ?? "" }),
    );

  it("holds the description of the change for every finding, before the diff", async () => {
    const fake = createFakeSdkClient(script(result(70), result(95)));
    await verifyFinding(fake, OPTIONS, finding(), { ...ctx(), description: "DESC-of-change" });
    expect(roles(fake.calls)).toEqual(["verifier", "verifier-escalation"]);
    for (const call of fake.calls) {
      const order = blockOrder(call.userMessage);
      expect(order.map((b) => b.label)).toEqual(["finding", "head_file", "description", "diff"]);
      expect(order.find((b) => b.label === "description")?.text).toBe("DESC-of-change");
    }
  });

  it("uses the prompt-file text when the description is empty", async () => {
    const fake = createFakeSdkClient(script(result(95)));
    await verifyFinding(fake, OPTIONS, finding(), { ...ctx(), description: "" });
    const text = loadPrompt("verifier.md").frontmatter.no_description_text;
    expect(typeof text).toBe("string");
    expect(
      blockOrder(fake.calls[0]?.userMessage ?? "").find((b) => b.label === "description")?.text,
    ).toBe((text as string).trim());
  });

  it("does not tell the verifier which reviewer gave the finding", async () => {
    const fake = createFakeSdkClient(script(result(95)));
    await verifyFinding(fake, OPTIONS, finding(), { ...ctx(), description: "d" });
    expect(fake.calls[0]?.reviewerName).toBeUndefined();
    expect(fake.calls[0]?.userMessage).not.toContain("diff-bugs");
  });
});
