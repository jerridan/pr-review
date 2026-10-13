import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  diffEvidenceText,
  evidenceMatches,
  lineCount,
  lineRangeValid,
  normalizeFindingPath,
  normalizeWs,
  readHeadFile,
} from "../src/find/evidence.js";
import { runReviewers } from "../src/find/index.js";
import type { GatherResult } from "../src/gather/index.js";
import { loadPrompt } from "../src/prompts/load.js";
import type { ReviewerDefinition } from "../src/reviewers/loader.js";
import type { Finding } from "../src/schemas/finding.js";
import { FindingsOutputSchema } from "../src/schemas/finding.js";
import type { TriageBrief } from "../src/schemas/triage.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import type { RunOptions } from "../src/sdk/options.js";
import { createSemaphore } from "../src/semaphore.js";

const STATS = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let i = 0; i < values.length; i++) {",
  "    total += values[i];",
  "  }",
  "  return total;",
  "}",
  "",
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
  "@@ -7,0 +8,8 @@",
  "+",
  "+export function average(values: number[]): number {",
  "+  let total = 0;",
  "+  for (let i = 0; i <= values.length; i++) {",
  "+    total += values[i];",
  "+  }",
  "+  return total / values.length;",
  "+}",
  "",
].join("\n");

const head = mkdtempSync(join(tmpdir(), "pr-review-find-"));
mkdirSync(join(head, "src"));
writeFileSync(join(head, "src/stats.ts"), STATS);
afterAll(() => rmSync(head, { recursive: true, force: true }));

const GATHERED: GatherResult = {
  base: "a".repeat(40),
  head: "b".repeat(40),
  changedFiles: [{ path: "src/stats.ts", hunks: 1 }],
  excluded: [],
  sensitive: [],
  diff: DIFF,
  totalHunks: 1,
};

const BRIEF: TriageBrief = {
  tier: "full",
  reason: "New logic.",
  confidence: "high",
  categories: ["bug"],
  hotspots: ["HOTSPOT-average-loop"],
  file_notes: [],
  summary: "SUMMARY-adds-average",
};

const OPTIONS: RunOptions = { allowApiKey: false, env: {} };

const META: QueryMeta = {
  model: "claude-opus-5-5",
  durationMs: 5,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/stats.ts",
    start_line: 11,
    end_line: 11,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: "The loop reads one item past the end.",
    evidence: "for (let i = 0; i <= values.length; i++) {",
    explanation: "The bound must be i < values.length.",
    needs_context: false,
    ...overrides,
  };
}

function def(name: string, passes = 1): ReviewerDefinition {
  return {
    path: `/x/${name}.md`,
    systemPrompt: `SYSTEM ${name}`,
    frontmatter: {
      name,
      description: "d",
      model: "opus",
      effort: "low",
      tools: ["Read", "Grep", "Glob"],
      triggers: { paths: [], categories: [], min_tier: "fast" },
      passes,
      threshold: 80,
      trusted: true,
    },
  };
}

const ok = (findings: Finding[]): QueryOutcome<unknown> => ({
  ok: true,
  output: { findings },
  raw: META,
});

function ctx(semaphore = createSemaphore(5)) {
  return { gathered: GATHERED, brief: BRIEF, cwd: head, semaphore };
}

describe("evidence checks", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeWs("  a \n\t b  c\n")).toBe("a b c");
  });

  it("matches a quote in the head file or the diff, after whitespace collapse", () => {
    const stats = normalizeWs(STATS);
    expect(evidenceMatches("for (let i = 0;\n   i <= values.length; i++)", stats, "")).toBe(true);
    expect(evidenceMatches("+  let total = 0;", null, diffEvidenceText(DIFF))).toBe(true);
    expect(evidenceMatches("return total / values.length;", null, diffEvidenceText(DIFF))).toBe(
      true,
    );
  });

  it("is case-sensitive and rejects an empty or invented quote", () => {
    const stats = normalizeWs(STATS);
    const diff = diffEvidenceText(DIFF);
    expect(evidenceMatches("RETURN total / values.length;", stats, diff)).toBe(false);
    expect(evidenceMatches("values.pop()", stats, diff)).toBe(false);
    expect(evidenceMatches("   ", stats, diff)).toBe(false);
  });

  it("takes the added and context lines of a diff section, not removed or header lines", () => {
    const section = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 1111111..2222222 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,3 +1,3 @@ function f() {",
      " CONTEXT-LINE",
      "-REMOVED-LINE",
      "+ADDED-LINE",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const text = diffEvidenceText(section);
    expect(text).toBe(normalizeWs(text));
    expect(text).toContain("CONTEXT-LINE");
    expect(text).toContain("+ADDED-LINE");
    expect(text).not.toContain("REMOVED-LINE");
    expect(text).not.toContain("+++ b/src/x.ts");
    expect(text).not.toContain("--- a/src/x.ts");
    expect(text).not.toContain("@@");
    expect(text).not.toContain("diff --git");
    expect(diffEvidenceText("")).toBe("");
  });

  it("normalizes a finding path, and refuses a path that is absolute or goes up", () => {
    expect(normalizeFindingPath("src/stats.ts")).toBe("src/stats.ts");
    expect(normalizeFindingPath("./src/stats.ts")).toBe("src/stats.ts");
    expect(normalizeFindingPath("././src//stats.ts")).toBe("src/stats.ts");
    expect(normalizeFindingPath("src/./stats.ts")).toBe("src/stats.ts");
    expect(normalizeFindingPath("../src/stats.ts")).toBeNull();
    expect(normalizeFindingPath("src/../../x.ts")).toBeNull();
    expect(normalizeFindingPath("src/../stats.ts")).toBeNull();
    expect(normalizeFindingPath("/etc/hosts")).toBeNull();
    expect(normalizeFindingPath("")).toBeNull();
    expect(normalizeFindingPath("./")).toBeNull();
  });

  it("checks the line range against the head file", () => {
    const lines = lineCount(STATS);
    expect(lines).toBe(15);
    expect(lineRangeValid(finding({ start_line: 1, end_line: 15 }), lines)).toBe(true);
    expect(lineRangeValid(finding({ start_line: 0, end_line: 3 }), lines)).toBe(false);
    expect(lineRangeValid(finding({ start_line: 5, end_line: 4 }), lines)).toBe(false);
    expect(lineRangeValid(finding({ start_line: 14, end_line: 16 }), lines)).toBe(false);
    expect(lineRangeValid(finding({ start_line: 1.5, end_line: 2 }), lines)).toBe(false);
    expect(lineRangeValid(finding(), null)).toBe(false);
  });

  it("reads a head file and refuses a path outside the checkout", () => {
    expect(readHeadFile(head, "src/stats.ts")).toBe(STATS);
    expect(readHeadFile(head, "src/missing.ts")).toBeNull();
    expect(readHeadFile(head, "../../etc/hosts")).toBeNull();
    expect(readHeadFile(head, "/etc/hosts")).toBeNull();
  });
});

describe("runReviewers (A5)", () => {
  it("keeps a valid finding and reports it through onFinding", async () => {
    const fake = createFakeSdkClient(() => ok([finding()]));
    const seen: [Finding, string][] = [];
    const runs = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      ctx(),
      (f, r) => seen.push([f, r]),
    );
    expect(runs).toEqual([
      {
        name: "diff-bugs",
        pass: 1,
        status: "ok",
        findings: [finding()],
        dropped: [],
        meta: META,
      },
    ]);
    expect(seen).toEqual([[finding(), "diff-bugs"]]);
    const call = fake.calls[0] as QueryRequest;
    expect(call.role).toBe("reviewer");
    expect(call.reviewerName).toBe("diff-bugs");
    expect(call.systemPrompt).toBe("SYSTEM diff-bugs");
    expect(call.schema).toBe(FindingsOutputSchema);
    expect(call.cwd).toBe(head);
    expect(call.overrides).toEqual({ model: "claude-opus-5-5", effort: "low" });
    expect(call.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("sends the tools of the reviewer with its query", async () => {
    const narrow = def("narrow");
    narrow.frontmatter.tools = ["Read", "Bash"];
    const fake = createFakeSdkClient(() => ok([]));
    await runReviewers(fake, OPTIONS, [{ def: narrow, trigger: "t" }], ctx(), () => {});
    expect(fake.calls[0]?.tools).toEqual(["Read", "Bash"]);
  });

  it("normalizes the path of a finding once and sends the clean path on", async () => {
    const dotted = finding({ file: "./src/stats.ts" });
    const doubled = finding({ file: "src//stats.ts", start_line: 14, end_line: 14 });
    const fake = createFakeSdkClient(() => ok([dotted, doubled]));
    const seen: Finding[] = [];
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      ctx(),
      (f) => seen.push(f),
    );
    expect(run?.dropped).toEqual([]);
    expect(run?.findings.map((f) => f.file)).toEqual(["src/stats.ts", "src/stats.ts"]);
    expect(seen.map((f) => f.file)).toEqual(["src/stats.ts", "src/stats.ts"]);
  });

  it("drops a finding whose path is absolute or goes up as out of range", async () => {
    const up = finding({ file: "../stats.ts" });
    const upAndBack = finding({ file: "src/../src/stats.ts" });
    const absolute = finding({ file: join(head, "src/stats.ts") });
    const fake = createFakeSdkClient(() => ok([up, upAndBack, absolute]));
    const seen: Finding[] = [];
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      ctx(),
      (f) => seen.push(f),
    );
    expect(run?.findings).toEqual([]);
    expect(run?.dropped).toEqual([
      { finding: up, reason: "out-of-range" },
      { finding: upAndBack, reason: "out-of-range" },
      { finding: absolute, reason: "out-of-range" },
    ]);
    expect(seen).toEqual([]);
  });

  it("matches a diff quote only in the added and context lines of the finding's own file", async () => {
    const other = [
      "diff --git a/src/old.ts b/src/old.ts",
      "--- a/src/old.ts",
      "+++ b/src/old.ts",
      "@@ -1,2 +1,1 @@",
      " OTHER-CONTEXT-LINE();",
      "-REMOVED-ONLY-IN-OLD();",
      "",
    ].join("\n");
    const ownRemoved = [
      "diff --git a/src/stats.ts b/src/stats.ts",
      "--- a/src/stats.ts",
      "+++ b/src/stats.ts",
      "@@ -20,1 +20,0 @@",
      "-REMOVED-FROM-STATS();",
      "",
    ].join("\n");
    const gathered = { ...GATHERED, diff: DIFF + other + ownRemoved };
    const removedOther = finding({ evidence: "REMOVED-ONLY-IN-OLD();" });
    const removedOtherPrefixed = finding({ evidence: "-REMOVED-ONLY-IN-OLD();" });
    const contextOther = finding({ evidence: "OTHER-CONTEXT-LINE();" });
    const removedOwn = finding({ evidence: "REMOVED-FROM-STATS();" });
    const header = finding({ evidence: "+++ b/src/stats.ts" });
    const added = finding({ evidence: "+  let total = 0;" });
    const fake = createFakeSdkClient(() =>
      ok([removedOther, removedOtherPrefixed, contextOther, removedOwn, header, added]),
    );
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      { ...ctx(), gathered },
      () => {},
    );
    expect(run?.dropped).toEqual([
      { finding: removedOther, reason: "bad-quote" },
      { finding: removedOtherPrefixed, reason: "bad-quote" },
      { finding: contextOther, reason: "bad-quote" },
      { finding: removedOwn, reason: "bad-quote" },
      { finding: header, reason: "bad-quote" },
    ]);
    expect(run?.findings).toEqual([added]);
  });

  it("uses the diff sections of the context when the run gives them", async () => {
    const sections = new Map([["src/stats.ts", "@@ -1 +1 @@\n+ONLY-IN-THE-CONTEXT-SECTION\n"]]);
    const quoted = finding({ evidence: "+ONLY-IN-THE-CONTEXT-SECTION" });
    const fake = createFakeSdkClient(() => ok([quoted]));
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      { ...ctx(), sections },
      () => {},
    );
    expect(run?.findings).toEqual([quoted]);
  });

  it("drops a finding with a bad quote and records the drop", async () => {
    const bad = finding({ evidence: "for (let i = 1; i < values.length; i++) {" });
    const fake = createFakeSdkClient(() => ok([bad, finding()]));
    const seen: Finding[] = [];
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      ctx(),
      (f) => seen.push(f),
    );
    expect(run?.findings).toEqual([finding()]);
    expect(run?.dropped).toEqual([{ finding: bad, reason: "bad-quote" }]);
    expect(seen).toEqual([finding()]);
  });

  it("drops a finding out of range, also on a file the head does not have", async () => {
    const past = finding({ start_line: 15, end_line: 99 });
    const missing = finding({ file: "src/nope.ts" });
    const fake = createFakeSdkClient(() => ok([past, missing]));
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      ctx(),
      () => {},
    );
    expect(run?.status).toBe("ok");
    expect(run?.findings).toEqual([]);
    expect(run?.dropped).toEqual([
      { finding: past, reason: "out-of-range" },
      { finding: missing, reason: "out-of-range" },
    ]);
  });

  it("marks the reviewer failed on a refusal stop", async () => {
    const fake = createFakeSdkClient(() => ({
      ok: false,
      failure: { kind: "refusal", message: "The stop reason is refusal." },
      raw: { ...META, stopReason: "refusal" },
    }));
    const seen: Finding[] = [];
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("security"), trigger: "t" }],
      ctx(),
      (f) => seen.push(f),
    );
    expect(run?.status).toBe("failed");
    expect(run?.failure?.kind).toBe("refusal");
    expect(run?.findings).toEqual([]);
    expect(run?.meta?.stopReason).toBe("refusal");
    expect(seen).toEqual([]);
  });

  it("runs every pass, takes the union, and verifies a repeated finding once", async () => {
    const second = finding({
      start_line: 14,
      end_line: 14,
      evidence: "return total / values.length;",
    });
    let call = 0;
    const fake = createFakeSdkClient(() => {
      call += 1;
      return call === 1 ? ok([finding()]) : ok([finding(), second]);
    });
    const seen: Finding[] = [];
    const runs = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs", 2), trigger: "t" }],
      ctx(),
      (f) => seen.push(f),
    );
    expect(fake.calls).toHaveLength(2);
    expect(runs.map((r) => [r.name, r.pass, r.status])).toEqual([
      ["diff-bugs", 1, "ok"],
      ["diff-bugs", 2, "ok"],
    ]);
    const union = runs.flatMap((r) => r.findings);
    expect(union).toContainEqual(finding());
    expect(union).toContainEqual(second);
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(finding());
    expect(seen).toContainEqual(second);
  });

  it("marks the reviewer failed when the second pass fails", async () => {
    let call = 0;
    const fake = createFakeSdkClient(() => {
      call += 1;
      return call === 1
        ? ok([finding()])
        : { ok: false, failure: { kind: "limit", message: "error_max_turns" }, raw: META };
    });
    const runs = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs", 2), trigger: "t" }],
      ctx(),
      () => {},
    );
    expect(runs.map((r) => r.status)).toEqual(["ok", "failed"]);
    expect(runs[1]?.failure).toEqual({ kind: "limit", message: "error_max_turns" });
  });

  it("turns a thrown client error into a failed pass", async () => {
    const fake = createFakeSdkClient(() => {
      throw new Error("spawn failed");
    });
    const [run] = await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      ctx(),
      () => {},
    );
    expect(run).toMatchObject({
      status: "failed",
      failure: { kind: "thrown", message: "spawn failed" },
      meta: null,
    });
  });

  it("holds the brief summary and hotspots before the diff, then the instructions", async () => {
    const fake = createFakeSdkClient(() => ok([]));
    await runReviewers(fake, OPTIONS, [{ def: def("diff-bugs"), trigger: "t" }], ctx(), () => {});
    const message = fake.calls[0]?.userMessage ?? "";
    const summary = message.indexOf("SUMMARY-adds-average");
    const hotspot = message.indexOf("HOTSPOT-average-loop");
    const diff = message.indexOf("+  for (let i = 0; i <= values.length; i++) {");
    expect(summary).toBeGreaterThan(-1);
    expect(hotspot).toBeGreaterThan(-1);
    expect(diff).toBeGreaterThan(summary);
    expect(diff).toBeGreaterThan(hotspot);
    expect(message).toMatch(/<diff_[0-9a-f]{16}>/);
    const tail = message.slice(message.lastIndexOf("</"));
    expect(tail).toMatch(/findings/i);
    const template = loadPrompt("reviewer-user.md");
    expect(template.frontmatter).toMatchObject({ role: "reviewer", kind: "user" });
  });

  it("works without a triage brief", async () => {
    const fake = createFakeSdkClient(() => ok([]));
    await runReviewers(
      fake,
      OPTIONS,
      [{ def: def("diff-bugs"), trigger: "t" }],
      { ...ctx(), brief: null },
      () => {},
    );
    expect(fake.calls[0]?.userMessage).toContain("+  for (let i = 0; i <= values.length; i++) {");
  });

  it("holds the number of queries at once to the semaphore limit", async () => {
    let active = 0;
    let peak = 0;
    const fake = createFakeSdkClient(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return ok([]);
    });
    const selected = ["a", "b", "c"].map((name) => ({ def: def(name, 2), trigger: "t" }));
    const runs = await runReviewers(fake, OPTIONS, selected, ctx(createSemaphore(2)), () => {});
    expect(fake.calls).toHaveLength(6);
    expect(runs).toHaveLength(6);
    expect(peak).toBe(2);
  });
});
