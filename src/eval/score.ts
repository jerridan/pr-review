// Score the posted findings and the raw candidates of one run record
// against the golden findings of its case: exact matches first, then the
// judge on the ambiguous pairs. The posted goldens go first. The not-real
// goldens then take the posted findings that are still free. The raw
// candidates go to the posted goldens only, with exact matches only unless
// the caller asks for the raw judge. With extras on, the extras judge then
// checks each posted finding that matches no golden.
import { z } from "zod";
import { readHeadFile } from "../find/evidence.js";
import { diffSections } from "../gather/diff.js";
import { prDiff } from "../gather/index.js";
import { loadPrompt, render, type PromptFile } from "../prompts/load.js";
import type { Finding } from "../schemas/finding.js";
import { ciEnum } from "../schemas/json-schema.js";
import { JudgeOutputSchema, type JudgeOutput } from "../schemas/judge.js";
import type { RunRecord } from "../schemas/record.js";
import type { SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import { wrapUntrusted } from "../untrusted.js";
import { isPostedGolden, type GoldenFinding } from "./case.js";
import { readPolicy } from "./label/policy.js";
import { classifyPair, type PairKind } from "./match.js";

/** The answer of the extras judge for one posted finding that matches no golden. */
export type ExtrasOutput = { real: "yes" | "no" | "unknown"; reason: string };

export const ExtrasOutputSchema: z.ZodType<ExtrasOutput> = z.strictObject({
  real: ciEnum(["yes", "no", "unknown"] as const),
  reason: z.string(),
});

export type ScoreResult = {
  /** The matches to posted goldens. A match to a not-real golden is not here. */
  matched: Match[];
  /** The queries of both judges. */
  judgeCalls: number;
  /** The unknown answers of the match judge only. */
  judgeUnknown: number;
  /** The cost of both judges. */
  judgeCostUsd: number;
  /** Over the matches to posted goldens only. */
  severityAgreement: { same: number; matched: number };
  /** The posted findings that match a not-real golden. Each is a false positive. */
  notRealMatches: number;
  /** The goldens with blocking, suggestion or nit. */
  postedGoldenCount: number;
  /**
   * The score of the raw candidates: the reviewer findings, with the same
   * file, span and claim collapsed into one. They match the posted goldens
   * only, because raw recall counts nothing else. Without "rawJudge", a
   * match is exact, or uses a "yes" that the posted pass got for the same
   * judge text. "posted" in a match is an index into that list.
   * "candidates" is its length.
   */
  raw: { matched: Match[]; candidates: number };
  /**
   * The extras judge. "enabled" is false when the caller did not ask for
   * it. "judged" is the count of queries. "accepted" holds the indices of
   * the posted findings with the answer "yes". "unknown" counts the
   * unknown answers, also a failed query.
   */
  extras: { enabled: boolean; judged: number; accepted: number[]; unknown: number };
};

type Match = { posted: number; golden: number; via: "exact" | "judge" };

/** prompts/judge.md, loaded: the system prompt and the user message texts. */
type JudgePrompt = { system: string; template: string; noSpanText: string };

/** prompts/extras-judge.md, loaded. */
type ExtrasPrompt = JudgePrompt & { noDiffText: string };

function field(prompt: PromptFile, file: string, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/${file} has no "${name}" string in its frontmatter.`);
  }
  return value;
}

function loadJudgePrompt(): JudgePrompt {
  const prompt = loadPrompt("judge.md");
  return {
    system: prompt.body,
    template: field(prompt, "judge.md", "user_message"),
    noSpanText: field(prompt, "judge.md", "no_span_text"),
  };
}

function loadExtrasPrompt(): ExtrasPrompt {
  const file = "extras-judge.md";
  const prompt = loadPrompt(file);
  return {
    system: prompt.body,
    template: field(prompt, file, "user_message"),
    noSpanText: field(prompt, file, "no_span_text"),
    noDiffText: field(prompt, file, "no_diff_text"),
  };
}

/** The lines of context that the extras judge gets above and below a span. */
const EXTRAS_WINDOW = 20;

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
 * The identity of a finding for a dedupe: its file, its span and its
 * claim. The raw candidates and candidates.json use it.
 */
export function findingKey(f: Pick<Finding, "file" | "start_line" | "end_line" | "claim">): string {
  return JSON.stringify([f.file, f.start_line, f.end_line, f.claim]);
}

/**
 * The raw candidates of a record: the findings of every reviewer entry, in
 * record order. Two findings with the same file, span and claim collapse
 * into the first one.
 */
function rawCandidates(record: RunRecord): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const entry of record.stages.reviewers) {
    for (const f of entry.findings) {
      const key = findingKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/**
 * Score "record" against "golden". The posted findings and the raw
 * candidates each get their own matching. In one matching, each finding
 * and each golden finding is in at most one match. The pairs go in the
 * order of the findings, then of the golden findings. The posted goldens
 * go first: all exact matches, then the judge. The posted findings that
 * are still free then go to the not-real goldens in the same two steps. So
 * a posted golden wins over a not-real golden. The raw candidates go to
 * the posted goldens only, because raw recall counts nothing else. The
 * raw candidates are many, so by default the raw matching sends no judge
 * query. It takes the exact matches, and an ambiguous pair only when the
 * posted pass already got "yes" for the same judge text and golden. With
 * "rawJudge" on, it also asks the judge. The judge gets one query for each
 * ambiguous pair in which neither finding has a match yet. Only the answer
 * "yes" is a match. A failed query counts as "unknown". The two matchings
 * share the judge answers: a pair with the same judge text and the same
 * golden gets one query only. With "extras"
 * on, each posted finding that matches no golden then gets one query of
 * the extras judge. Extras are off by default. An unknown answer of the
 * extras judge counts in "extras.unknown", not in "judgeUnknown".
 */
export async function scoreRecord(
  record: RunRecord,
  golden: GoldenFinding[],
  headDir: string,
  judge: { client: SdkClient; model: string; options: RunOptions },
  opts: { extras?: boolean; rawJudge?: boolean } = {},
): Promise<ScoreResult> {
  const postedGolden = golden.map(isPostedGolden);

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

  // One judge query of either judge. It adds the cost. A failed query or a
  // query that throws gives "unknown". "pick" takes the answer from the
  // output.
  const queryJudge = async <T, A extends string>(
    system: string,
    userMessage: string,
    schema: z.ZodType<T>,
    pick: (output: T) => A,
  ): Promise<A | "unknown"> => {
    judgeCalls += 1;
    try {
      const outcome = await judge.client.query<T>(
        {
          role: "judge",
          systemPrompt: system,
          userMessage,
          schema,
          cwd: headDir,
          overrides: { model: judge.model },
        },
        judge.options,
      );
      judgeCostUsd += outcome.raw?.costUsd ?? 0;
      return outcome.ok ? pick(outcome.output) : "unknown";
    } catch {
      return "unknown";
    }
  };

  const query = async (p: Finding, g: GoldenFinding): Promise<JudgeOutput["same_issue"]> => {
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
    return queryJudge(
      prompt.system,
      render(prompt.template, blocks),
      JudgeOutputSchema,
      (out) => out.same_issue,
    );
  };

  // The judge sees the same text for two findings with the same
  // describePosted text, so their answer for one golden is the same.
  const answers = new Map<string, JudgeOutput["same_issue"]>();
  const keyOf = (p: Finding, g: number): string => `${describePosted(p)}\u0000${g}`;
  const ask = async (p: Finding, g: number): Promise<JudgeOutput["same_issue"]> => {
    const key = keyOf(p, g);
    const known = answers.get(key);
    if (known !== undefined) return known;
    const goldenFinding = golden[g];
    if (!goldenFinding) return "no";
    const answer = await query(p, goldenFinding);
    if (answer === "unknown") judgeUnknown += 1;
    answers.set(key, answer);
    return answer;
  };

  // Match "findings" to the goldens: the posted goldens first, then, when
  // "notReal" is true, the not-real goldens. Each step does exact matches
  // first and then the ambiguous pairs. When "useJudge" is true, the judge
  // answers them. When it is false, only an answer that the cache already
  // holds can match, and no new query goes out.
  const matchAll = async (
    findings: Finding[],
    notReal: boolean,
    useJudge: boolean,
  ): Promise<{ matched: Match[]; notRealMatches: number; taken: Set<number> }> => {
    const kinds: PairKind[][] = findings.map((p) => golden.map((g) => classifyPair(p, g)));
    const matched: Match[] = [];
    let notRealMatches = 0;
    const taken = new Set<number>();
    const goldenTaken = new Set<number>();
    const free = (p: number, g: number): boolean => !taken.has(p) && !goldenTaken.has(g);
    const take = (p: number, g: number, via: "exact" | "judge"): void => {
      if (postedGolden[g]) matched.push({ posted: p, golden: g, via });
      else notRealMatches += 1;
      taken.add(p);
      goldenTaken.add(g);
    };
    // Every free pair of one kind whose golden posts or not, in order.
    const pairsOf = (kind: PairKind, posts: boolean): [number, number][] =>
      kinds.flatMap((row, p) =>
        row.flatMap((k, g): [number, number][] =>
          k === kind && postedGolden[g] === posts && free(p, g) ? [[p, g]] : [],
        ),
      );
    for (const posts of notReal ? [true, false] : [true]) {
      for (const [p, g] of maximumMatching(findings.length, pairsOf("exact", posts))) {
        take(p, g, "exact");
      }
      for (const [p, g] of pairsOf("ambiguous", posts)) {
        const finding = findings[p];
        if (!free(p, g) || !finding) continue;
        // Without the judge, only a cached answer can match: no new query.
        const answer = useJudge ? await ask(finding, g) : answers.get(keyOf(finding, g));
        if (answer === "yes") take(p, g, "judge");
      }
    }
    return { matched, notRealMatches, taken };
  };

  const posted = record.posted.findings;
  const fromPosted = await matchAll(posted, true, true);
  const candidates = rawCandidates(record);
  const fromRaw = await matchAll(candidates, false, opts.rawJudge === true);

  // The posted findings that match no golden at all. A not-real match is
  // not here.
  const unmatchedPosted = posted.flatMap((_, p) => (fromPosted.taken.has(p) ? [] : [p]));

  // The extras judge: one query for each posted finding with no golden.
  const enabled = opts.extras === true;
  const accepted: number[] = [];
  let judged = 0;
  let extrasUnknown = 0;
  if (enabled && unmatchedPosted.length > 0) {
    const extras = loadExtrasPrompt();
    // The diff of the change, split by file once. A git failure gives no diff.
    const sections = await prDiff(headDir, record.identity.base, record.identity.head).then(
      diffSections,
      () => new Map<string, string>(),
    );
    const policy = readPolicy().trim();
    for (const p of unmatchedPosted) {
      const finding = posted[p];
      if (!finding) continue;
      judged += 1;
      const section = (sections.get(finding.file) ?? "").trim();
      const blocks = {
        posted_finding: wrapUntrusted("posted_finding", describePosted(finding)).block,
        posted_span: wrapUntrusted(
          "posted_span",
          spanText(
            linesOf(finding.file),
            Math.max(1, finding.start_line - EXTRAS_WINDOW),
            finding.end_line + EXTRAS_WINDOW,
            extras.noSpanText,
          ),
        ).block,
        diff: wrapUntrusted("diff", section === "" ? extras.noDiffText : section).block,
        policy: wrapUntrusted("policy", policy).block,
      };
      const answer = await queryJudge(
        extras.system,
        render(extras.template, blocks),
        ExtrasOutputSchema,
        (out) => out.real,
      );
      if (answer === "yes") accepted.push(p);
      else if (answer === "unknown") extrasUnknown += 1;
    }
  }

  const { matched } = fromPosted;
  const same = matched.filter((m) => posted[m.posted]?.severity === golden[m.golden]?.severity);
  return {
    matched,
    judgeCalls,
    judgeUnknown,
    judgeCostUsd,
    severityAgreement: { same: same.length, matched: matched.length },
    notRealMatches: fromPosted.notRealMatches,
    postedGoldenCount: postedGolden.filter(Boolean).length,
    raw: {
      matched: fromRaw.matched,
      candidates: candidates.length,
    },
    extras: { enabled, judged, accepted, unknown: extrasUnknown },
  };
}
