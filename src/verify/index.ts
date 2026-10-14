// Verify: one verifier query per finding, with escalation to a second
// verifier on a middle-band score or when the finding needs context.
import { normalizeWs, readHeadFile } from "../find/evidence.js";
import { diffSections } from "../gather/diff.js";
import { loadPrompt, render, type PromptFile } from "../prompts/load.js";
import type { RepoConfig } from "../config/repo-config.js";
import type { Finding } from "../schemas/finding.js";
import type { QueryFailure } from "../schemas/record.js";
import { VerifierResultSchema, type VerifierResult } from "../schemas/verifier.js";
import type { SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import type { Semaphore } from "../semaphore.js";
import { wrapUntrusted } from "../untrusted.js";

export interface VerifyConfig {
  threshold: number;
  bandLow: number;
  bandHigh: number;
}

export const DEFAULT_VERIFY_CONFIG: VerifyConfig = { threshold: 80, bandLow: 60, bandHigh: 85 };

/**
 * The verify config of one finding: the threshold of its reviewer, and
 * the middle band of the repo config.
 */
export function verifyConfigFor(threshold: number, config: RepoConfig): VerifyConfig {
  const [bandLow, bandHigh] = config.thresholds.middle_band;
  return { threshold, bandLow, bandHigh };
}

export type VerifyContext = {
  cwd: string;
  semaphore: Semaphore;
  config: VerifyConfig;
  /**
   * The diff split per file (see diffSections). The run splits it once and
   * gives it here.
   */
  sections?: Map<string, string>;
  /** The whole diff. It is used only when "sections" is not set. */
  diff?: string;
  /** The verifier prompt. The run loads it once and gives it here. */
  prompt?: VerifierPrompt;
  /**
   * The description of the change. Every verifier query gets it, so the
   * verifier can check a claim about the description. Absent means empty.
   */
  description?: string;
};

export type Verification = {
  first: VerifierResult | QueryFailure;
  escalated?: VerifierResult | QueryFailure;
  final: VerifierResult | null;
  passed: boolean;
  /** Why code failed a final result that the model passed. */
  rejected?: string;
  /**
   * True for a verified pre-existing finding (R6): the first result is out
   * of scope, the claim holds, the score is at or above the threshold, and
   * a quote of the verifier is in the head file. "passed" stays false.
   */
  pre_existing: boolean;
};

// A line number prefix: "  11| " from the user message, "11<tab>" from
// the Read tool, "11:" from the Read tool when the line holds a tab, or
// "  11→" from an earlier Read tool format.
const NUMBER_PREFIX = /^\s*\d+[|→\t:]\s?/;
// A Grep prefix: "path/file.ts:7:".
const GREP_PREFIX = /^[^\s:]+:\d+:\s?/;

/** Remove the line prefix that the message or a tool adds to each line of a quote. */
export function stripLinePrefixes(quote: string): string {
  return quote
    .split("\n")
    .map((line) => line.replace(NUMBER_PREFIX, "").replace(GREP_PREFIX, ""))
    .join("\n");
}

/**
 * Return true when at least one quote is a substring of the head file,
 * after whitespace collapse in both. The quote can match as written, or
 * with its line prefixes removed: a code line such as '  200: "ok",'
 * looks like a prefix, so the removal can change real code. An empty
 * quote never matches.
 */
export function quoteMatches(quotes: string[], headFileText: string | null): boolean {
  if (headFileText === null) return false;
  const file = normalizeWs(headFileText);
  const found = (text: string): boolean => {
    const quote = normalizeWs(text);
    return quote !== "" && file.includes(quote);
  };
  return quotes.some((q) => found(q) || found(stripLinePrefixes(q)));
}

/** True when the value is a failed query, not a verifier result. */
export function isQueryFailure(value: VerifierResult | QueryFailure): value is QueryFailure {
  return "kind" in value;
}

// The verifier does not see which reviewer gave the finding, nor the
// reviewer's own severity and confidence.
function describeFinding(f: Finding): string {
  const shown: Record<string, unknown> = {
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    category: f.category,
    claim: f.claim,
    evidence: f.evidence,
    explanation: f.explanation,
  };
  if (f.suggested_fix !== undefined) shown.suggested_fix = f.suggested_fix;
  return JSON.stringify(shown, null, 2);
}

function numberLines(text: string): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join("\n");
}

/** The texts of prompts/verifier.md that the user message uses. */
export type VerifierTexts = {
  template: string;
  noFileText: string;
  noDiffText: string;
  noDescriptionText: string;
};

function field(prompt: PromptFile, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/verifier.md has no "${name}" string in its frontmatter.`);
  }
  return value;
}

/** Read the user message texts from the frontmatter of the verifier prompt. */
export function verifierTexts(prompt: PromptFile): VerifierTexts {
  return {
    template: field(prompt, "user_message"),
    noFileText: field(prompt, "no_file_text"),
    noDiffText: field(prompt, "no_diff_text"),
    noDescriptionText: field(prompt, "no_description_text"),
  };
}

/** prompts/verifier.md, loaded: the system prompt and the user message texts. */
export type VerifierPrompt = { system: string; texts: VerifierTexts };

/** Load prompts/verifier.md. Throw when the file or a text field is missing. */
export function loadVerifierPrompt(): VerifierPrompt {
  const prompt = loadPrompt("verifier.md");
  return { system: prompt.body, texts: verifierTexts(prompt) };
}

/**
 * Build the verifier user message: the finding, the head file, the
 * description of the change and the file's diff. "text" is the head file,
 * or null when the head has no such file. "fileDiff" is the diff section
 * of the finding's file, or "" when the diff does not change the file.
 */
export function buildVerifierMessage(
  texts: VerifierTexts,
  finding: Finding,
  text: string | null,
  fileDiff: string,
  description = "",
): string {
  const blocks = {
    finding: wrapUntrusted("finding", describeFinding(finding)).block,
    file: wrapUntrusted("head_file", text === null ? texts.noFileText : numberLines(text)).block,
    description: wrapUntrusted(
      "description",
      description.trim() === "" ? texts.noDescriptionText : description,
    ).block,
    diff: wrapUntrusted("diff", fileDiff.trim() === "" ? texts.noDiffText : fileDiff).block,
  };
  return render(texts.template, blocks);
}

function checkRanges(result: VerifierResult): QueryFailure | null {
  if (!Number.isInteger(result.score) || result.score < 0 || result.score > 100) {
    return { kind: "out-of-range", message: `The score ${result.score} is not from 0 to 100.` };
  }
  return null;
}

export async function verifyFinding(
  client: SdkClient,
  options: RunOptions,
  finding: Finding,
  ctx: VerifyContext,
): Promise<Verification> {
  const prompt = ctx.prompt ?? loadVerifierPrompt();
  const sections = ctx.sections ?? diffSections(ctx.diff ?? "");
  const fileDiff = sections.get(finding.file) ?? "";
  // One read serves both verifier messages and the quote check.
  const headText = readHeadFile(ctx.cwd, finding.file);

  const ask = async (
    role: "verifier" | "verifier-escalation",
  ): Promise<VerifierResult | QueryFailure> => {
    // Each query gets its own message, so its blocks get new ids.
    const userMessage = buildVerifierMessage(
      prompt.texts,
      finding,
      headText,
      fileDiff,
      ctx.description,
    );
    try {
      const outcome = await ctx.semaphore(() =>
        client.query<VerifierResult>(
          {
            role,
            systemPrompt: prompt.system,
            userMessage,
            schema: VerifierResultSchema,
            cwd: ctx.cwd,
          },
          options,
        ),
      );
      if (!outcome.ok) return outcome.failure;
      return checkRanges(outcome.output) ?? outcome.output;
    } catch (err) {
      return { kind: "thrown", message: err instanceof Error ? err.message : String(err) };
    }
  };

  const { threshold, bandLow, bandHigh } = ctx.config;
  // The verifier must quote the code that supports the claim. A result
  // that passes on the model's own fields fails when no quote is real.
  const decide = (r: VerifierResult): { passed: boolean; rejected?: string } => {
    if (!(r.in_scope && r.claim_holds && r.score >= threshold)) return { passed: false };
    if (!quoteMatches(r.quotes, headText)) {
      return {
        passed: false,
        rejected: "No quote of the verifier is in the head file of the finding.",
      };
    }
    return { passed: true };
  };

  const first = await ask("verifier");
  if (isQueryFailure(first)) return { first, final: null, passed: false, pre_existing: false };
  // The scope gate comes before the score, and an out-of-scope finding
  // does not escalate. A real issue with a real quote that the change did
  // not bring is a pre-existing finding.
  if (!first.in_scope) {
    const preExisting =
      first.claim_holds && first.score >= threshold && quoteMatches(first.quotes, headText);
    return { first, final: first, passed: false, pre_existing: preExisting };
  }

  const inBand = first.score >= bandLow && first.score <= bandHigh;
  if (!inBand && !finding.needs_context) {
    return { first, final: first, ...decide(first), pre_existing: false };
  }

  const escalated = await ask("verifier-escalation");
  // The second check did not occur, so the finding has no final result
  // and is not posted. The verdict counts this as a failed verifier call.
  if (isQueryFailure(escalated)) {
    return { first, escalated, final: null, passed: false, pre_existing: false };
  }
  return { first, escalated, final: escalated, ...decide(escalated), pre_existing: false };
}
