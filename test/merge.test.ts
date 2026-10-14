import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG, type Suppression } from "../src/config/repo-config.js";
import { applyCap, DEFAULT_CAPS, nonBlockingCap } from "../src/merge/cap.js";
import { fingerprint } from "../src/merge/fingerprint.js";
import { groupFindings, mergeFindings } from "../src/merge/index.js";
import { applySuppressions } from "../src/merge/suppress.js";
import { loadPrompt } from "../src/prompts/load.js";
import type { Finding, Severity } from "../src/schemas/finding.js";
import type { MergeOutput } from "../src/schemas/merge.js";
import { MergeOutputSchema } from "../src/schemas/merge.js";
import type { PostedFinding } from "../src/schemas/record.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import type { RunOptions } from "../src/sdk/options.js";
import { createSemaphore } from "../src/semaphore.js";
import { UNTRUSTED_SYSTEM_LINE } from "../src/untrusted.js";

const FILE_TEXT =
  Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n";

const head = mkdtempSync(join(tmpdir(), "pr-review-merge-"));
mkdirSync(join(head, "src"));
writeFileSync(join(head, "src/a.ts"), FILE_TEXT);
writeFileSync(join(head, "src/b.ts"), FILE_TEXT);
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
const THINK_LINE = "Think the problem through before you answer.";

function finding(start: number, end: number, overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    start_line: start,
    end_line: end,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: `claim ${start}-${end}`,
    evidence: `const line${start} = ${start};`,
    suggested_fix: `fix ${start}`,
    explanation: `explanation ${start}`,
    needs_context: false,
    ...overrides,
  };
}

function result(score: number, severity: Severity): VerifierResult {
  return {
    in_scope: true,
    claim_holds: true,
    introduced_by_pr: true,
    quotes: [],
    rationale: "r",
    score,
    severity,
  };
}

const ok = (output: MergeOutput): QueryOutcome<unknown> => ({ ok: true, output, raw: META });

function noMergeClient() {
  return createFakeSdkClient((req) => {
    throw new Error(`unexpected query for role ${req.role}`);
  });
}

function ctx(totalHunks = 4) {
  return { cwd: head, totalHunks, semaphore: createSemaphore(5) };
}

describe("fingerprint", () => {
  it("is stable for the same file, span text and category", () => {
    const a = fingerprint(finding(3, 4), FILE_TEXT);
    expect(a).toMatch(/^[0-9a-f]{16,}$/);
    expect(fingerprint(finding(3, 4, { claim: "other words" }), FILE_TEXT)).toBe(a);
  });

  it("ignores whitespace changes in the span", () => {
    const spaced = FILE_TEXT.replace("const line3 = 3;", "  const   line3 =\t3;");
    expect(fingerprint(finding(3, 3), spaced)).toBe(fingerprint(finding(3, 3), FILE_TEXT));
  });

  it("changes with the file, the span text or the category", () => {
    const a = fingerprint(finding(3, 4), FILE_TEXT);
    expect(fingerprint(finding(3, 4, { file: "src/b.ts" }), FILE_TEXT)).not.toBe(a);
    expect(fingerprint(finding(5, 6), FILE_TEXT)).not.toBe(a);
    expect(fingerprint(finding(3, 4, { category: "security" }), FILE_TEXT)).not.toBe(a);
  });

  it("uses the evidence when the head file is missing", () => {
    const a = fingerprint(finding(3, 4), null);
    expect(fingerprint(finding(3, 4, { evidence: "  const line3 = 3;  " }), null)).toBe(a);
    expect(fingerprint(finding(3, 4, { evidence: "other" }), null)).not.toBe(a);
  });
});

describe("groupFindings", () => {
  it("groups overlapping lines in one file, transitively", () => {
    const groups = groupFindings([
      finding(1, 3),
      finding(10, 12),
      finding(3, 5),
      finding(5, 8),
      finding(3, 5, { file: "src/b.ts" }),
      finding(9, 9),
    ]);
    expect(groups).toEqual([[0, 2, 3], [1], [4], [5]]);
  });

  it("does not group ranges that only touch end to start", () => {
    expect(groupFindings([finding(1, 2), finding(3, 4)])).toEqual([[0], [1]]);
  });
});

describe("mergeFindings (A7)", () => {
  it("posts a single finding with the verifier severity and a fingerprint", async () => {
    const f = finding(3, 3, { severity_estimate: "nit" });
    const out = await mergeFindings(
      noMergeClient(),
      OPTIONS,
      [{ finding: f, result: result(90, "suggestion") }],
      ctx(),
    );
    expect(out.posted).toEqual([
      {
        ...f,
        fingerprint: fingerprint(f, FILE_TEXT),
        severity: "suggestion",
        score: 90,
        verifier: result(90, "suggestion"),
      },
    ]);
    expect(out.merges).toEqual([]);
  });

  it("merges a group into its highest-scoring member, with the new wording", async () => {
    const a = finding(3, 5);
    const b = finding(4, 6, { evidence: "const line4 = 4;" });
    const fake = createFakeSdkClient(() =>
      ok({
        merged: [
          {
            member_index: 1,
            claim: "MERGED claim",
            explanation: "MERGED why",
            severity: "suggestion",
          },
        ],
      }),
    );
    const out = await mergeFindings(
      fake,
      OPTIONS,
      [
        { finding: a, result: result(82, "blocking") },
        { finding: b, result: result(91, "blocking") },
      ],
      ctx(),
    );
    expect(fake.calls).toHaveLength(1);
    expect(out.posted).toHaveLength(1);
    const posted = out.posted[0] as PostedFinding;
    expect(posted).toMatchObject({
      file: "src/a.ts",
      start_line: 4,
      end_line: 6,
      evidence: "const line4 = 4;",
      claim: "MERGED claim",
      explanation: "MERGED why",
      severity: "suggestion",
      score: 91,
      verifier: result(91, "blocking"),
    });
    expect(posted.suggested_fix).toBeUndefined();
    expect(out.merges).toEqual([
      {
        group: [0, 1],
        result: {
          merged: [
            {
              member_index: 1,
              claim: "MERGED claim",
              explanation: "MERGED why",
              severity: "suggestion",
            },
          ],
        },
      },
    ]);
  });

  it("rejects a merge that upgrades a severity and posts the members unmerged", async () => {
    const fake = createFakeSdkClient(() =>
      ok({ merged: [{ member_index: 0, claim: "c", explanation: "e", severity: "blocking" }] }),
    );
    const out = await mergeFindings(
      fake,
      OPTIONS,
      [
        { finding: finding(3, 5), result: result(90, "suggestion") },
        { finding: finding(4, 6), result: result(85, "nit") },
      ],
      ctx(),
    );
    expect(out.posted.map((p) => [p.claim, p.severity])).toEqual([
      ["claim 3-5", "suggestion"],
      ["claim 4-6", "nit"],
    ]);
    expect(out.merges[0]?.rejected).toMatch(/upgrade/i);
  });

  it("rejects a merge that moves the line range away from the highest-scoring member", async () => {
    const fake = createFakeSdkClient(() =>
      ok({ merged: [{ member_index: 1, claim: "c", explanation: "e", severity: "nit" }] }),
    );
    const out = await mergeFindings(
      fake,
      OPTIONS,
      [
        { finding: finding(3, 5), result: result(95, "blocking") },
        { finding: finding(4, 9), result: result(81, "blocking") },
      ],
      ctx(),
    );
    expect(out.posted.map((p) => [p.start_line, p.end_line])).toEqual([
      [3, 5],
      [4, 9],
    ]);
    expect(out.merges[0]?.rejected).toMatch(/line range/i);
  });

  it("rejects an empty merge and a member used two times", async () => {
    for (const merged of [
      [],
      [
        { member_index: 0, claim: "c", explanation: "e", severity: "nit" as const },
        { member_index: 0, claim: "d", explanation: "e", severity: "nit" as const },
      ],
    ]) {
      const fake = createFakeSdkClient(() => ok({ merged }));
      const out = await mergeFindings(
        fake,
        OPTIONS,
        [
          { finding: finding(3, 5), result: result(95, "blocking") },
          { finding: finding(4, 9), result: result(81, "blocking") },
        ],
        ctx(),
      );
      expect(out.posted).toHaveLength(2);
      expect(out.merges[0]?.rejected).toBeTruthy();
    }
  });

  it("keeps two distinct issues in one group apart", async () => {
    const fake = createFakeSdkClient(() =>
      ok({
        merged: [
          { member_index: 0, claim: "first issue", explanation: "e", severity: "blocking" },
          { member_index: 1, claim: "second issue", explanation: "e", severity: "suggestion" },
        ],
      }),
    );
    const out = await mergeFindings(
      fake,
      OPTIONS,
      [
        { finding: finding(3, 5), result: result(95, "blocking") },
        { finding: finding(4, 9), result: result(81, "blocking") },
        { finding: finding(5, 5), result: result(80, "nit") },
      ],
      ctx(),
    );
    expect(out.posted.map((p) => p.claim)).toEqual(["first issue", "second issue"]);
    expect(out.merges[0]?.rejected).toBeUndefined();
  });

  it("posts the members unmerged when the merge query fails, and records the failure", async () => {
    const failure = { kind: "no-structured-output" as const, message: "no output" };
    const fake = createFakeSdkClient(() => ({ ok: false, failure, raw: META }));
    const out = await mergeFindings(
      fake,
      OPTIONS,
      [
        { finding: finding(3, 5), result: result(95, "blocking") },
        { finding: finding(4, 9), result: result(81, "blocking") },
      ],
      ctx(),
    );
    expect(out.posted).toHaveLength(2);
    expect(out.merges).toEqual([{ group: [0, 1], result: failure }]);
  });

  it("treats a member index outside the group as a failed query", async () => {
    const fake = createFakeSdkClient(() =>
      ok({ merged: [{ member_index: 2, claim: "c", explanation: "e", severity: "nit" }] }),
    );
    const out = await mergeFindings(
      fake,
      OPTIONS,
      [
        { finding: finding(3, 5), result: result(95, "blocking") },
        { finding: finding(4, 9), result: result(81, "blocking") },
      ],
      ctx(),
    );
    expect(out.posted).toHaveLength(2);
    expect(out.merges[0]?.result).toMatchObject({ kind: "out-of-range" });
  });

  it("sends the merge prompt with the members in an untrusted block", async () => {
    const fake = createFakeSdkClient(() =>
      ok({ merged: [{ member_index: 0, claim: "c", explanation: "e", severity: "blocking" }] }),
    );
    await mergeFindings(
      fake,
      OPTIONS,
      [
        { finding: finding(3, 5, { claim: "MEMBER-A" }), result: result(95, "blocking") },
        { finding: finding(4, 9, { claim: "MEMBER-B" }), result: result(81, "blocking") },
      ],
      ctx(),
    );
    const call = fake.calls[0] as QueryRequest;
    const prompt = loadPrompt("merge.md");
    expect(call.role).toBe("merge");
    expect(call.schema).toBe(MergeOutputSchema);
    expect(call.systemPrompt).toBe(prompt.body);
    expect(call.systemPrompt).toContain(UNTRUSTED_SYSTEM_LINE);
    expect(call.systemPrompt.trimEnd().endsWith(THINK_LINE)).toBe(true);
    expect(call.userMessage).toMatch(/<findings_[0-9a-f]{16}>/);
    expect(call.userMessage.indexOf("MEMBER-A")).toBeLessThan(call.userMessage.indexOf("MEMBER-B"));
  });

  it("ranks by severity, then by score", async () => {
    const out = await mergeFindings(
      noMergeClient(),
      OPTIONS,
      [
        { finding: finding(1, 1), result: result(85, "nit") },
        { finding: finding(3, 3), result: result(80, "blocking") },
        { finding: finding(5, 5), result: result(99, "suggestion") },
        { finding: finding(7, 7), result: result(95, "blocking") },
        { finding: finding(9, 9), result: result(81, "suggestion") },
      ],
      ctx(),
    );
    expect(out.posted.map((p) => [p.severity, p.score])).toEqual([
      ["blocking", 95],
      ["blocking", 80],
      ["suggestion", 99],
      ["suggestion", 81],
      ["nit", 85],
    ]);
  });

  it("caps non-blocking findings and keeps the overflow in capped", async () => {
    const verified = Array.from({ length: 6 }, (_, i) => ({
      finding: finding(i * 2 + 1, i * 2 + 1),
      result: result(90 - i, i < 3 ? ("suggestion" as const) : ("nit" as const)),
    }));
    const out = await mergeFindings(noMergeClient(), OPTIONS, verified, ctx(1));
    expect(nonBlockingCap(1)).toBe(4);
    expect(out.posted.map((p) => p.severity)).toEqual([
      "suggestion",
      "suggestion",
      "suggestion",
      "nit",
    ]);
    expect(out.capped.map((p) => p.severity)).toEqual(["nit", "nit"]);
  });

  it("uses the caps that the run gives", async () => {
    const verified = Array.from({ length: 4 }, (_, i) => ({
      finding: finding(i * 2 + 1, i * 2 + 1),
      result: result(90 - i, "nit" as const),
    }));
    const caps = { non_blocking_base: 0, non_blocking_per_hunks: 4, non_blocking_max: 20 };
    const out = await mergeFindings(noMergeClient(), OPTIONS, verified, { ...ctx(1), caps });
    expect(out.posted).toHaveLength(1);
    expect(out.capped).toHaveLength(3);
  });
});

describe("cap", () => {
  it("is 3 + ceil(hunks / 4), at most 20", () => {
    expect(nonBlockingCap(0)).toBe(3);
    expect(nonBlockingCap(1)).toBe(4);
    expect(nonBlockingCap(4)).toBe(4);
    expect(nonBlockingCap(5)).toBe(5);
    expect(nonBlockingCap(20)).toBe(8);
    expect(nonBlockingCap(68)).toBe(20);
    expect(nonBlockingCap(69)).toBe(20);
    expect(nonBlockingCap(10_000)).toBe(20);
  });

  it("takes the base, the hunks per step and the maximum from the repo config", () => {
    expect(nonBlockingCap(0, DEFAULT_CAPS)).toBe(3);
    expect(DEFAULT_CAPS).toEqual(DEFAULT_REPO_CONFIG.caps);
    const caps = { non_blocking_base: 1, non_blocking_per_hunks: 2, non_blocking_max: 5 };
    expect(nonBlockingCap(0, caps)).toBe(1);
    expect(nonBlockingCap(1, caps)).toBe(2);
    expect(nonBlockingCap(4, caps)).toBe(3);
    expect(nonBlockingCap(100, caps)).toBe(5);
    expect(nonBlockingCap(3, { ...caps, non_blocking_base: 0 })).toBe(2);
  });

  function posted(severity: Severity, score: number, n: number): PostedFinding {
    const f = finding(n, n);
    return { ...f, fingerprint: `fp${n}`, severity, score, verifier: result(score, severity) };
  }

  it("fills suggestions before nits", () => {
    const ranked = [
      posted("suggestion", 90, 1),
      posted("suggestion", 85, 2),
      posted("nit", 99, 3),
      posted("nit", 95, 4),
    ];
    const out = applyCap(ranked, 3);
    expect(out.posted.map((p) => p.start_line)).toEqual([1, 2, 3]);
    expect(out.capped.map((p) => p.start_line)).toEqual([4]);
  });

  it("puts suggestions first even when the input lists a nit first", () => {
    const out = applyCap([posted("nit", 99, 1), posted("suggestion", 80, 2)], 1);
    expect(out.posted.map((p) => p.start_line)).toEqual([2]);
    expect(out.capped.map((p) => p.start_line)).toEqual([1]);
  });

  it("never caps blocking findings", () => {
    const blocking = Array.from({ length: 25 }, (_, i) => posted("blocking", 90, i + 1));
    const out = applyCap([...blocking, posted("suggestion", 90, 30), posted("nit", 90, 31)], 1);
    expect(out.posted).toHaveLength(26);
    expect(out.posted.filter((p) => p.severity === "blocking")).toHaveLength(25);
    expect(out.capped.map((p) => p.severity)).toEqual(["nit"]);
  });

  it("caps at the limit exactly", () => {
    const items = Array.from({ length: 5 }, (_, i) => posted("suggestion", 90 - i, i + 1));
    expect(applyCap(items, 5).capped).toEqual([]);
    expect(applyCap(items, 4).capped.map((p) => p.start_line)).toEqual([5]);
    expect(applyCap(items, 0).posted).toEqual([]);
  });
});

describe("applySuppressions (R3)", () => {
  const item = (reviewer: string, overrides: Partial<Finding> = {}) => ({
    reviewer,
    finding: finding(5, 5, overrides),
  });
  const items = [
    item("diff-bugs"),
    item("security", { category: "security" }),
    item("conventions", { category: "convention", file: "docs/guide.md" }),
    item("tests", { category: "test", file: "test/a.test.ts" }),
  ];

  it("keeps every finding when there are no rules", () => {
    expect(applySuppressions(items, [])).toEqual({ kept: items, suppressed: [] });
  });

  it("matches the reviewer name alone", () => {
    const rule: Suppression = { reviewer: "security", reason: "owned elsewhere" };
    const out = applySuppressions(items, [rule]);
    expect(out.kept.map((i) => i.reviewer)).toEqual(["diff-bugs", "conventions", "tests"]);
    expect(out.suppressed).toEqual([{ ...items[1], rule }]);
  });

  it("matches the category alone", () => {
    const rule: Suppression = { category: "convention", reason: "the linter owns it" };
    const out = applySuppressions(items, [rule]);
    expect(out.suppressed.map((i) => i.reviewer)).toEqual(["conventions"]);
    expect(out.kept).toHaveLength(3);
  });

  it("matches the path as a glob against the file of the finding", () => {
    const rule: Suppression = { path: "docs/**", reason: "drafts" };
    const out = applySuppressions(items, [rule]);
    expect(out.suppressed.map((i) => i.finding.file)).toEqual(["docs/guide.md"]);
    const star: Suppression = { path: "**/*.test.ts", reason: "tests" };
    expect(applySuppressions(items, [star]).suppressed.map((i) => i.reviewer)).toEqual(["tests"]);
  });

  it("needs every key that the rule gives", () => {
    const rule: Suppression = { reviewer: "diff-bugs", category: "security", reason: "r" };
    expect(applySuppressions(items, [rule])).toEqual({ kept: items, suppressed: [] });
    const both: Suppression = { reviewer: "security", category: "security", reason: "r" };
    expect(applySuppressions(items, [both]).suppressed).toEqual([{ ...items[1], rule: both }]);
  });

  it("uses the first rule that matches, and keeps the order of the findings", () => {
    const first: Suppression = { category: "security", reason: "first" };
    const second: Suppression = { reviewer: "security", reason: "second" };
    const out = applySuppressions(items, [first, second]);
    expect(out.suppressed).toEqual([{ ...items[1], rule: first }]);
    expect(out.kept).toEqual([items[0], items[2], items[3]]);
  });
});
