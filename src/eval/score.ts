// Score the posted findings of one run record against the golden findings
// of its case: exact matches first, then the judge on the ambiguous pairs.
import { readHeadFile } from "../find/evidence.js";
import { loadPrompt, render, type PromptFile } from "../prompts/load.js";
import type { Finding } from "../schemas/finding.js";
import { JudgeOutputSchema, type JudgeOutput } from "../schemas/judge.js";
import type { RunRecord } from "../schemas/record.js";
import type { SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import { wrapUntrusted } from "../untrusted.js";
import type { GoldenFinding } from "./case.js";
import { classifyPair, type PairKind } from "./match.js";

export type ScoreResult = {
  matched: { posted: number; golden: number; via: "exact" | "judge" }[];
  judgeCalls: number;
  judgeUnknown: number;
  judgeCostUsd: number;
  severityAgreement: { same: number; matched: number };
};

/** prompts/judge.md, loaded: the system prompt and the user message texts. */
type JudgePrompt = { system: string; template: string; noSpanText: string };

function field(prompt: PromptFile, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/judge.md has no "${name}" string in its frontmatter.`);
  }
  return value;
}

function loadJudgePrompt(): JudgePrompt {
  const prompt = loadPrompt("judge.md");
  return {
    system: prompt.body,
    template: field(prompt, "user_message"),
    noSpanText: field(prompt, "no_span_text"),
  };
}

/**
 * The numbered lines of a head file from "start" to "end". The text for no
 * span when the file is missing or the span starts after its last line.
 */
function spanText(lines: string[] | null, start: number, end: number, noSpanText: string): string {
  if (lines === null || start > lines.length) return noSpanText;
  const last = Math.min(end, lines.length);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = start; n <= last; n++) {
    out.push(`${String(n).padStart(width)}| ${lines[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

// The judge sees the location, the category, the claim and the evidence of
// the posted finding. It does not see the severity, the explanation, the
// fix or the verifier result.
function describePosted(f: Finding): string {
  const shown = {
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    category: f.category,
    claim: f.claim,
    evidence: f.evidence,
  };
  return JSON.stringify(shown, null, 2);
}

// The judge does not see the severity or the note of the golden finding.
function describeGolden(g: GoldenFinding): string {
  const shown = {
    file: g.file,
    start_line: g.start_line,
    end_line: g.end_line,
    category: g.category,
    claim: g.claim,
  };
  return JSON.stringify(shown, null, 2);
}

/**
 * A maximum matching of the pairs, by augmenting paths. Each posted finding
 * goes in index order and tries its goldens in index order. A golden that
 * is taken tries to move its posted finding to another free golden. So the
 * result has the most pairs, and the same input always gives the same
 * pairs. The pairs come back in posted order.
 */
function maximumMatching(postedCount: number, pairs: [number, number][]): [number, number][] {
  const goldensOf: number[][] = Array.from({ length: postedCount }, () => []);
  for (const [p, g] of pairs) goldensOf[p]?.push(g);
  const ownerOf = new Map<number, number>();
  const augment = (p: number, seen: Set<number>): boolean => {
    for (const g of goldensOf[p] ?? []) {
      if (seen.has(g)) continue;
      seen.add(g);
      const owner = ownerOf.get(g);
      if (owner === undefined || augment(owner, seen)) {
        ownerOf.set(g, p);
        return true;
      }
    }
    return false;
  };
  for (let p = 0; p < postedCount; p++) augment(p, new Set());
  return [...ownerOf.entries()]
    .map(([g, p]): [number, number] => [p, g])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Score "record" against "golden". Each posted finding and each golden
 * finding is in at most one match. The pairs go in the order of the posted
 * findings, then of the golden findings. All exact matches come first. The
 * judge then gets one query for each ambiguous pair in which neither
 * finding has a match yet. Only the answer "yes" is a match. A failed
 * query counts as "unknown".
 */
export async function scoreRecord(
  record: RunRecord,
  golden: GoldenFinding[],
  headDir: string,
  judge: { client: SdkClient; model: string; options: RunOptions },
): Promise<ScoreResult> {
  const posted = record.posted.findings;
  const kinds: PairKind[][] = posted.map((p) => golden.map((g) => classifyPair(p, g)));
  const matched: ScoreResult["matched"] = [];
  const postedMatched = new Set<number>();
  const goldenMatched = new Set<number>();
  const free = (p: number, g: number): boolean => !postedMatched.has(p) && !goldenMatched.has(g);
  const take = (p: number, g: number, via: "exact" | "judge"): void => {
    matched.push({ posted: p, golden: g, via });
    postedMatched.add(p);
    goldenMatched.add(g);
  };

  // Walk every pair of one kind, in order.
  const pairsOf = (kind: PairKind): [number, number][] =>
    kinds.flatMap((row, p) =>
      row.flatMap((k, g): [number, number][] => (k === kind ? [[p, g]] : [])),
    );

  for (const [p, g] of maximumMatching(posted.length, pairsOf("exact"))) take(p, g, "exact");

  let judgeCalls = 0;
  let judgeUnknown = 0;
  let judgeCostUsd = 0;
  let prompt: JudgePrompt | null = null;
  const fileLines = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    if (!fileLines.has(file)) {
      const text = readHeadFile(headDir, file);
      const lines = text === null ? null : text.split("\n");
      if (lines !== null && lines.at(-1) === "") lines.pop();
      fileLines.set(file, lines);
    }
    return fileLines.get(file) ?? null;
  };

  const ask = async (p: Finding, g: GoldenFinding): Promise<JudgeOutput["same_issue"]> => {
    prompt ??= loadJudgePrompt();
    const blocks = {
      posted_finding: wrapUntrusted("posted_finding", describePosted(p)).block,
      posted_span: wrapUntrusted(
        "posted_span",
        spanText(linesOf(p.file), p.start_line, p.end_line, prompt.noSpanText),
      ).block,
      golden_finding: wrapUntrusted("golden_finding", describeGolden(g)).block,
      golden_span: wrapUntrusted(
        "golden_span",
        spanText(linesOf(g.file), g.start_line, g.end_line, prompt.noSpanText),
      ).block,
    };
    try {
      const outcome = await judge.client.query<JudgeOutput>(
        {
          role: "judge",
          systemPrompt: prompt.system,
          userMessage: render(prompt.template, blocks),
          schema: JudgeOutputSchema,
          cwd: headDir,
          overrides: { model: judge.model },
        },
        judge.options,
      );
      judgeCostUsd += outcome.raw?.costUsd ?? 0;
      return outcome.ok ? outcome.output.same_issue : "unknown";
    } catch {
      return "unknown";
    }
  };

  for (const [p, g] of pairsOf("ambiguous")) {
    if (!free(p, g)) continue;
    const postedFinding = posted[p];
    const goldenFinding = golden[g];
    if (!postedFinding || !goldenFinding) continue;
    judgeCalls += 1;
    const answer = await ask(postedFinding, goldenFinding);
    if (answer === "yes") take(p, g, "judge");
    else if (answer === "unknown") judgeUnknown += 1;
  }

  const same = matched.filter((m) => posted[m.posted]?.severity === golden[m.golden]?.severity);
  return {
    matched,
    judgeCalls,
    judgeUnknown,
    judgeCostUsd,
    severityAgreement: { same: same.length, matched: matched.length },
  };
}
