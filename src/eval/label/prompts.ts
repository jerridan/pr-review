// Build the scorer message and the judge prompt from the prompt files.
// The data goes in tagged untrusted blocks.
import { loadPrompt, render, type PromptFile } from "../../prompts/load.js";
import type { JudgeResult, ScorerResult } from "../../schemas/label.js";
import { wrapUntrusted } from "../../untrusted.js";
import type { GoldenFinding } from "../case.js";

/** The lines of the head file that the window holds above and below the span. */
export const WINDOW_LINES = 100;

/**
 * The most characters of a diff section that a call gets. Linux limits one
 * argv element to 131072 bytes, and the judge prompt is one argument.
 */
export const DIFF_SECTION_LIMIT = 65536;

/** The most characters of the head window that a call gets. */
export const HEAD_WINDOW_LIMIT = 32768;

/** The data of one golden finding that every call of its runs gets. */
export type FindingInput = {
  index: number;
  finding: GoldenFinding;
  /** The head file text, or null when the file is not in the checkout. */
  headText: string | null;
  /** The diff section of the file, or "" when the diff has none. */
  diffSection: string;
  policy: string;
};

type ScorerPrompt = {
  system: string;
  template: string;
  feedback: string;
  noFileText: string;
  noDiffText: string;
};
type JudgePrompt = { system: string; template: string; noFileText: string; noDiffText: string };

function field(file: string, prompt: PromptFile, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/${file} has no "${name}" string in its frontmatter.`);
  }
  return value;
}

let scorer: ScorerPrompt | null = null;
let judge: JudgePrompt | null = null;

function scorerPrompt(): ScorerPrompt {
  if (scorer) return scorer;
  const file = "label-scorer.md";
  const p = loadPrompt(file);
  scorer = {
    system: p.body,
    template: field(file, p, "user_message"),
    feedback: field(file, p, "feedback_text"),
    noFileText: field(file, p, "no_file_text"),
    noDiffText: field(file, p, "no_diff_text"),
  };
  return scorer;
}

function judgePrompt(): JudgePrompt {
  if (judge) return judge;
  const file = "label-judge.md";
  const p = loadPrompt(file);
  judge = {
    system: p.body,
    template: field(file, p, "user_message"),
    noFileText: field(file, p, "no_file_text"),
    noDiffText: field(file, p, "no_diff_text"),
  };
  return judge;
}

/**
 * The numbered lines of the head file from WINDOW_LINES above the span to
 * WINDOW_LINES below it, numbered as in the file. Null when no line of the
 * file is in the window.
 */
export function headWindow(text: string | null, start: number, end: number): string | null {
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = Math.max(1, start - WINDOW_LINES);
  const last = Math.min(lines.length, end + WINDOW_LINES);
  if (first > last) return null;
  const width = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    out.push(`${String(n).padStart(width)}| ${lines[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

function describeFinding(f: GoldenFinding): string {
  const shown = {
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    category: f.category,
    claim: f.claim,
  };
  return JSON.stringify(shown, null, 2);
}

// Keep the first "limit" characters, and tell the model about the cut.
function cap(text: string, limit: number, what: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[The ${what} was cut here. The limit is ${limit} characters.]`;
}

function dataBlocks(
  input: FindingInput,
  texts: { noFileText: string; noDiffText: string },
): Record<string, string> {
  const { finding } = input;
  const window = headWindow(input.headText, finding.start_line, finding.end_line);
  const diff =
    input.diffSection.trim() === ""
      ? texts.noDiffText
      : cap(input.diffSection, DIFF_SECTION_LIMIT, "diff");
  return {
    finding: wrapUntrusted("finding", describeFinding(finding)).block,
    head_file: wrapUntrusted(
      "head_file",
      window === null ? texts.noFileText : cap(window, HEAD_WINDOW_LIMIT, "head file window"),
    ).block,
    diff: wrapUntrusted("diff", diff).block,
    policy: wrapUntrusted("policy", input.policy).block,
  };
}

/** A label that the judge rejected, and the reason of the judge. */
export type Rejection = { label: ScorerResult; judge: JudgeResult };

/** The system prompt and the user message of one scorer call. */
export function scorerMessage(
  input: FindingInput,
  rejections: readonly Rejection[],
): { system: string; user: string } {
  const p = scorerPrompt();
  const parts = [render(p.template, dataBlocks(input, p)).trimEnd()];
  for (const r of rejections) {
    const blocks = {
      rejected_label: wrapUntrusted("rejected_label", JSON.stringify(r.label, null, 2)).block,
      judge_reason: wrapUntrusted("judge_reason", r.judge.reason).block,
    };
    parts.push(render(p.feedback, blocks).trimEnd());
  }
  return { system: p.system, user: `${parts.join("\n\n")}\n` };
}

/** The one prompt string of a judge call: the system text, then the user text. */
export function judgePromptText(input: FindingInput, label: ScorerResult): string {
  const p = judgePrompt();
  const blocks = {
    ...dataBlocks(input, p),
    scorer_result: wrapUntrusted("scorer_result", JSON.stringify(label, null, 2)).block,
  };
  return `${p.system.trimEnd()}\n\n${render(p.template, blocks)}`;
}
