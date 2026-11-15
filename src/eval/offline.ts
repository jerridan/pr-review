// The offline report (D8): score the run records of an earlier eval in its
// --out directory against the cases again, with no model call. It clones
// each case, because the key of a judge answer holds the head lines and
// the diff that the judge saw. The judge
// answers come from the cache file of each repeat. A question with no
// cached answer counts as no match, and the report says so. With
// --by-pass, it adds the by-pass section (by-pass.ts). With --by-reviewer,
// it adds the figures of each reviewer (by-reviewer.ts). With
// --ask-missing, the judge first answers the questions of those sections
// that have no answer or a failed one, and those answers go into the cache
// file of the repeat. The report then scores every section from the cache,
// so all agree.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_OK, EXIT_USAGE } from "../cli.js";
import { isRecordFileName } from "../record/write.js";
import { RecordSchema, type RunRecord } from "../schemas/record.js";
import type { SdkClient } from "../sdk/client.js";
import { resamples } from "./bootstrap.js";
import {
  byPassRecord,
  emptySection,
  renderByPass,
  summarizeScope,
  type ByPassRow,
  type ByPassSection,
} from "./by-pass.js";
import {
  buildByReviewer,
  byReviewerRecord,
  type ByReviewerInput,
  type ByReviewerSection,
} from "./by-reviewer.js";
import { CaseError, casesRef, loadCases, type Case } from "./case.js";
import { cloneCase } from "./checkout.js";
import {
  JUDGE_CACHE_FILE,
  readJudgeCache,
  writeJudgeCache,
  type JudgeCache,
} from "./judge-cache.js";
import { failedMetrics, metrics, type RepeatMetrics } from "./metrics.js";
import {
  hasSources,
  multiPassReviewers,
  NO_SOURCES,
  notValidLines,
  pairedRepeat,
  type PairedSection,
} from "./paired.js";
import { buildReport, renderTable } from "./report.js";
import { readResult } from "./run.js";
import { scoreRecord, type ScoreJudge } from "./score.js";

/** The flags of "pr-review eval-report". */
export type EvalReportOptions = {
  cases: string;
  out: string;
  format: "table" | "json";
  /** Add the by-pass section. */
  byPass?: boolean;
  /** Add the by-reviewer section. */
  byReviewer?: boolean;
  /**
   * Let the judge answer the questions of the by-pass and by-reviewer
   * sections with no answer or a failed one. Needs byPass or byReviewer.
   */
  askMissing?: boolean;
  /** Keep ANTHROPIC_API_KEY and the other provider variables for the judge of --ask-missing. */
  allowApiKey?: boolean;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function say(message: string): void {
  process.stderr.write(`pr-review eval-report: ${message}\n`);
}

// The repeat numbers of a case: the directories with a positive integer name.
async function repeatNumbers(dir: string): Promise<number[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A case with no directory did not run. Any other error stops the report.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && /^[1-9][0-9]*$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => a - b);
}

// The record of a repeat: the file that result.json names, or else the one
// record file of the directory.
async function readRecord(dir: string, named: string | undefined): Promise<RunRecord> {
  let name = named;
  if (name === undefined) {
    const records = (await readdir(dir)).filter(isRecordFileName);
    if (records.length !== 1) {
      throw new Error(`${dir} holds ${records.length} run records and result.json names none`);
    }
    name = records[0] as string;
  }
  const path = join(dir, name);
  const parsed = RecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a run record`);
  return parsed.data;
}

/** What the by-pass and by-reviewer scorings of a repeat need. */
type Kept = {
  record: RunRecord;
  head: string;
  cache: JudgeCache;
  cachePath: string;
  judgeModel: string;
  rawJudge: boolean;
};

/** "mode" is the mode of the scored record, or absent when no record was scored. */
type Scored = { metrics: RepeatMetrics; uncached: number; kept?: Kept; mode?: "full" | "stage1" };

// Score one repeat again from its record and its judge cache. A repeat
// that failed in the eval keeps its metrics. "checkout" is a clone of the
// case: the key of each judge answer holds the head lines and the diff
// that the judge saw, so the scoring reads them as the eval did. With
// "keep", the result holds what the by-pass and by-reviewer scorings need.
async function scoreRepeat(
  c: Case,
  dir: string,
  repeat: number,
  checkout: () => Promise<string>,
  keep: boolean,
): Promise<Scored> {
  const result = await readResult(join(dir, "result.json"), repeat);
  if (result === null) {
    return { metrics: failedMetrics(repeat, `no valid result.json in ${dir}`, 0), uncached: 0 };
  }
  if (result.metrics.failed) return { metrics: result.metrics, uncached: 0 };
  const record = await readRecord(dir, result.record);
  const cachePath = join(dir, JUDGE_CACHE_FILE);
  const cache = await readJudgeCache(cachePath);
  const judge: ScoreJudge = {
    client: null,
    model: result.options.judge_model,
    options: { allowApiKey: false, env: {} },
    cache,
  };
  const head = await checkout();
  const score = await scoreRecord(record, c.golden, head, judge, {
    extras: result.options.extras,
    rawJudge: result.options.raw_judge,
  });
  const m = metrics(record, score, repeat);
  let uncached = score.uncached;
  const kept: Kept | undefined = keep
    ? {
        record,
        head,
        cache,
        cachePath,
        judgeModel: result.options.judge_model,
        rawJudge: result.options.raw_judge,
      }
    : undefined;
  if (hasSources(record)) {
    const p = await pairedRepeat(
      record,
      c.golden,
      head,
      judge,
      { rawJudge: result.options.raw_judge },
      score,
    );
    m.paired = p.paired;
    uncached += p.uncached;
  } else {
    m.paired = null;
  }
  return {
    metrics: m,
    uncached,
    ...(kept ? { kept } : {}),
    mode: record.identity.mode ?? "full",
  };
}

type ByPassInput = { case: Case; repeat: number; kept: Kept };

// Why the by-pass scoring leaves a case out of the scope of "reviewer":
// the reviewer needs an "ok" entry of pass 1 and of pass 2. Null when the
// case is in the scope.
function leftOut(record: RunRecord, reviewer: string): string | null {
  const entries = record.stages.reviewers.filter((r) => r.name === reviewer);
  if (entries.length === 0) return "did not run";
  for (const pass of [1, 2]) {
    const entry = entries.find((r) => r.pass === pass);
    if (entry === undefined) return `no pass ${pass}`;
    if (entry.status !== "ok") return `pass ${pass} failed`;
  }
  return null;
}

/**
 * The by-pass section of the kept repeats. The scopes of a repeat are the
 * reviewers that ran two passes in one of its records, and every such
 * reviewer together. A reviewer that ran more than two passes in a case
 * has no scope in that repeat. A case is in the scope of a reviewer only
 * when the reviewer has an "ok" pass 1 and pass 2 there; the scope of
 * every reviewer holds, in each case, the reviewers that are in their own
 * scope. "missing" gets each case that a scope leaves out, with the reason.
 * With "client", the judge answers each question with no answer or a
 * failed one, once per record, and the cache file of the repeat gets the
 * new answers.
 */
async function byPassSection(
  inputs: ByPassInput[],
  missing: ByPassSection["missing"],
  client: SdkClient | null,
  allowApiKey: boolean,
): Promise<ByPassSection> {
  let questions = 0;
  let costUsd = 0;
  const numbers = [...new Set(inputs.map((i) => i.repeat))].sort((a, b) => a - b);
  const repeats: ByPassSection["repeats"] = [];
  for (const repeat of numbers) {
    const ours = inputs.filter((i) => i.repeat === repeat);
    const multi = [...new Set(ours.flatMap((i) => multiPassReviewers(i.kept.record)))].sort();
    const over = new Set<string>();
    for (const { case: c, kept } of ours) {
      for (const name of multi) {
        const passes = kept.record.stages.reviewers
          .filter((r) => r.name === name)
          .map((r) => r.pass);
        const most = Math.max(0, ...passes);
        if (most > 2) {
          over.add(name);
          missing.push({ case: c.name, repeat, reviewer: name, reason: `ran ${most} passes` });
        }
      }
    }
    const reviewers = multi.filter((name) => !over.has(name));
    const scopes: (string | null)[] = reviewers.length === 0 ? [] : [null, ...reviewers];
    const rows = new Map<string | null, ({ case: string } & ByPassRow)[]>(
      scopes.map((scope) => [scope, []]),
    );
    for (const { case: c, kept } of ours) {
      const inScope: string[] = [];
      for (const name of reviewers) {
        const reason = leftOut(kept.record, name);
        if (reason === null) inScope.push(name);
        else missing.push({ case: c.name, repeat, reviewer: name, reason });
      }
      if (inScope.length === 0) continue;
      const judge: ScoreJudge = {
        client,
        model: kept.judgeModel,
        options: { allowApiKey, env: client === null ? {} : process.env },
        cache: kept.cache,
        // One set for the record: a failed answer gets one new query, not
        // one per scope.
        asked: new Set(),
      };
      const caseScopes = [null, ...inScope];
      const scored = await byPassRecord(
        kept.record,
        c.golden,
        kept.head,
        judge,
        caseScopes,
        inScope,
        kept.rawJudge,
      );
      scored.rows.forEach((row, i) =>
        rows.get(caseScopes[i] ?? null)?.push({ case: c.name, ...row }),
      );
      questions += scored.judgeCalls;
      costUsd += scored.judgeCostUsd;
      if (scored.judgeCalls > 0) await writeJudgeCache(kept.cachePath, kept.cache);
    }
    // One set of draws for each case count, shared by the scopes.
    const draws = new Map<number, number[][]>();
    const drawsFor = (n: number): number[][] => {
      let d = draws.get(n);
      if (d === undefined) {
        d = resamples(n);
        draws.set(n, d);
      }
      return d;
    };
    repeats.push({
      repeat,
      scopes: scopes.map((scope) => {
        const scopeRows = rows.get(scope) ?? [];
        return summarizeScope(scope, scopeRows, drawsFor(scopeRows.length));
      }),
    });
  }
  return {
    ...emptySection(missing, client === null ? null : { questions, cost_usd: costUsd }),
    repeats,
  };
}

/**
 * The by-reviewer section of the kept repeats. With "client", the judge
 * answers each question with no answer or a failed one, once per record,
 * and the cache file of the repeat gets the new answers.
 */
async function byReviewerSection(
  inputs: ByPassInput[],
  client: SdkClient | null,
  allowApiKey: boolean,
): Promise<ByReviewerSection> {
  let questions = 0;
  let costUsd = 0;
  const rows: ByReviewerInput[] = [];
  for (const { case: c, repeat, kept } of inputs) {
    const judge: ScoreJudge = {
      client,
      model: kept.judgeModel,
      options: { allowApiKey, env: client === null ? {} : process.env },
      cache: kept.cache,
      // One set for the record: a failed answer gets one new query, not
      // one per scope.
      asked: new Set(),
    };
    const scored = await byReviewerRecord(kept.record, c.golden, kept.head, judge);
    questions += scored.judgeCalls;
    costUsd += scored.judgeCostUsd;
    if (scored.judgeCalls > 0) await writeJudgeCache(kept.cachePath, kept.cache);
    rows.push({ case: c.name, repeat, rows: scored.rows });
  }
  return buildByReviewer(rows, client === null ? null : { questions, cost_usd: costUsd });
}

type Collected = {
  results: { name: string; repeats: RepeatMetrics[] }[];
  uncached: PairedSection["uncached"];
  /** The repeats of the by-pass scoring: a kept record with source fields. */
  inputs: ByPassInput[];
  missing: ByPassSection["missing"];
  /** The repeats of the by-reviewer scoring: every kept record. */
  reviewerInputs: ByPassInput[];
  /** The mode of each scored record. */
  modes: ("full" | "stage1")[];
};

// Score every repeat in "out". With "keep", collect what the by-pass
// scoring needs. With "quiet", print no error: a second pass prints them.
async function collect(
  cases: Case[],
  out: string,
  checkoutOf: (c: Case) => () => Promise<string>,
  keep: boolean,
  quiet: boolean,
): Promise<Collected> {
  const collected: Collected = {
    results: [],
    uncached: [],
    inputs: [],
    missing: [],
    reviewerInputs: [],
    modes: [],
  };
  for (const c of cases) {
    const caseDir = join(out, c.name);
    const repeats: RepeatMetrics[] = [];
    for (const repeat of await repeatNumbers(caseDir)) {
      const dir = join(caseDir, String(repeat));
      try {
        const scored = await scoreRepeat(c, dir, repeat, checkoutOf(c), keep);
        repeats.push(scored.metrics);
        if (scored.uncached > 0) {
          collected.uncached.push({ case: c.name, repeat, pairs: scored.uncached });
        }
        if (scored.mode !== undefined) collected.modes.push(scored.mode);
        if (scored.kept) collected.reviewerInputs.push({ case: c, repeat, kept: scored.kept });
        if (scored.kept && hasSources(scored.kept.record))
          collected.inputs.push({ case: c, repeat, kept: scored.kept });
        else
          collected.missing.push({
            case: c.name,
            repeat,
            reason: scored.metrics.failed ? "failed repeat" : NO_SOURCES,
          });
      } catch (err) {
        repeats.push(failedMetrics(repeat, messageOf(err), 0));
        collected.missing.push({ case: c.name, repeat, reason: "failed repeat" });
        if (!quiet) say(`case ${c.name}, repeat ${repeat}: ${messageOf(err)}`);
      }
    }
    if (repeats.length > 0) collected.results.push({ name: c.name, repeats });
  }
  return collected;
}

/**
 * Print the report of the records in the --out directory: the normal
 * metrics and the paired section, with --by-pass the by-pass section, and
 * with --by-reviewer the by-reviewer section. With --ask-missing, the judge
 * first answers the questions of those sections with no answer or a failed
 * one, and judge-cache.json of each repeat gets the answers; every section
 * then reads them. Give 0, or 2 for an invalid case.
 */
export async function runEvalReport(
  opts: EvalReportOptions,
  clientOf: () => Promise<SdkClient> = () => Promise.reject(new Error("no judge client")),
): Promise<number> {
  let cases: Case[];
  try {
    cases = await loadCases(opts.cases);
  } catch (err) {
    if (!(err instanceof CaseError)) throw err;
    say(err.message);
    return EXIT_USAGE;
  }
  const out = resolve(opts.out);
  const byPassOn = opts.byPass === true;
  const byReviewerOn = opts.byReviewer === true;
  const keep = byPassOn || byReviewerOn;
  let byPass: ByPassSection | null = null;
  let byReviewer: ByReviewerSection | null = null;
  let collected: Collected;
  const tmp = await mkdtemp(join(tmpdir(), "pr-review-eval-report-"));
  try {
    // Each case is cloned once, at its first repeat that needs a score.
    const clones = new Map<string, Promise<string>>();
    const checkoutOf = (c: Case) => (): Promise<string> => {
      let clone = clones.get(c.name);
      if (clone === undefined) {
        clone = cloneCase(c, join(tmp, c.name));
        clones.set(c.name, clone);
      }
      return clone;
    };
    let asked: ByPassSection["ask_missing"] = null;
    let askedReviewer: ByReviewerSection["ask_missing"] = null;
    if (keep && opts.askMissing === true) {
      const first = await collect(cases, out, checkoutOf, true, true);
      const client = await clientOf();
      const allowApiKey = opts.allowApiKey === true;
      if (byPassOn) {
        asked = (await byPassSection(first.inputs, [], client, allowApiKey)).ask_missing;
      }
      if (byReviewerOn) {
        askedReviewer = (await byReviewerSection(first.reviewerInputs, client, allowApiKey))
          .ask_missing;
      }
    }
    collected = await collect(cases, out, checkoutOf, keep, false);
    if (byPassOn) {
      byPass = await byPassSection(collected.inputs, collected.missing, null, false);
      byPass.ask_missing = asked;
    }
    if (byReviewerOn) {
      byReviewer = await byReviewerSection(collected.reviewerInputs, null, false);
      byReviewer.ask_missing = askedReviewer;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const report = buildReport(collected.results, null, await casesRef(opts.cases), {
    uncached: collected.uncached,
  });
  if (byPass !== null) report.by_pass = byPass;
  if (byReviewer !== null) report.by_reviewer = byReviewer;
  // Stage 1 records post nothing, so the posted figures show as none, as
  // the eval with --stage1 shows them.
  if (collected.modes.length > 0 && collected.modes.every((m) => m === "stage1")) {
    report.mode = "stage1";
  }
  const notValid = notValidLines(report.paired as PairedSection);
  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    for (const line of notValid) say(line);
  } else {
    const top = notValid.length > 0 ? `${notValid.join("\n")}\n\n` : "";
    const tail = byPass !== null ? `${renderByPass(byPass).join("\n")}\n` : "";
    process.stdout.write(`${top}${renderTable(report)}${tail}`);
  }
  return EXIT_OK;
}
