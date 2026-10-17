import { describe, expect, it } from "vitest";
import type { GoldenFinding } from "../src/eval/case.js";
import { classifyPair } from "../src/eval/match.js";
import type { Category, Finding } from "../src/schemas/finding.js";

function posted(file: string, start: number, end: number, category: Category = "bug"): Finding {
  return {
    file,
    start_line: start,
    end_line: end,
    category,
    severity_estimate: "blocking",
    confidence: "high",
    claim: "c",
    evidence: "e",
    explanation: "x",
    needs_context: false,
  };
}

function golden(
  file: string,
  start: number,
  end: number,
  category: Category = "bug",
): GoldenFinding {
  return { file, start_line: start, end_line: end, category, severity: "blocking", claim: "g" };
}

describe("classifyPair (R4.2)", () => {
  it("gives exact for the same file, overlapping spans and the same category", () => {
    expect(classifyPair(posted("a.ts", 10, 14), golden("a.ts", 12, 20))).toBe("exact");
  });

  it("gives exact for spans that share only one line", () => {
    expect(classifyPair(posted("a.ts", 10, 12), golden("a.ts", 12, 12))).toBe("exact");
    expect(classifyPair(posted("a.ts", 12, 15), golden("a.ts", 9, 12))).toBe("exact");
  });

  it("gives exact when one span holds the other", () => {
    expect(classifyPair(posted("a.ts", 13, 13), golden("a.ts", 10, 20))).toBe("exact");
  });

  it("gives ambiguous for overlapping spans with another category", () => {
    expect(classifyPair(posted("a.ts", 10, 14, "security"), golden("a.ts", 12, 20))).toBe(
      "ambiguous",
    );
  });

  it("gives ambiguous for spans 10 lines apart with the same category", () => {
    // The distance is the start of the later span minus the end of the earlier span.
    expect(classifyPair(posted("a.ts", 30, 32), golden("a.ts", 15, 20))).toBe("ambiguous");
    expect(classifyPair(posted("a.ts", 15, 20), golden("a.ts", 30, 32))).toBe("ambiguous");
  });

  it("gives ambiguous for adjacent spans that do not overlap", () => {
    expect(classifyPair(posted("a.ts", 5, 9), golden("a.ts", 10, 12))).toBe("ambiguous");
  });

  it("gives ambiguous for spans 10 lines apart with another category", () => {
    expect(classifyPair(posted("a.ts", 30, 32, "test"), golden("a.ts", 15, 20))).toBe("ambiguous");
  });

  it("gives none for spans 11 lines apart", () => {
    expect(classifyPair(posted("a.ts", 31, 32), golden("a.ts", 15, 20))).toBe("none");
    expect(classifyPair(posted("a.ts", 15, 20), golden("a.ts", 31, 32))).toBe("none");
  });

  it("gives none for another file, also when the spans and the category are equal", () => {
    expect(classifyPair(posted("a.ts", 10, 14), golden("b.ts", 10, 14))).toBe("none");
  });
});
