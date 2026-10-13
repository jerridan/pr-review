// Verify: one verifier query per finding, with escalation to a second
// verifier on a middle-band score or when the finding needs context.
import { readHeadFile } from "../find/evidence.js";
import { filterDiff } from "../gather/diff.js";
import { loadPrompt, render } from "../prompts/load.js";
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
};

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

/** Build the verifier user message: the finding, the head file and its diff. */
export function buildVerifierMessage(
  template: string,
  finding: Finding,
  ctx: VerifyContext,
): string {
  const text = readHeadFile(ctx.cwd, finding.file);
  const fileDiff = filterDiff(ctx.diff, (path) => path === finding.file);
  const blocks = {
    finding: wrapUntrusted("finding", describeFinding(finding)).block,
    file: wrapUntrusted(
      "head_file",
      text === null ? "The head commit has no file at this path." : numberLines(text),
    ).block,
    diff: wrapUntrusted(
      "diff",
      fileDiff.trim() === "" ? "The diff has no change to this file." : fileDiff,
    ).block,
  };
  return render(template, blocks);
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
  const template = prompt.frontmatter.user_message;
  if (typeof template !== "string") {
    throw new Error('prompts/verifier.md has no "user_message" string in its frontmatter.');
  }

  const ask = async (
    role: "verifier" | "verifier-escalation",
  ): Promise<VerifierResult | QueryFailure> => {
    const userMessage = buildVerifierMessage(template, finding, ctx);
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
  const passes = (r: VerifierResult) => r.in_scope && r.claim_holds && r.score >= threshold;

  const first = await ask("verifier");
  if (isQueryFailure(first)) return { first, final: null, passed: false };
  // The scope gate comes before the score, and an out-of-scope finding
  // does not escalate.
  if (!first.in_scope) return { first, final: first, passed: false };

  const inBand = first.score >= bandLow && first.score <= bandHigh;
  if (!inBand && !finding.needs_context) return { first, final: first, passed: passes(first) };

  const escalated = await ask("verifier-escalation");
  // A failed escalation leaves the first result standing.
  const final = isQueryFailure(escalated) ? first : escalated;
  return { first, escalated, final, passed: passes(final) };
}
