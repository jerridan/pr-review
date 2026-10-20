// The eval command: validate the cases, review each case several times in
// sequence, score each record against the golden findings of its case,
// and report the metrics. The gate compares the report with a baseline.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_FAILURE, EXIT_GATE, EXIT_OK, EXIT_USAGE, type ProgramDeps } from "../cli.js";
import { JUDGE_DEFAULTS, ROLE_DEFAULTS, resolveModel } from "../config/models.js";
import { loadRepoConfig } from "../config/repo-config.js";
import { effectiveModel, loadBuiltinReviewers } from "../reviewers/loader.js";
import { runReview } from "../run.js";
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
import { CaseError, casesRef, loadCases, type Case } from "./case.js";
import { cloneCase } from "./checkout.js";
import { failedMetrics, metrics, type RepeatMetrics } from "./metrics.js";
import { buildReport, renderTable, type Report } from "./report.js";
import { scoreRecord } from "./score.js";

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
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function say(message: string): void {
  process.stderr.write(`pr-review eval: ${message}\n`);
}

function toolVersion(): string {
  // This file is at src/eval/run.ts and at dist/eval/run.js. package.json
  // is two levels up.
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
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
async function judgeModelReviewers(
  clone: string,
  c: Case,
  tier: Tier,
  judgeModel: string,
): Promise<string[]> {
  if (tier === "skip") return [];
  let loaded;
  try {
    loaded = await loadRepoConfig(clone, c.base);
  } catch {
    return [];
  }
  const { config } = loaded;
  return [...loadBuiltinReviewers(), ...loaded.customReviewers]
    .filter((def) => TIER_RANK[def.frontmatter.triggers.min_tier] <= TIER_RANK[tier])
    .filter((def) => config.reviewers[def.frontmatter.name]?.enabled !== false)
    .filter((def) => effectiveModel(def, config).model === judgeModel)
    .map((def) => def.frontmatter.name);
}

type SameJudge = { case: string; reviewers: string[] };

// Clone the bundle of each case once, so a sha that does not resolve
// stops the eval before any model call. Unless --allow-same-judge is
// given, give the first case whose reviewers use the judge model.
async function checkCases(
  cases: Case[],
  opts: EvalOptions,
  judgeModel: string,
): Promise<SameJudge | null> {
  const root = await mkdtemp(join(tmpdir(), "pr-review-eval-check-"));
  try {
    for (const c of cases) {
      const clone = await cloneCase(c, join(root, c.name));
      if (opts.allowSameJudge) continue;
      const reviewers = await judgeModelReviewers(clone, c, opts.tier, judgeModel);
      if (reviewers.length > 0) return { case: c.name, reviewers };
    }
    return null;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  { kind: "done"; metrics: RepeatMetrics } | { kind: "same-judge"; reviewers: string[] };

type EvalContext = {
  opts: EvalOptions;
  out: string;
  client: SdkClient;
  options: RunOptions;
  judgeModel: string;
};

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
  const failed = (error: string): RepeatOutcome => ({
    kind: "done",
    metrics: failedMetrics(repeat, error, Math.round(performance.now() - start)),
  });
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
      description: { title: c.title, body: c.body },
      client: ctx.client,
    });
    if (result.exitCode !== 0) return failed(result.error ?? "The run exited with code 1.");
    // An incomplete review exits 0, but its findings do not show the
    // reviewers. A score of it would be wrong, so the repeat fails.
    if (result.record.posted.verdict === "incomplete")
      return failed(incompleteMessage(result.record));
    const same = result.record.identity.selected_reviewers.filter(
      (r) => r.model === ctx.judgeModel,
    );
    if (same.length > 0 && !ctx.opts.allowSameJudge) {
      return { kind: "same-judge", reviewers: same.map((r) => r.name) };
    }
    const score = await scoreRecord(result.record, c.golden, checkout, {
      client: ctx.client,
      model: ctx.judgeModel,
      options: ctx.options,
    });
    return { kind: "done", metrics: metrics(result.record, score, c.golden.length, repeat) };
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
 * configuration error, 3 when the gate failed. Exit code 1 wins over 3.
 */
export async function runEval(opts: EvalOptions, deps: ProgramDeps): Promise<number> {
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
  let sameJudge: SameJudge | null;
  try {
    cases = await loadCases(opts.cases);
    sameJudge = await checkCases(cases, opts, judgeModel);
  } catch (err) {
    if (!(err instanceof CaseError)) throw err;
    say(err.message);
    return EXIT_USAGE;
  }
  if (sameJudge !== null) {
    say(sameJudgeMessage(`case ${sameJudge.case}`, sameJudge.reviewers, judgeModel));
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
  };

  // The runs go in sequence: case by case, and repeat by repeat.
  const results: { name: string; repeats: RepeatMetrics[] }[] = [];
  for (const c of cases) {
    const repeats: RepeatMetrics[] = [];
    for (let repeat = 1; repeat <= opts.repeat; repeat++) {
      const outcome = await runRepeat(ctx, c, repeat);
      // The pre-flight catches a config that gives a reviewer the judge
      // model. This check stays as a safety net for a model that only the
      // run can see.
      if (outcome.kind === "same-judge") {
        say(sameJudgeMessage(`case ${c.name}, repeat ${repeat}`, outcome.reviewers, judgeModel));
        return EXIT_USAGE;
      }
      repeats.push(outcome.metrics);
    }
    results.push({ name: c.name, repeats });
  }

  let report: Report = buildReport(results, null, ref);
  const failed = report.failed_repeats.length > 0;
  let runError: string | null = null;
  if (base.gate) {
    const known = base.gate.cases_ref;
    if (known !== null && ref !== null && known !== ref) {
      say(
        `warning: the baseline has the cases ref ${known}, but the cases are at ${ref}. ` +
          "A change of the case set needs a new baseline.",
      );
    }
    report = buildReport(results, compareBaseline(base.gate, report), ref);
  } else if (opts.writeBaseline && opts.baseline !== undefined) {
    if (failed) {
      say(`a repeat failed, so the baseline ${opts.baseline} does not change.`);
    } else {
      try {
        await writeBaseline(opts.baseline, report, base.existing, {
          repeat: opts.repeat,
          tool_version: toolVersion(),
        });
      } catch (err) {
        runError = messageOf(err);
      }
    }
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), json);
  process.stdout.write(
    opts.format === "json" ? json : renderTable(report, base.gate?.cases_ref ?? null),
  );

  for (const f of report.failed_repeats) {
    say(`case ${f.case}, repeat ${f.repeat} failed: ${f.error}`);
  }
  if (runError !== null) say(runError);
  // A judge answer of "unknown", or a judge query that failed, counts as no
  // match. Say so, because it lowers recall and precision with no other sign.
  if (report.judge.unknown > 0) {
    say(
      `warning: ${report.judge.unknown} of ${report.judge.calls} judge queries gave no answer. ` +
        "The eval counts each one as no match.",
    );
  }
  if (report.gate && !report.gate.passed) say(gateMessage(report.gate));
  if (failed || runError !== null) return EXIT_FAILURE;
  if (report.gate && !report.gate.passed) return EXIT_GATE;
  return EXIT_OK;
}
