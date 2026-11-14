// The offline report (D8): score the run records of an earlier eval in its
// --out directory against the cases again, with no model call. The judge
// answers come from the cache file of each repeat. A question with no
// cached answer counts as no match, and the report says so.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EXIT_OK, EXIT_USAGE } from "../cli.js";
import { isRecordFileName } from "../record/write.js";
import { RecordSchema, type RunRecord } from "../schemas/record.js";
import { CaseError, casesRef, loadCases, type Case } from "./case.js";
import { JUDGE_CACHE_FILE, readJudgeCache } from "./judge-cache.js";
import { failedMetrics, metrics, type RepeatMetrics } from "./metrics.js";
import { hasSources, notValidLines, pairedRepeat, type PairedSection } from "./paired.js";
import { buildReport, renderTable } from "./report.js";
import { readResult } from "./run.js";
import { scoreRecord, type ScoreJudge } from "./score.js";

/** The flags of "pr-review eval-report". */
export type EvalReportOptions = { cases: string; out: string; format: "table" | "json" };

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
  } catch {
    return [];
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

type Scored = { metrics: RepeatMetrics; uncached: number };

// Score one repeat again from its record and its judge cache. A repeat
// that failed in the eval keeps its metrics.
async function scoreRepeat(c: Case, dir: string, repeat: number): Promise<Scored> {
  const result = await readResult(join(dir, "result.json"), repeat);
  if (result === null) {
    return { metrics: failedMetrics(repeat, `no valid result.json in ${dir}`, 0), uncached: 0 };
  }
  if (result.metrics.failed) return { metrics: result.metrics, uncached: 0 };
  const record = await readRecord(dir, result.record);
  const judge: ScoreJudge = {
    client: null,
    model: result.options.judge_model,
    options: { allowApiKey: false, env: {} },
    cache: await readJudgeCache(join(dir, JUDGE_CACHE_FILE)),
  };
  // No query goes out, so the head checkout is never read.
  const score = await scoreRecord(record, c.golden, dir, judge, {
    extras: result.options.extras,
    rawJudge: result.options.raw_judge,
  });
  const m = metrics(record, score, repeat);
  let uncached = score.uncached;
  if (hasSources(record)) {
    const p = await pairedRepeat(
      record,
      c.golden,
      dir,
      judge,
      { rawJudge: result.options.raw_judge },
      score,
    );
    m.paired = p.paired;
    uncached += p.uncached;
  } else {
    m.paired = null;
  }
  return { metrics: m, uncached };
}

/**
 * Print the report of the records in the --out directory: the normal
 * metrics and the paired section. Give 0, or 2 for an invalid case.
 */
export async function runEvalReport(opts: EvalReportOptions): Promise<number> {
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
  for (const c of cases) {
    const caseDir = join(out, c.name);
    const repeats: RepeatMetrics[] = [];
    for (const repeat of await repeatNumbers(caseDir)) {
      const dir = join(caseDir, String(repeat));
      try {
        const scored = await scoreRepeat(c, dir, repeat);
        repeats.push(scored.metrics);
        if (scored.uncached > 0) uncached.push({ case: c.name, repeat, pairs: scored.uncached });
      } catch (err) {
        repeats.push(failedMetrics(repeat, messageOf(err), 0));
      }
    }
    if (repeats.length > 0) results.push({ name: c.name, repeats });
  }
  const report = buildReport(results, null, await casesRef(opts.cases), { uncached });
  const notValid = notValidLines(report.paired as PairedSection);
  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    for (const line of notValid) say(line);
  } else {
    const top = notValid.length > 0 ? `${notValid.join("\n")}\n\n` : "";
    process.stdout.write(`${top}${renderTable(report)}`);
  }
  return EXIT_OK;
}
