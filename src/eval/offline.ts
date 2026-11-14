// The offline report (D8): score the run records of an earlier eval in its
// --out directory against the cases again, with no model call. It clones
// each case, because the key of a judge answer holds the head lines and
// the diff that the judge saw. The judge
// answers come from the cache file of each repeat. A question with no
// cached answer counts as no match, and the report says so. With
// --by-pass, it adds the by-pass section (by-pass.ts). With --ask-missing,
// the judge answers the by-pass questions that have no cached answer, and
// those answers go into the cache file of the repeat.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_OK, EXIT_USAGE } from "../cli.js";
import { isRecordFileName } from "../record/write.js";
import { RecordSchema, type RunRecord } from "../schemas/record.js";
import type { SdkClient } from "../sdk/client.js";
import {
  byPassRecord,
  emptySection,
  multiPassReviewers,
  renderByPass,
  summarizeScope,
  type ByPassRow,
  type ByPassSection,
} from "./by-pass.js";
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
  /** Let the judge answer the by-pass questions with no cached answer. Needs byPass. */
  askMissing?: boolean;
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

/** What the by-pass scoring of a repeat needs: a record with source fields. */
type Kept = {
  record: RunRecord;
  head: string;
  cache: JudgeCache;
  cachePath: string;
  judgeModel: string;
  rawJudge: boolean;
};

type Scored = { metrics: RepeatMetrics; uncached: number; kept?: Kept };

// Score one repeat again from its record and its judge cache. A repeat
// that failed in the eval keeps its metrics. "checkout" is a clone of the
// case: the key of each judge answer holds the head lines and the diff
// that the judge saw, so the scoring reads them as the eval did.
async function scoreRepeat(
  c: Case,
  dir: string,
  repeat: number,
  checkout: () => Promise<string>,
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
  let kept: Kept | undefined;
  if (hasSources(record)) {
    kept = {
      record,
      head,
      cache,
      cachePath,
      judgeModel: result.options.judge_model,
      rawJudge: result.options.raw_judge,
    };
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
  return { metrics: m, uncached, ...(kept ? { kept } : {}) };
}

type ByPassInput = { case: Case; repeat: number; kept: Kept };

/**
 * The by-pass section of the kept repeats. The scopes of a repeat are the
 * reviewers that ran two passes in one of its records, and every such
 * reviewer together. With "client", the judge answers each question with
 * no cached answer, and the cache file of the repeat gets the new answers.
 * A cached answer, also "unknown", gets no new query.
 */
async function byPassSection(
  inputs: ByPassInput[],
  missing: ByPassSection["missing"],
  client: SdkClient | null,
): Promise<ByPassSection> {
  let questions = 0;
  let costUsd = 0;
  const numbers = [...new Set(inputs.map((i) => i.repeat))].sort((a, b) => a - b);
  const repeats: ByPassSection["repeats"] = [];
  for (const repeat of numbers) {
    const ours = inputs.filter((i) => i.repeat === repeat);
    const multi = [...new Set(ours.flatMap((i) => multiPassReviewers(i.kept.record)))].sort();
    const scopes = [null, ...multi];
    const rows: ({ case: string } & ByPassRow)[][] = scopes.map(() => []);
    for (const { case: c, kept } of ours) {
      const judge: ScoreJudge = {
        client,
        model: kept.judgeModel,
        options: { allowApiKey: false, env: client === null ? {} : process.env },
        cache: kept.cache,
        // Every cached key counts as asked, so a cached "unknown" gets no
        // new query: the client answers the missing questions only.
        asked: new Set(kept.cache.keys()),
      };
      const scored = await byPassRecord(
        kept.record,
        c.golden,
        kept.head,
        judge,
        scopes,
        multi,
        kept.rawJudge,
      );
      scored.rows.forEach((row, i) => rows[i]?.push({ case: c.name, ...row }));
      questions += scored.judgeCalls;
      costUsd += scored.judgeCostUsd;
      if (scored.judgeCalls > 0) await writeJudgeCache(kept.cachePath, kept.cache);
    }
    repeats.push({
      repeat,
      scopes: scopes.map((scope, i) => summarizeScope(scope, rows[i] ?? [])),
    });
  }
  return {
    ...emptySection(missing, client === null ? null : { questions, cost_usd: costUsd }),
    repeats,
  };
}

/**
 * Print the report of the records in the --out directory: the normal
 * metrics and the paired section. Give 0, or 2 for an invalid case.
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
  const results: { name: string; repeats: RepeatMetrics[] }[] = [];
  const uncached: PairedSection["uncached"] = [];
  const byPassInputs: ByPassInput[] = [];
  const byPassMissing: ByPassSection["missing"] = [];
  let byPass: ByPassSection | null = null;
  const tmp = await mkdtemp(join(tmpdir(), "pr-review-eval-report-"));
  try {
    for (const c of cases) {
      const caseDir = join(out, c.name);
      const repeats: RepeatMetrics[] = [];
      // The case is cloned once, at its first repeat that needs a score.
      let clone: Promise<string> | null = null;
      const checkout = (): Promise<string> => (clone ??= cloneCase(c, join(tmp, c.name)));
      for (const repeat of await repeatNumbers(caseDir)) {
        const dir = join(caseDir, String(repeat));
        try {
          const scored = await scoreRepeat(c, dir, repeat, checkout);
          repeats.push(scored.metrics);
          if (scored.uncached > 0) uncached.push({ case: c.name, repeat, pairs: scored.uncached });
          if (scored.kept) byPassInputs.push({ case: c, repeat, kept: scored.kept });
          else
            byPassMissing.push({
              case: c.name,
              repeat,
              reason: scored.metrics.failed ? "failed repeat" : NO_SOURCES,
            });
        } catch (err) {
          repeats.push(failedMetrics(repeat, messageOf(err), 0));
          byPassMissing.push({ case: c.name, repeat, reason: "failed repeat" });
          say(`case ${c.name}, repeat ${repeat}: ${messageOf(err)}`);
        }
      }
      if (repeats.length > 0) results.push({ name: c.name, repeats });
    }
    if (opts.byPass === true) {
      const client = opts.askMissing === true ? await clientOf() : null;
      byPass = await byPassSection(byPassInputs, byPassMissing, client);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const report = buildReport(results, null, await casesRef(opts.cases), { uncached });
  if (byPass !== null) report.by_pass = byPass;
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
