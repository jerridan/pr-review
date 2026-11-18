// The eval command: validate the cases, review each case several times in
// sequence, score each record against the golden findings of its case,
// and report the metrics. The gate compares the report with a baseline.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic.js";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  EXIT_FAILURE,
  EXIT_GATE,
  EXIT_OK,
  EXIT_STOPPED,
  EXIT_USAGE,
  type ProgramDeps,
} from "../cli.js";
import { JUDGE_DEFAULTS, ROLE_DEFAULTS, resolveModel } from "../config/models.js";
import { loadRepoConfig, type RepoConfig } from "../config/repo-config.js";
import {
  ALL_REVIEWERS,
  effectiveModel,
  loadBuiltinReviewers,
  type ModelPick,
  reviewerEntry,
  type ReviewerDefinition,
  type RunModels,
} from "../reviewers/loader.js";
import { runReview, toolVersion } from "../run.js";
import type { RunRecord } from "../schemas/record.js";
import type { SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import type { Tier } from "../triage/tier.js";
import {
  compareBaseline,
  readBaseline,
  writeBaseline,
  type Baseline,
  type Gate,
} from "./baseline.js";
import {
  CaseError,
  casesRef,
  GoldenSchema,
  loadCases,
  type Case,
  type GoldenFinding,
} from "./case.js";
import { cloneCase } from "./checkout.js";
import {
  JUDGE_CACHE_FILE,
  readJudgeCache,
  writeJudgeCache,
  type JudgeCache,
} from "./judge-cache.js";
import { buildByReviewer, byReviewerRecord } from "./by-reviewer.js";
import { failedMetrics, metrics, type RepeatMetrics } from "./metrics.js";
import { hasSources, pairedRepeat } from "./paired.js";
import { buildReport, renderTable, type Report } from "./report.js";
import { findingKey, scoreRecord, type ScoreJudge, type ScoreResult } from "./score.js";

/** The flags of "pr-review eval". */
export type EvalOptions = {
  cases: string;
  repeat: number;
  baseline?: string;
  writeBaseline: boolean;
  out: string;
  format: "table" | "json";
  tier: Tier;
  judgeModel?: string;
  allowApiKey: boolean;
  allowSameJudge: boolean;
  /** False for --no-extras: no extras judge and no candidates.json. */
  extras: boolean;
  /** True for --raw-judge: the raw pass also asks the judge. */
  rawJudge: boolean;
  /** True for --resume: reuse the finished repeats that the --out directory holds. */
  resume: boolean;
  /** True for --paired: score the one-pass set and the all set of each repeat (D8). */
  paired?: boolean;
  /** --reviewers: run only these reviewers. Absent means every reviewer that a run selects. */
  reviewers?: string[];
  /** --passes: the passes of named reviewers for every run. */
  passes?: Record<string, number>;
  /** --models: the model and the effort of named reviewers, or of all, for every run. */
  models?: RunModels;
  /**
   * --max-cost: no new repeat starts when the repeats that this invocation
   * ran cost this many US dollars or more. Absent means no limit.
   */
  maxCost?: number;
  /**
   * --stage1: each run sends no finding to the verifier, the escalation or
   * the merge. The scoring matches the raw candidates with the raw judge
   * on, and the report adds the figures of each reviewer.
   */
  stage1?: boolean;
};

// The raw judge is on with --raw-judge, and always with --stage1.
const rawJudgeOn = (opts: EvalOptions): boolean => opts.rawJudge || opts.stage1 === true;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function say(message: string): void {
  process.stderr.write(`pr-review eval: ${message}\n`);
}

// The SDK loads only when the eval needs the real client.
async function clientOf(deps: ProgramDeps): Promise<SdkClient> {
  if (deps.client) return deps.client;
  const { createSdkClient } = await import("../sdk/client.js");
  return createSdkClient();
}

const TIER_RANK: Record<Tier, number> = { skip: 0, fast: 1, full: 2 };

/**
 * The reviewers of a case that can run at "tier" and that use the judge
 * model. The run reads the .pr-review/ config from the base commit, so
 * this check reads it there too. A reviewer that the config disables
 * does not count. The check does not know the triage categories or the
 * changed paths, so it counts every reviewer that the tier permits. A
 * config that does not load gives no reviewer: the run of that case then
 * fails as a failed repeat.
 */
async function caseReviewers(
  clone: string,
  c: Case,
  opts: EvalOptions,
  judgeModel: string,
): Promise<{ judgeModel: string[]; shared: string[]; custom: string[] }> {
  let loaded;
  try {
    loaded = await loadRepoConfig(clone, c.base);
  } catch {
    return { judgeModel: [], shared: [], custom: [] };
  }
  const custom = loaded.customReviewers.map((def) => def.frontmatter.name);
  const tier = opts.tier;
  if (tier === "skip") return { judgeModel: [], shared: [], custom };
  const only = opts.reviewers ? new Set(opts.reviewers) : null;
  const { config } = loaded;
  const same = [...loadBuiltinReviewers(), ...loaded.customReviewers]
    .filter((def) => only === null || only.has(def.frontmatter.name))
    .filter((def) => TIER_RANK[def.frontmatter.triggers.min_tier] <= TIER_RANK[tier])
    .filter((def) => config.reviewers[def.frontmatter.name]?.enabled !== false)
    .filter((def) => effectiveModel(def, config, opts.models).model === judgeModel);
  const shared = same.filter((def) => builtinDefaultModel(def, config, opts.models));
  return {
    judgeModel: same.filter((def) => !shared.includes(def)).map((def) => def.frontmatter.name),
    shared: shared.map((def) => def.frontmatter.name),
    custom,
  };
}

/**
 * True when the model of a built-in reviewer comes from its own frontmatter:
 * no --models target, no reviewers.<name>.model and no models.reviewer.model
 * sets it. Such a reviewer can share the judge model: the eval warns and
 * the report names it, but the eval does not stop (D4c E1).
 */
function builtinDefaultModel(
  def: ReviewerDefinition,
  config: RepoConfig,
  run: RunModels | undefined,
): boolean {
  const name = def.frontmatter.name;
  if (def.source !== "builtin" || def.frontmatter.model === undefined) return false;
  if (run !== undefined && (Object.hasOwn(run, name) || Object.hasOwn(run, ALL_REVIEWERS))) {
    return false;
  }
  if (reviewerEntry(config, name)?.model !== undefined) return false;
  return config.models.reviewer?.model === undefined;
}

type SameJudge = { case: string; reviewers: string[] };

// Clone the bundle of each case once, so a sha that does not resolve
// stops the eval before any model call. Unless --allow-same-judge is
// given, give the first case whose reviewers use the judge model. Also
// give the reviewer names that a run can know: the built-in reviewers and
// the custom reviewers of each case.
async function checkCases(
  cases: Case[],
  opts: EvalOptions,
  judgeModel: string,
): Promise<{ sameJudge: SameJudge | null; names: Set<string>; shared: Set<string> }> {
  const names = new Set(loadBuiltinReviewers().map((def) => def.frontmatter.name));
  const shared = new Set<string>();
  const root = await mkdtemp(join(tmpdir(), "pr-review-eval-check-"));
  try {
    for (const c of cases) {
      const clone = await cloneCase(c, join(root, c.name));
      const found = await caseReviewers(clone, c, opts, judgeModel);
      for (const name of found.custom) names.add(name);
      for (const name of found.shared) shared.add(name);
      if (opts.allowSameJudge) continue;
      if (found.judgeModel.length > 0) {
        return { sameJudge: { case: c.name, reviewers: found.judgeModel }, names, shared };
      }
    }
    return { sameJudge: null, names, shared };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The names of --reviewers, --passes and --models that no reviewer has, in
// order. The target "all" of --models is not a name.
function unknownReviewers(opts: EvalOptions, names: Set<string>): string[] {
  const asked = [
    ...(opts.reviewers ?? []),
    ...Object.keys(opts.passes ?? {}),
    ...Object.keys(opts.models ?? {}).filter((name) => name !== ALL_REVIEWERS),
  ];
  return [...new Set(asked.filter((name) => !names.has(name)))];
}

function sharedJudgeMessage(reviewers: string[], judgeModel: string): string {
  return (
    `warning: the built-in reviewers ${reviewers.join(", ")} use the judge model ${judgeModel} by default. ` +
    "The judge can favour findings of its own model."
  );
}

function sameJudgeMessage(where: string, reviewers: string[], judgeModel: string): string {
  return (
    `${where}: the reviewers ${reviewers.join(", ")} use the judge model ${judgeModel}. ` +
    "Give another --judge-model, or give --allow-same-judge."
  );
}

// Read the baselines of the flags. "gate" is the baseline to compare with.
// "existing" is the file that --write-baseline replaces, or null when it
// does not exist yet.
async function baselines(
  opts: EvalOptions,
): Promise<{ gate: Baseline | null; existing: Baseline | null }> {
  if (opts.baseline === undefined) return { gate: null, existing: null };
  if (!opts.writeBaseline) return { gate: await readBaseline(opts.baseline), existing: null };
  const existing = existsSync(opts.baseline) ? await readBaseline(opts.baseline) : null;
  return { gate: null, existing };
}

type RepeatOutcome =
  | {
      kind: "done";
      metrics: RepeatMetrics;
      record?: string;
      /** The known cost of every call of the repeat: its run and its judge. */
      spentUsd: number;
    }
  | { kind: "same-judge"; reviewers: string[] };

type EvalContext = {
  opts: EvalOptions;
  out: string;
  client: SdkClient;
  options: RunOptions;
  judgeModel: string;
  /** The ISO time when runEval started. */
  startedAt: string;
  /** The version of this tool, read one time per run. */
  toolVersion: string;
  /** The built-in reviewers whose own default is the judge model (see builtinDefaultModel). */
  sharedJudge: Set<string>;
};

/** The options that change the result of a repeat. */
type ResultOptions = {
  tier: Tier;
  judge_model: string;
  extras: boolean;
  raw_judge: boolean;
  /** --reviewers in name order, or null. */
  reviewers: string[] | null;
  /** --passes by name, or null. */
  passes: Record<string, number> | null;
  /** True for --paired: the metrics then hold the paired figures. */
  paired: boolean;
  /** --models by target, or null. */
  models: Record<string, ModelPick> | null;
  /** True for --stage1. */
  stage1: boolean;
};

// The fields of the metrics that buildReport and renderTable read.
const number = z.number();
const nullableNumber = z.number().nullable();
const MetricsShape = z.object({
  repeat: number,
  failed: z.boolean(),
  error: z.string().nullable(),
  recall: nullableNumber,
  precision: nullableNumber,
  raw_recall: nullableNumber,
  adjudicated_precision: nullableNumber,
  posted: number,
  matched: number,
  cost_usd: nullableNumber,
  judge_calls: number,
  judge_unknown: number,
  judge_cost_usd: number,
  extras_accepted: number,
  extras_unknown: number,
  drops: z.record(z.string(), number),
});

const ResultFileSchema = z.object({
  case: z.string(),
  head: z.string(),
  golden: z.string(),
  repeat: number,
  record: z.string().optional(),
  tool_version: z.string(),
  options: z.object({
    tier: z.string(),
    judge_model: z.string(),
    extras: z.boolean(),
    raw_judge: z.boolean(),
    // A result from before D8 has neither: it ran every reviewer.
    reviewers: z.array(z.string()).nullable().default(null),
    passes: z.record(z.string(), number).nullable().default(null),
    paired: z.boolean().default(false),
    // A result from before D4c has no models: it ran with no --models.
    models: z
      .record(z.string(), z.object({ model: z.string(), effort: z.string() }))
      .nullable()
      .default(null),
    // A result from before D4c ran the whole pipeline.
    stage1: z.boolean().default(false),
  }),
  metrics: MetricsShape.loose(),
});

/**
 * The file "<out>/<case>/<repeat>/result.json". It holds the metrics of a
 * finished repeat and the facts that a later --resume run checks.
 */
export type ResultFile = {
  case: string;
  head: string;
  /** The fingerprint of the golden findings that scored the repeat. */
  golden: string;
  repeat: number;
  /** The file name of the run record in the repeat directory. A failed repeat can have none. */
  record?: string;
  tool_version: string;
  options: ResultOptions;
  metrics: RepeatMetrics;
};

class ResumeError extends Error {}

// The entries of a record in key order, so that the JSON text is stable.
const byKey = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

const resultOptions = (ctx: EvalContext): ResultOptions => ({
  tier: ctx.opts.tier,
  judge_model: ctx.judgeModel,
  extras: ctx.opts.extras,
  raw_judge: rawJudgeOn(ctx.opts),
  reviewers: ctx.opts.reviewers ? [...new Set(ctx.opts.reviewers)].sort() : null,
  passes: ctx.opts.passes ? byKey(ctx.opts.passes) : null,
  paired: ctx.opts.paired === true,
  models: ctx.opts.models ? byKey(ctx.opts.models) : null,
  stage1: ctx.opts.stage1 === true,
});

// A hash of the golden findings. A change of golden.json changes it.
const goldenFingerprint = (c: Case): string =>
  createHash("sha256").update(JSON.stringify(c.golden)).digest("hex");

const resultPath = (out: string, c: Case, repeat: number): string =>
  join(out, c.name, String(repeat), "result.json");

// Write the file in one step: a temp file, then a rename. A kill leaves no
// half file.
async function writeResult(
  ctx: EvalContext,
  c: Case,
  m: RepeatMetrics,
  record: string | undefined,
): Promise<void> {
  const path = resultPath(ctx.out, c, m.repeat);
  const file: ResultFile = {
    case: c.name,
    head: c.head,
    golden: goldenFingerprint(c),
    repeat: m.repeat,
    ...(record !== undefined ? { record } : {}),
    tool_version: ctx.toolVersion,
    options: resultOptions(ctx),
    metrics: m,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
}

// Read the result file of repeat slot "repeat". A missing file, a file that
// is not JSON, a file of another shape, and a file for another repeat give
// null.
export async function readResult(path: string, repeat: number): Promise<ResultFile | null> {
  try {
    const parsed = ResultFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return null;
    const file = parsed.data;
    if (file.repeat !== repeat || file.metrics.repeat !== repeat) return null;
    return file as unknown as ResultFile;
  } catch {
    return null;
  }
}

const sameOptions = (a: ResultOptions, b: ResultOptions): boolean =>
  a.tier === b.tier &&
  a.judge_model === b.judge_model &&
  a.extras === b.extras &&
  a.raw_judge === b.raw_judge &&
  JSON.stringify(a.reviewers) === JSON.stringify(b.reviewers) &&
  JSON.stringify(a.passes) === JSON.stringify(b.passes) &&
  a.paired === b.paired &&
  JSON.stringify(a.models) === JSON.stringify(b.models) &&
  a.stage1 === b.stage1;

// The results to reuse, by "<case>/<repeat>". A result that is failed, or
// that has another case, head or golden fingerprint, is not reused. It runs
// again, so no version or option check applies to it. A result that would
// be reused, but that has another tool version or other options, throws:
// one report must not mix two configurations.
async function reusableResults(
  ctx: EvalContext,
  cases: Case[],
): Promise<Map<string, RepeatMetrics>> {
  const reuse = new Map<string, RepeatMetrics>();
  const now = resultOptions(ctx);
  for (const c of cases) {
    const golden = goldenFingerprint(c);
    for (let repeat = 1; repeat <= ctx.opts.repeat; repeat++) {
      const path = resultPath(ctx.out, c, repeat);
      const found = await readResult(path, repeat);
      if (found === null) continue;
      if (found.metrics.failed) continue;
      if (found.case !== c.name || found.head !== c.head || found.golden !== golden) continue;
      if (found.tool_version !== ctx.toolVersion) {
        throw new ResumeError(
          `${path}: the result is from tool version ${found.tool_version}, but this is ${ctx.toolVersion}. ` +
            "Run without --resume, or use another --out.",
        );
      }
      if (!sameOptions(found.options, now)) {
        throw new ResumeError(
          `${path}: the result has other options (${JSON.stringify(found.options)}) than this run ` +
            `(${JSON.stringify(now)}). Give the same options, or use another --out.`,
        );
      }
      reuse.set(`${c.name}/${repeat}`, found.metrics);
    }
  }
  return reuse;
}

/** candidates.json has the format of golden.json. */
type CandidatesFile = { findings: GoldenFinding[] };

/**
 * Add the posted findings that the extras judge accepted to
 * "<out>/<case>/candidates.json". One file holds the extras of every
 * repeat of the case. An entry with the same file, span and claim as an
 * entry in the file is not added again. golden.json does not change.
 * Throw when the file is not valid JSON or does not match the schema. The
 * file then does not change.
 */
async function addCandidates(
  ctx: EvalContext,
  c: Case,
  record: RunRecord,
  accepted: number[],
  repeat: number,
): Promise<void> {
  if (accepted.length === 0) return;
  const dir = join(ctx.out, c.name);
  const path = join(dir, "candidates.json");
  const file: CandidatesFile = existsSync(path)
    ? GoldenSchema.parse(JSON.parse(await readFile(path, "utf8")))
    : { findings: [] };
  const known = new Set(file.findings.map(findingKey));
  // The note holds no local path. The severity is the reviewer's own.
  const note =
    `Extra accepted by the extras judge ${ctx.judgeModel} in the eval that started ` +
    `${ctx.startedAt}, repeat ${repeat}. The severity is the reviewer's own and is not ` +
    "labeled: label it before the entry becomes a golden finding.";
  for (const index of accepted) {
    const f = record.posted.findings[index];
    if (!f || known.has(findingKey(f))) continue;
    known.add(findingKey(f));
    file.findings.push({
      file: f.file,
      start_line: f.start_line,
      end_line: f.end_line,
      category: f.category,
      severity: f.severity,
      claim: f.claim,
      note,
    });
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

// The error of a repeat whose review is incomplete. It holds each
// distinct error of the record, in record order.
function incompleteMessage(record: RunRecord): string {
  const reasons = [...new Set(record.cost.errors.map((e) => `${e.stage}: ${e.message}`))];
  const head = "The review was incomplete.";
  return reasons.length === 0 ? head : `${head} ${reasons.join("; ")}`;
}

// Run one repeat of one case in its own clone. A run that throws, that
// exits 1, or that gives an incomplete review gives a failed repeat.
async function runRepeat(ctx: EvalContext, c: Case, repeat: number): Promise<RepeatOutcome> {
  const start = performance.now();
  // The known cost of the calls so far. A failed repeat still costs them.
  let spentUsd = 0;
  const failed = (error: string): RepeatOutcome => ({
    kind: "done",
    metrics: failedMetrics(repeat, error, Math.round(performance.now() - start)),
    spentUsd,
  });
  // The judge answers go to the cache file of the repeat, so a later
  // offline report can score the record with no model call. A cache file
  // that is not valid fails the repeat before the review costs anything.
  const cachePath = join(ctx.out, c.name, String(repeat), JUDGE_CACHE_FILE);
  let cache: JudgeCache;
  try {
    cache = await readJudgeCache(cachePath);
  } catch (err) {
    return failed(messageOf(err));
  }
  const tmp = await mkdtemp(join(tmpdir(), "pr-review-eval-"));
  try {
    const checkout = await cloneCase(c, join(tmp, "repo"));
    const result = await runReview({
      repo: checkout,
      base: c.base,
      head: c.head,
      format: "json",
      tierOverride: ctx.opts.tier,
      outDir: join(ctx.out, c.name, String(repeat)),
      allowApiKey: ctx.opts.allowApiKey,
      ...(c.description_from === "commits"
        ? {}
        : { description: { title: c.title, body: c.body } }),
      client: ctx.client,
      ...(ctx.opts.reviewers ? { onlyReviewers: ctx.opts.reviewers } : {}),
      ...(ctx.opts.passes ? { passes: new Map(Object.entries(ctx.opts.passes)) } : {}),
      ...(ctx.opts.models ? { models: ctx.opts.models } : {}),
      ...(ctx.opts.stage1 === true ? { stage1: true } : {}),
    });
    spentUsd = result.record.cost.total_cost_usd ?? 0;
    if (result.exitCode !== 0) return failed(result.error ?? "The run exited with code 1.");
    // An incomplete review exits 0, but its findings do not show the
    // reviewers. A score of it would be wrong, so the repeat fails.
    if (result.record.posted.verdict === "incomplete")
      return failed(incompleteMessage(result.record));
    const same = result.record.identity.selected_reviewers.filter(
      (r) => r.model === ctx.judgeModel && !ctx.sharedJudge.has(r.name),
    );
    if (same.length > 0 && !ctx.opts.allowSameJudge) {
      return { kind: "same-judge", reviewers: same.map((r) => r.name) };
    }
    const judge: ScoreJudge = {
      client: ctx.client,
      model: ctx.judgeModel,
      options: ctx.options,
      cache,
      asked: new Set(),
    };
    let score: ScoreResult;
    let m: RepeatMetrics;
    // The cache is written also when the scoring throws, so the answers
    // that the eval paid for stay.
    try {
      score = await scoreRecord(result.record, c.golden, checkout, judge, {
        extras: ctx.opts.extras,
        rawJudge: rawJudgeOn(ctx.opts),
      });
      m = metrics(result.record, score, repeat);
      if (ctx.opts.stage1 === true) {
        const rows = await byReviewerRecord(result.record, c.golden, checkout, judge);
        m.by_reviewer = rows.rows;
        m.judge_calls += rows.judgeCalls;
        m.judge_cost_usd += rows.judgeCostUsd;
      }
      if (ctx.opts.paired === true) {
        if (hasSources(result.record)) {
          const p = await pairedRepeat(
            result.record,
            c.golden,
            checkout,
            judge,
            { rawJudge: rawJudgeOn(ctx.opts) },
            score,
          );
          m.paired = p.paired;
          m.judge_calls += p.judgeCalls;
          m.judge_cost_usd += p.judgeCostUsd;
        } else {
          m.paired = null;
        }
      }
    } finally {
      try {
        await writeJudgeCache(cachePath, cache);
      } catch (err) {
        say(
          `warning: case ${c.name}, repeat ${repeat}: cannot write ${JUDGE_CACHE_FILE}: ${messageOf(err)}`,
        );
      }
    }
    // A candidates.json problem does not fail a repeat with a good score.
    try {
      await addCandidates(ctx, c, result.record, score.extras.accepted, repeat);
    } catch (err) {
      say(
        `warning: case ${c.name}, repeat ${repeat}: cannot update candidates.json: ${messageOf(err)}`,
      );
    }
    spentUsd += m.judge_cost_usd;
    return { kind: "done", metrics: m, record: basename(result.recordPath), spentUsd };
  } catch (err) {
    return failed(messageOf(err));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Round a drop for a message, so a float error does not show.
const shown = (value: number | null): string =>
  value === null ? "none" : String(Number(value.toFixed(6)));

function gateMessage(gate: Gate): string {
  return (
    `the gate failed: recall drop ${shown(gate.recall_drop)} (margin ${shown(gate.margin.recall)}), ` +
    `precision drop ${shown(gate.precision_drop)} (margin ${shown(gate.margin.precision)})`
  );
}

/**
 * Run the eval and give its exit code: 0 when the gate passed or did not
 * run, 1 for a failed repeat or a run error, 2 for an invalid case or a
 * configuration error, 3 when the gate failed, 4 when --max-cost stopped
 * the eval. Exit code 1 wins over 4, and 4 wins over 3: no gate runs on a
 * stopped eval.
 */
export async function runEval(opts: EvalOptions, deps: ProgramDeps): Promise<number> {
  const startedAt = new Date().toISOString();
  // Every check comes before the first model call.
  let judgeModel: string;
  try {
    judgeModel = resolveModel(opts.judgeModel ?? JUDGE_DEFAULTS.model);
  } catch (err) {
    say(messageOf(err));
    return EXIT_USAGE;
  }
  const reviewerModel = resolveModel(ROLE_DEFAULTS.reviewer.model);
  if (judgeModel === reviewerModel && !opts.allowSameJudge) {
    say(
      `the judge model ${judgeModel} is the model of the reviewer role. ` +
        "Give another --judge-model, or give --allow-same-judge.",
    );
    return EXIT_USAGE;
  }

  let cases: Case[];
  let checked: { sameJudge: SameJudge | null; names: Set<string>; shared: Set<string> };
  try {
    cases = await loadCases(opts.cases);
    checked = await checkCases(cases, opts, judgeModel);
  } catch (err) {
    if (!(err instanceof CaseError)) throw err;
    say(err.message);
    return EXIT_USAGE;
  }
  const { sameJudge } = checked;
  if (sameJudge !== null) {
    say(sameJudgeMessage(`case ${sameJudge.case}`, sameJudge.reviewers, judgeModel));
    return EXIT_USAGE;
  }
  const unknown = unknownReviewers(opts, checked.names);
  if (unknown.length > 0) {
    say(
      `${unknown.map((name) => `unknown reviewer ${name}`).join("; ")}. ` +
        "Give a built-in reviewer or a custom reviewer of a case.",
    );
    return EXIT_USAGE;
  }

  let base: { gate: Baseline | null; existing: Baseline | null };
  try {
    base = await baselines(opts);
  } catch (err) {
    say(messageOf(err));
    return EXIT_USAGE;
  }

  const ref = await casesRef(opts.cases);
  const out = resolve(opts.out);
  const ctx: EvalContext = {
    opts,
    out,
    client: await clientOf(deps),
    options: { allowApiKey: opts.allowApiKey, env: process.env },
    judgeModel,
    startedAt,
    toolVersion: toolVersion(),
    sharedJudge: checked.shared,
  };
  // A built-in reviewer whose own default is the judge model shares it with
  // the judge. The eval goes on, and says so here and in the report.
  const sharedNames = [...checked.shared].sort();
  if (sharedNames.length > 0) say(sharedJudgeMessage(sharedNames, judgeModel));

  let reuse = new Map<string, RepeatMetrics>();
  if (opts.resume) {
    try {
      reuse = await reusableResults(ctx, cases);
    } catch (err) {
      if (!(err instanceof ResumeError)) throw err;
      say(err.message);
      return EXIT_USAGE;
    }
  }

  // The runs go in sequence: case by case, and repeat by repeat. With
  // --max-cost, a repeat starts only while the repeats of this invocation
  // cost less than the limit. After a stop, the loop only counts the
  // repeats that remain, and still takes the reused ones.
  const results: { name: string; repeats: RepeatMetrics[] }[] = [];
  let spent = 0;
  let stopped = false;
  let remaining = 0;
  // The repeats that did not run, by case, for the stop message.
  const left = new Map<string, number[]>();
  for (const c of cases) {
    const repeats: RepeatMetrics[] = [];
    for (let repeat = 1; repeat <= opts.repeat; repeat++) {
      const reused = reuse.get(`${c.name}/${repeat}`);
      if (reused !== undefined) {
        repeats.push(reused);
        continue;
      }
      if (opts.maxCost !== undefined && spent >= opts.maxCost) stopped = true;
      if (stopped) {
        remaining += 1;
        left.set(c.name, [...(left.get(c.name) ?? []), repeat]);
        continue;
      }
      // With --resume, the old output of this repeat stays out of the way of
      // the new record. Without it, the old records stay, as before.
      // writeResult replaces the old result.json, and the golden fingerprint
      // keeps a stale one from reuse.
      if (opts.resume)
        await rm(join(out, c.name, String(repeat)), { recursive: true, force: true });
      const outcome = await runRepeat(ctx, c, repeat);
      // The pre-flight catches a config that gives a reviewer the judge
      // model. This check stays as a safety net for a model that only the
      // run can see.
      if (outcome.kind === "same-judge") {
        say(sameJudgeMessage(`case ${c.name}, repeat ${repeat}`, outcome.reviewers, judgeModel));
        return EXIT_USAGE;
      }
      try {
        await writeResult(ctx, c, outcome.metrics, outcome.record);
      } catch (err) {
        say(
          `warning: case ${c.name}, repeat ${repeat}: cannot write result.json: ${messageOf(err)}`,
        );
      }
      spent += outcome.spentUsd;
      repeats.push(outcome.metrics);
    }
    if (repeats.length > 0) results.push({ name: c.name, repeats });
  }

  const paired = opts.paired === true ? { uncached: [] } : undefined;
  let report: Report = buildReport(results, null, ref, paired);
  const failed = report.failed_repeats.length > 0;
  let runError: string | null = null;
  // A stopped eval has only a part of the repeats, so no gate runs and the
  // baseline does not change.
  if (stopped) {
    if (opts.baseline !== undefined) {
      say("no gate runs and no baseline changes, because the eval stopped at the cost limit.");
    }
  } else if (base.gate) {
    const known = base.gate.cases_ref;
    if (known !== null && ref !== null && known !== ref) {
      say(
        `warning: the baseline has the cases ref ${known}, but the cases are at ${ref}. ` +
          "A change of the case set needs a new baseline.",
      );
    }
    report = buildReport(results, compareBaseline(base.gate, report), ref, paired);
  } else if (opts.writeBaseline && opts.baseline !== undefined) {
    if (failed) {
      say(`a repeat failed, so the baseline ${opts.baseline} does not change.`);
    } else {
      try {
        await writeBaseline(opts.baseline, report, base.existing, {
          repeat: opts.repeat,
          tool_version: ctx.toolVersion,
        });
      } catch (err) {
        runError = messageOf(err);
      }
    }
  }

  if (opts.stage1 === true) {
    report.mode = "stage1";
    report.by_reviewer = buildByReviewer(
      results.flatMap((c) =>
        c.repeats.flatMap((r) =>
          r.by_reviewer ? [{ case: c.name, repeat: r.repeat, rows: r.by_reviewer }] : [],
        ),
      ),
    );
  }

  if (sharedNames.length > 0) report.shared_judge = { model: judgeModel, reviewers: sharedNames };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), json);
  const sharedLine =
    sharedNames.length > 0
      ? `Judge: ${judgeModel}, the default model of ${sharedNames.join(", ")}.\n`
      : "";
  process.stdout.write(
    opts.format === "json" ? json : renderTable(report, base.gate?.cases_ref ?? null) + sharedLine,
  );

  if (opts.resume) {
    say(`${reuse.size} ${reuse.size === 1 ? "repeat" : "repeats"} reused from ${out}`);
  }
  for (const f of report.failed_repeats) {
    say(`case ${f.case}, repeat ${f.repeat} failed: ${f.error}`);
  }
  if (runError !== null) say(runError);
  // A judge answer of "unknown", or a judge query that failed, counts as no
  // match. Say so, because it lowers recall and precision with no other sign.
  if (report.judge.unknown > 0) {
    say(
      `warning: ${report.judge.unknown} match judge queries gave no answer. ` +
        "The eval counts each one as no match.",
    );
  }
  // An extras answer of "unknown" is no accepted extra, so it lowers the
  // adjudicated precision with no other sign.
  if (report.judge.extras_unknown > 0) {
    say(
      `warning: ${report.judge.extras_unknown} extras judge queries gave no answer. ` +
        "The eval does not accept those findings as extras.",
    );
  }
  if (report.gate && !report.gate.passed) say(gateMessage(report.gate));
  if (stopped) {
    say(
      `the cost limit stopped the eval: the repeats of this run cost $${spent.toFixed(4)}, ` +
        `and the limit is $${(opts.maxCost ?? 0).toFixed(4)}. ` +
        `${remaining} ${remaining === 1 ? "repeat remains" : "repeats remain"} ` +
        `(${[...left].map(([name, repeats]) => `${name}: ${repeats.join(", ")}`).join("; ")}). ` +
        "Run again with --resume to continue.",
    );
  }
  if (failed || runError !== null) return EXIT_FAILURE;
  if (stopped) return EXIT_STOPPED;
  if (report.gate && !report.gate.passed) return EXIT_GATE;
  return EXIT_OK;
}
