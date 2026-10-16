import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareBaseline,
  readBaseline,
  writeBaseline,
  type Baseline,
} from "../src/eval/baseline.js";
import type { RepeatMetrics } from "../src/eval/metrics.js";
import { buildReport, type Report } from "../src/eval/report.js";

const work = mkdtempSync(join(tmpdir(), "pr-review-eval-baseline-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let fileCount = 0;
function path(): string {
  fileCount += 1;
  return join(work, `baseline-${fileCount}.json`);
}

function baseline(parts: Partial<Baseline> = {}): Baseline {
  return {
    recall: 0.75,
    precision: 0.75,
    margin: { recall: 0.25, precision: 0.25 },
    cases_ref: null,
    repeat: 3,
    written_at: "2026-10-16T12:00:00.000Z",
    tool_version: "0.1.0",
    ...parts,
  };
}

function repeat(n: number, recall: number | null, precision: number | null): RepeatMetrics {
  return {
    repeat: n,
    failed: false,
    error: null,
    recall,
    precision,
    posted: 2,
    cost_usd: 0.1,
    run_ms: 1,
    judge_calls: 0,
    judge_unknown: 0,
    judge_cost_usd: 0,
    severity_agreement: { same: 0, matched: 0 },
  };
}

/** A report whose aggregate mean recall and precision are the values given. */
function report(
  recall: number | null,
  precision: number | null,
  ref: string | null = null,
): Report {
  return buildReport([{ name: "a-case", repeats: [repeat(1, recall, precision)] }], null, ref);
}

describe("readBaseline (R6.2)", () => {
  it("reads a valid file", async () => {
    const file = path();
    writeFileSync(file, JSON.stringify(baseline()));
    await expect(readBaseline(file)).resolves.toEqual(baseline());
  });

  it("throws for a missing file, and names the file", async () => {
    const file = join(work, "no-such-baseline.json");
    await expect(readBaseline(file)).rejects.toThrow(file);
  });

  it.each<[string, string]>([
    ["text that is not JSON", "{ recall: "],
    ["a missing field", JSON.stringify({ ...baseline(), margin: undefined })],
    ["a wrong type", JSON.stringify({ ...baseline(), recall: "high" })],
  ])("throws for %s", async (_label, text) => {
    const file = path();
    writeFileSync(file, text);
    await expect(readBaseline(file)).rejects.toThrow(file);
  });
});

describe("compareBaseline (R6.2, R6.3)", () => {
  it("passes when the recall drop is within the margin", () => {
    expect(compareBaseline(baseline({ recall: 0.75 }), report(0.5, 0.75))).toEqual({
      passed: true,
      recall_drop: 0.25,
      precision_drop: 0,
      margin: { recall: 0.25, precision: 0.25 },
    });
  });

  it("fails when the recall drop is above the margin", () => {
    const gate = compareBaseline(baseline({ recall: 1 }), report(0.5, 0.75));
    expect(gate.passed).toBe(false);
    expect(gate.recall_drop).toBe(0.5);
  });

  it("passes when the precision drop is within the margin", () => {
    const gate = compareBaseline(baseline({ precision: 0.75 }), report(0.75, 0.5));
    expect(gate).toMatchObject({ passed: true, precision_drop: 0.25 });
  });

  it("fails when the precision drop is above the margin", () => {
    const gate = compareBaseline(baseline({ precision: 1 }), report(0.75, 0.5));
    expect(gate).toMatchObject({ passed: false, precision_drop: 0.5, recall_drop: 0 });
  });

  it("passes for a drop equal to the margin also after float error", () => {
    const gate = compareBaseline(
      baseline({ recall: 0.8, precision: 0.8, margin: { recall: 0.05, precision: 0.05 } }),
      report(0.75, 0.75),
    );
    expect(gate.passed).toBe(true);
  });

  it("passes for a rise, with a negative drop", () => {
    const gate = compareBaseline(baseline({ recall: 0.5 }), report(0.75, 0.75));
    expect(gate).toMatchObject({ passed: true, recall_drop: -0.25 });
  });

  it("fails for a null mean, with a null drop", () => {
    const gate = compareBaseline(baseline(), report(0.75, null));
    expect(gate).toMatchObject({ passed: false, precision_drop: null, recall_drop: 0 });
  });
});

describe("writeBaseline (R6.1, R6.5)", () => {
  it("writes the aggregate, the cases ref, the repeat, the time and the version, with margins 0.05", async () => {
    const file = path();
    const before = Date.now();
    await writeBaseline(file, report(0.5, 0.25, "c".repeat(40)), null, {
      repeat: 3,
      tool_version: "9.9.9",
    });
    const written = JSON.parse(readFileSync(file, "utf8")) as Baseline;
    expect(written).toEqual({
      recall: 0.5,
      precision: 0.25,
      margin: { recall: 0.05, precision: 0.05 },
      cases_ref: "c".repeat(40),
      repeat: 3,
      written_at: written.written_at,
      tool_version: "9.9.9",
    });
    expect(Date.parse(written.written_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(written.written_at).toISOString()).toBe(written.written_at);
    await expect(readBaseline(file)).resolves.toEqual(written);
  });

  it("keeps the margin of an existing baseline", async () => {
    const file = path();
    const existing = baseline({ margin: { recall: 0.1, precision: 0.2 } });
    writeFileSync(file, JSON.stringify(existing));
    await writeBaseline(file, report(0.5, 0.5), existing, { repeat: 1, tool_version: "1" });
    const written = JSON.parse(readFileSync(file, "utf8")) as Baseline;
    expect(written.margin).toEqual({ recall: 0.1, precision: 0.2 });
    expect(written.recall).toBe(0.5);
    expect(written.cases_ref).toBeNull();
  });

  it("throws and writes nothing when a mean is null", async () => {
    const file = path();
    await expect(
      writeBaseline(file, report(0.5, null), null, { repeat: 1, tool_version: "1" }),
    ).rejects.toThrow(/precision/);
    expect(() => readFileSync(file)).toThrow();
  });
});
