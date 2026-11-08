// The labeling loop. One run of one finding: the scorer labels it, the
// judge accepts or rejects the label, and a rejected label goes back to
// the scorer with the reason, at most twice. Each finding gets several
// independent runs in sequence. A majority of the converged runs sets the
// label.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readHeadFile } from "../../find/evidence.js";
import { diffSections } from "../../gather/diff.js";
import type { Category } from "../../schemas/finding.js";
import {
  POSTED_SEVERITIES,
  ScorerResultSchema,
  type JudgeResult,
  type LabelSeverity,
  type ScorerResult,
} from "../../schemas/label.js";
import type { SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";
import type { Semaphore } from "../../semaphore.js";
import type { Case } from "../case.js";
import { runCodexJudge } from "./codex.js";
import { judgePromptText, scorerMessage, type FindingInput, type Rejection } from "./prompts.js";

/** The most re-scores of one run. */
export const MAX_RESCORES = 2;

export type ScorerCall = {
  kind: "scorer";
  severity: LabelSeverity | null;
  category: Category | null;
  policy_section: string | null;
  rationale?: string;
  error?: string;
};

export type JudgeCall = {
  kind: "judge";
  accept: boolean | null;
  policy_section: string | null;
  reason?: string;
  stderr: string;
  error?: string;
};

export type LabelCall = ScorerCall | JudgeCall;

export type RunResult = {
  converged: boolean;
  failed: boolean;
  severity: LabelSeverity | null;
  category: Category | null;
  first_pass_accepted: boolean;
  calls: LabelCall[];
  error?: string;
};

export type Chosen = { severity: LabelSeverity; category: Category };

export type QueueReason = "no_majority" | "too_few_converged" | "not_posted_label";

/** The entry of one finding in labels.json. */
export type FindingEntry = {
  index: number;
  file: string;
  start_line: number;
  end_line: number;
  claim: string;
  current_severity: string;
  chosen: Chosen | null;
  runs: RunResult[];
};

export type FindingOutcome = {
  entry: FindingEntry;
  queueReason: QueueReason | null;
  scorerCostUsd: number;
};

/** What every call of a case shares. */
export type LabelContext = {
  client: SdkClient;
  /** The RunOptions of every scorer call. */
  options: RunOptions;
  /** The case checkout: the cwd of every call. */
  checkout: string;
  runs: number;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

// One run's state: its calls and the scorer cost so far.
type RunState = { calls: LabelCall[]; cost: number };

async function scoreOnce(
  input: FindingInput,
  rejections: readonly Rejection[],
  ctx: LabelContext,
  state: RunState,
): Promise<Attempt<ScorerResult>> {
  const { system, user } = scorerMessage(input, rejections);
  try {
    const outcome = await ctx.client.query<ScorerResult>(
      {
        role: "labeler",
        systemPrompt: system,
        userMessage: user,
        schema: ScorerResultSchema,
        cwd: ctx.checkout,
      },
      ctx.options,
    );
    state.cost += outcome.raw?.costUsd ?? 0;
    if (outcome.ok) return { ok: true, value: outcome.output };
    return { ok: false, error: `${outcome.failure.kind}: ${outcome.failure.message}` };
  } catch (err) {
    return { ok: false, error: `thrown: ${messageOf(err)}` };
  }
}

async function judgeOnce(
  input: FindingInput,
  label: ScorerResult,
  ctx: LabelContext,
): Promise<Attempt<JudgeResult> & { stderr: string }> {
  const outcome = await runCodexJudge(judgePromptText(input, label), ctx.checkout);
  return outcome.ok
    ? { ok: true, value: outcome.output, stderr: outcome.stderr }
    : { ok: false, error: outcome.error, stderr: outcome.stderr };
}

// Make a scorer call, and retry it once when it fails. Record each call.
async function score(
  input: FindingInput,
  rejections: readonly Rejection[],
  ctx: LabelContext,
  state: RunState,
): Promise<Attempt<ScorerResult>> {
  let last: Attempt<ScorerResult> = { ok: false, error: "no call" };
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await scoreOnce(input, rejections, ctx, state);
    if (last.ok) {
      const v = last.value;
      state.calls.push({
        kind: "scorer",
        severity: v.severity,
        category: v.category,
        policy_section: v.policy_section,
        rationale: v.rationale,
      });
      return last;
    }
    state.calls.push({
      kind: "scorer",
      severity: null,
      category: null,
      policy_section: null,
      error: last.error,
    });
  }
  return last;
}

// Make a judge call, and retry it once when it fails. Record each call.
async function judge(
  input: FindingInput,
  label: ScorerResult,
  ctx: LabelContext,
  state: RunState,
): Promise<Attempt<JudgeResult>> {
  let last: Attempt<JudgeResult> = { ok: false, error: "no call" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await judgeOnce(input, label, ctx);
    last = result;
    if (result.ok) {
      state.calls.push({
        kind: "judge",
        accept: result.value.accept,
        policy_section: result.value.policy_section,
        reason: result.value.reason,
        stderr: result.stderr,
      });
      return last;
    }
    state.calls.push({
      kind: "judge",
      accept: null,
      policy_section: null,
      stderr: result.stderr,
      error: result.error,
    });
  }
  return last;
}

/**
 * One run of the loop for one finding. The run sees no call of another
 * run. A call that fails twice ends the run as failed.
 */
export async function labelRun(
  input: FindingInput,
  ctx: LabelContext,
): Promise<{ run: RunResult; scorerCostUsd: number }> {
  const state: RunState = { calls: [], cost: 0 };
  const rejections: Rejection[] = [];
  let firstPassAccepted = false;
  const end = (fields: Partial<RunResult>): { run: RunResult; scorerCostUsd: number } => ({
    run: {
      converged: false,
      failed: false,
      severity: null,
      category: null,
      first_pass_accepted: firstPassAccepted,
      calls: state.calls,
      ...fields,
    },
    scorerCostUsd: state.cost,
  });

  for (let round = 0; round <= MAX_RESCORES; round++) {
    const label = await score(input, rejections, ctx, state);
    if (!label.ok) return end({ failed: true, error: label.error });
    const verdict = await judge(input, label.value, ctx, state);
    if (!verdict.ok) return end({ failed: true, error: verdict.error });
    if (round === 0) firstPassAccepted = verdict.value.accept;
    if (verdict.value.accept) {
      return end({
        converged: true,
        severity: label.value.severity,
        category: label.value.category,
      });
    }
    rejections.push({ label: label.value, judge: verdict.value });
  }
  return end({});
}

// The value that more than half of "values" hold, or null.
function majority<T>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [v, n] of counts) if (n * 2 > values.length) return v;
  return null;
}

/**
 * The chosen label of a finding from its runs. The severity is the one
 * that a majority of the converged runs agree on, and at least two runs.
 * The category is the majority category of the converged runs, or the
 * current category when there is no majority.
 */
export function aggregate(
  runs: readonly RunResult[],
  currentCategory: Category,
): { chosen: Chosen | null; queueReason: QueueReason | null } {
  const converged = runs.filter((r) => r.converged && r.severity !== null);
  if (converged.length < 2) return { chosen: null, queueReason: "too_few_converged" };
  const severity = majority(converged.map((r) => r.severity as LabelSeverity));
  if (severity === null) return { chosen: null, queueReason: "no_majority" };
  const category = majority(converged.map((r) => r.category as Category)) ?? currentCategory;
  const posted = POSTED_SEVERITIES.includes(severity);
  return { chosen: { severity, category }, queueReason: posted ? null : "not_posted_label" };
}

/** Label one finding: its runs go in sequence, then the aggregate. */
export async function labelFinding(
  input: FindingInput,
  ctx: LabelContext,
): Promise<FindingOutcome> {
  const runs: RunResult[] = [];
  let cost = 0;
  for (let i = 0; i < ctx.runs; i++) {
    const { run, scorerCostUsd } = await labelRun(input, ctx);
    runs.push(run);
    cost += scorerCostUsd;
  }
  const f = input.finding;
  const { chosen, queueReason } = aggregate(runs, f.category);
  return {
    entry: {
      index: input.index,
      file: f.file,
      start_line: f.start_line,
      end_line: f.end_line,
      claim: f.claim,
      current_severity: f.severity,
      chosen,
      runs,
    },
    queueReason,
    scorerCostUsd: cost,
  };
}

/** The inputs of every golden finding of a case, from its checkout and diff.patch. */
export async function caseInputs(
  c: Case,
  checkout: string,
  policy: string,
): Promise<FindingInput[]> {
  const sections = diffSections(await readFile(join(c.dir, "diff.patch"), "utf8"));
  return c.golden.map((finding, index) => ({
    index,
    finding,
    headText: readHeadFile(checkout, finding.file),
    diffSection: sections.get(finding.file) ?? "",
    policy,
  }));
}

/**
 * Label every golden finding of a case in its checkout. The findings run
 * in parallel under "semaphore". The outcomes come back in index order.
 */
export async function labelCase(
  c: Case,
  ctx: LabelContext,
  policy: string,
  semaphore: Semaphore,
): Promise<FindingOutcome[]> {
  const inputs = await caseInputs(c, ctx.checkout, policy);
  return Promise.all(inputs.map((input) => semaphore(() => labelFinding(input, ctx))));
}
