// Verify: one verifier query per finding, with escalation to a second
// verifier on a middle-band score or when the finding needs context.
import { normalizeWs, readHeadFile } from "../find/evidence.js";
import { filterDiff } from "../gather/diff.js";
import { loadPrompt, render, type PromptFile } from "../prompts/load.js";
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

type VerifyContext = { cwd: string; diff: string; semaphore: Semaphore; config: VerifyConfig };

export type Verification = {
  first: VerifierResult | QueryFailure;
  escalated?: VerifierResult | QueryFailure;
  final: VerifierResult | null;
  passed: boolean;
  /** Why code failed a final result that the model passed. */
  rejected?: string;
};

// A line number prefix: "  11| " from the user message, "  11→" from
// the Read tool, or "11:".
const NUMBER_PREFIX = /^\s*\d+[|→:]\s?/;
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
 * after line prefixes are removed from the quote and after whitespace
 * collapse in both. An empty quote never matches.
 */
export function quoteMatches(quotes: string[], headFileText: string | null): boolean {
  if (headFileText === null) return false;
  const file = normalizeWs(headFileText);
  return quotes.some((q) => {
    const quote = normalizeWs(stripLinePrefixes(q));
    return quote !== "" && file.includes(quote);
  });
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
export type VerifierTexts = { template: string; noFileText: string; noDiffText: string };

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
  };
}

/**
 * Build the verifier user message: the finding, the head file and its
 * diff. "text" is the head file, or null when the head has no such file.
 */
export function buildVerifierMessage(
  texts: VerifierTexts,
  finding: Finding,
  text: string | null,
  ctx: VerifyContext,
): string {
  const fileDiff = filterDiff(ctx.diff, (path) => path === finding.file);
  const blocks = {
    finding: wrapUntrusted("finding", describeFinding(finding)).block,
    file: wrapUntrusted("head_file", text === null ? texts.noFileText : numberLines(text)).block,
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
  const prompt = loadPrompt("verifier.md");
  const texts = verifierTexts(prompt);
  // One read serves both verifier messages and the quote check.
  const headText = readHeadFile(ctx.cwd, finding.file);

  const ask = async (
    role: "verifier" | "verifier-escalation",
  ): Promise<VerifierResult | QueryFailure> => {
    // Each query gets its own message, so its blocks get new ids.
    const userMessage = buildVerifierMessage(texts, finding, headText, ctx);
    try {
      const outcome = await ctx.semaphore(() =>
        client.query<VerifierResult>(
          {
            role,
            systemPrompt: prompt.body,
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
  if (isQueryFailure(first)) return { first, final: null, passed: false };
  // The scope gate comes before the score, and an out-of-scope finding
  // does not escalate.
  if (!first.in_scope) return { first, final: first, passed: false };

  const inBand = first.score >= bandLow && first.score <= bandHigh;
  if (!inBand && !finding.needs_context) return { first, final: first, ...decide(first) };

  const escalated = await ask("verifier-escalation");
  // The second check did not occur, so the finding has no final result
  // and is not posted. The verdict counts this as a failed verifier call.
  if (isQueryFailure(escalated)) return { first, escalated, final: null, passed: false };
  return { first, escalated, final: escalated, ...decide(escalated) };
}
