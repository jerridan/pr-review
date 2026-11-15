#!/usr/bin/env node
// The pr-review command line. Exit codes of run: 0 when a run writes a
// record, 1 when a run cannot write a record or cannot post the review that
// --format github asked for, 2 on a usage error. Exit codes of eval: 0 when
// the gate passed or did not run, 1 for a failed repeat or a run error, 2
// for a usage error, an invalid case or a configuration error, 3 when the
// gate failed, 4 when --max-cost stopped the eval. Exit codes of explain: 0 on success, 2 for a usage error or
// a file that is missing, is not JSON, or is not a run record. Exit codes
// of label: 0 when every call succeeded, 1 when a case checkout failed or a
// call failed after its retry, 2 on a usage error. The exit codes of pool
// and adjudicate are in src/eval/pool/index.ts.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import {
  EFFORTS,
  JUDGE_DEFAULTS,
  ROLE_DEFAULTS,
  resolveModel,
  type Effort,
} from "./config/models.js";
import { registerLabelCommand } from "./eval/label/index.js";
import { registerPoolCommands } from "./eval/pool/index.js";
import { codexReviewCommand } from "./eval/codex-review.js";
import { injectionReportCommand } from "./eval/injection/report.js";
import { injectionVariantsCommand } from "./eval/injection/variants.js";
import { runEvalReport } from "./eval/offline.js";
import { runEval } from "./eval/run.js";
import { runEvalSizes } from "./eval/sizes.js";
import { BOOTSTRAP_SEED } from "./eval/bootstrap.js";
import { BACKENDS, type VerifierSpec } from "./eval/replay/backend.js";
import { PROMPT_FORMS, type PromptForm } from "./eval/replay/forms.js";
import type { SampleKind } from "./eval/replay/candidates.js";
import { REPLAY_NOTE, runReplay } from "./eval/replay/index.js";
import { SEVERITY_MODES, type SeveritySpec } from "./eval/replay/severity.js";
import { runEvalSubset } from "./eval/subset.js";
import { explain } from "./explain/index.js";
import { renderExplainJson, renderExplainTable } from "./explain/format.js";
import { readFile } from "node:fs/promises";
import { RecordSchema } from "./schemas/record.js";
import type { GitHubClient } from "./github/client.js";
import { formatJson } from "./output/json.js";
import { formatTable } from "./output/table.js";
import { loadPrompt } from "./prompts/load.js";
import type { ModelPick, RunModels } from "./reviewers/loader.js";
import { DEFAULT_CONCURRENCY, runReview } from "./run.js";
import type { SdkClient } from "./sdk/client.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
/** The eval gate failed. */
export const EXIT_GATE = 3;
/** A dollar limit (--max-cost) stopped the command before all of its work. */
export const EXIT_STOPPED = 4;

/** The trivial schema of the smoke query. */
export const SmokeOutputSchema = z.strictObject({ ok: z.boolean(), word: z.string() });
export type SmokeOutput = z.infer<typeof SmokeOutputSchema>;

interface RunCliOptions {
  base?: string;
  head?: string;
  pr?: number;
  githubRepo?: string;
  fresh?: boolean;
  repo?: string;
  format: "json" | "table" | "github";
  out?: string;
  tier?: "full" | "fast" | "skip";
  allowApiKey?: boolean;
  authorWriteAccess?: boolean;
}

interface EvalCliOptions {
  cases: string;
  repeat: number;
  baseline?: string;
  writeBaseline?: boolean;
  out: string;
  format: "table" | "json";
  tier: "full" | "fast" | "skip";
  judgeModel?: string;
  allowApiKey?: boolean;
  allowSameJudge?: boolean;
  /** Commander gives false for --no-extras, and true by default. */
  extras: boolean;
  rawJudge?: boolean;
  resume?: boolean;
  paired?: boolean;
  reviewers?: string[];
  passes?: Record<string, number>;
  models?: RunModels;
  maxCost?: number;
  stage1?: boolean;
}

interface EvalReportCliOptions {
  cases: string;
  out: string;
  format: "table" | "json";
  byPass?: boolean;
  byReviewer?: boolean;
  askMissing?: boolean;
  allowApiKey?: boolean;
}

// Commander exits with 1 on a usage error. This makes it 2. Help and
// version keep 0. The callback throws, so commander does not call
// process.exit, and the caller of parseAsync sets the exit code.
function exitOverride(err: CommanderError): never {
  if (err.exitCode === EXIT_OK) throw err;
  throw new CommanderError(EXIT_USAGE, err.code, err.message);
}

// The SDK loads only when a command needs the real client, so tests that
// give a fake client never load it.
async function clientFrom(deps: ProgramDeps): Promise<SdkClient> {
  if (deps.client) return deps.client;
  const { createSdkClient } = await import("./sdk/client.js");
  return createSdkClient();
}

/** The dependencies a test can replace. Each absent one is the real one. */
export type ProgramDeps = { client?: SdkClient; github?: GitHubClient };

// Parse --pr: a positive integer.
function parsePrNumber(value: string): number {
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Give the pull request number as a positive integer.");
  }
  return n;
}

// Parse --repeat: a positive integer.
function parseRepeat(value: string): number {
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Give the repeat count as a positive integer.");
  }
  return n;
}

// Parse --reviewers: names with commas between them.
function parseReviewers(value: string): string[] {
  const names = value.split(",").map((n) => n.trim());
  if (names.some((n) => n === "")) {
    throw new InvalidArgumentError("Give the reviewer names with commas between them.");
  }
  return [...new Set(names)];
}

// Parse --passes: name=n pairs with commas between them, n a positive integer.
function parsePasses(value: string): Record<string, number> {
  const passes: Record<string, number> = {};
  for (const part of value.split(",")) {
    const match = /^\s*([^=\s]+)\s*=\s*([1-9][0-9]*)\s*$/.exec(part);
    if (!match) {
      throw new InvalidArgumentError(
        `Give each pair as name=n, with n a positive integer, not "${part}".`,
      );
    }
    passes[match[1] as string] = Number(match[2]);
  }
  return passes;
}

// Parse --models: target=model:effort parts with commas between them. The
// target is a reviewer name or "all". The model is an alias or an exact ID.
function parseModels(value: string): RunModels {
  const models: Record<string, ModelPick> = {};
  for (const part of value.split(",")) {
    const match = /^\s*([^=\s]+)\s*=\s*([^:\s]+)\s*:\s*([^:\s]+)\s*$/.exec(part);
    if (!match) {
      throw new InvalidArgumentError(`Give each part as target=model:effort, not "${part}".`);
    }
    const [, target, alias, effort] = match as unknown as [string, string, string, string];
    const model = parseModel(alias);
    const known = parseEffort(effort, part.trim());
    if (Object.hasOwn(models, target)) {
      throw new InvalidArgumentError(`The target "${target}" is in --models more than once.`);
    }
    models[target] = { model, effort: known };
  }
  return models;
}

// Resolve the model of a --models, --verifier or --severity value: an
// alias or an exact ID. An unknown alias is a usage error.
function parseModel(alias: string): string {
  try {
    return resolveModel(alias);
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
  }
}

// Parse the effort of a --models, --verifier or --severity value.
function parseEffort(effort: string, value: string): Effort {
  const known = EFFORTS.find((e) => e === effort.toLowerCase());
  if (known === undefined) {
    throw new InvalidArgumentError(
      `Unknown effort "${effort}" in "${value}". Use ${EFFORTS.join(", ")}.`,
    );
  }
  return known;
}

// Split a "first:model:effort" value into its three parts.
function threeParts(value: string, first: string): [string, string, string] {
  const parts = value.split(":").map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p === "")) {
    throw new InvalidArgumentError(`Give the value as ${first}:model:effort, not "${value}".`);
  }
  return parts as [string, string, string];
}

// Parse --verifier: backend:model:effort. A claude model is an alias or an
// exact ID. A codex model goes to the Codex call as it is.
function parseVerifier(value: string): VerifierSpec {
  const [backend, model, effort] = threeParts(value, "backend");
  const known = BACKENDS.find((b) => b === backend);
  if (known === undefined) {
    throw new InvalidArgumentError(`Unknown backend "${backend}". Use ${BACKENDS.join(" or ")}.`);
  }
  const resolved = known === "claude" ? parseModel(model) : model;
  return { backend: known, model: resolved, effort: parseEffort(effort, value) };
}

// Parse --severity: mode:model:effort.
function parseSeverity(value: string): SeveritySpec {
  const [mode, model, effort] = threeParts(value, "mode");
  const known = SEVERITY_MODES.find((m) => m === mode);
  if (known === undefined) {
    throw new InvalidArgumentError(`Unknown mode "${mode}". Use ${SEVERITY_MODES.join(" or ")}.`);
  }
  return { mode: known, model: parseModel(model), effort: parseEffort(effort, value) };
}

// Parse --sample: all, golden-plus-equal, or a positive integer.
function parseSample(value: string): SampleKind {
  if (value === "all" || value === "golden-plus-equal") return value;
  if (/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  throw new InvalidArgumentError("Give all, golden-plus-equal or a positive integer.");
}

// Parse --seed: an integer of 0 or more.
function parseSeed(value: string): number {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("Give the seed as an integer of 0 or more.");
  }
  return Number(value);
}

// Parse an amount in US dollars: a number of 0 or more.
function parseUsd(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError("Give the amount in US dollars as a number of 0 or more.");
  }
  return n;
}

// Parse --verifier-cap: a number above 0.
function parseCap(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError("Give the cap in US dollars as a number above 0.");
  }
  return n;
}

// Parse --github-repo: owner/repo.
function parseSlug(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new InvalidArgumentError("Give the repo as owner/repo.");
  }
  return value;
}

function formatCost(costUsd: number | null | undefined): string {
  return typeof costUsd === "number" ? `$${costUsd.toFixed(4)}` : "unknown";
}

async function runSmoke(deps: ProgramDeps, allowApiKey: boolean): Promise<void> {
  const prompt = loadPrompt("smoke.md");
  const userMessage = prompt.frontmatter.user_message;
  if (typeof userMessage !== "string") {
    throw new Error('prompts/smoke.md has no "user_message" string in its frontmatter.');
  }
  const client = await clientFrom(deps);
  const outcome = await client.query<SmokeOutput>(
    {
      role: "smoke",
      systemPrompt: prompt.body,
      userMessage,
      schema: SmokeOutputSchema,
      cwd: process.cwd(),
    },
    { allowApiKey, env: process.env },
  );
  const model = outcome.raw?.model ?? resolveModel(ROLE_DEFAULTS.smoke.model);
  const lines = [
    `model: ${model}`,
    `cost: ${formatCost(outcome.raw?.costUsd)}`,
    `validated: ${outcome.ok ? "yes" : "no"}`,
  ];
  if (!outcome.ok) {
    lines.push(`failure: ${outcome.failure.kind}: ${outcome.failure.message}`);
    process.exitCode = EXIT_FAILURE;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Explain one run record. A file that is missing, is not JSON, or is not a
// run record exits 2.
async function runExplain(path: string, format: "table" | "json"): Promise<number> {
  const fail = (message: string): number => {
    process.stderr.write(`pr-review explain: ${message}\n`);
    return EXIT_USAGE;
  };
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`cannot read the record ${path}: ${reason}`);
  }
  const parsed = RecordSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail(`${path} is not a run record: ${issues}`);
  }
  const rows = explain(parsed.data);
  process.stdout.write(format === "json" ? renderExplainJson(rows) : renderExplainTable(rows));
  return EXIT_OK;
}

/** The default record directory, relative to the current directory. */
export const DEFAULT_OUT_DIR = "pr-review-records";

// Run one review. A run that writes a record exits 0, whatever its
// verdict. A run that cannot write a record exits 1.
async function runCommand(deps: ProgramDeps, options: RunCliOptions): Promise<void> {
  try {
    const { record, recordPath, reviewUrl, exitCode, error } = await runReview({
      repo: options.repo ?? process.cwd(),
      ...(options.base !== undefined ? { base: options.base } : {}),
      ...(options.head !== undefined ? { head: options.head } : {}),
      ...(options.pr !== undefined ? { pr: options.pr } : {}),
      ...(options.githubRepo !== undefined ? { githubRepo: options.githubRepo } : {}),
      format: options.format,
      ...(options.fresh === true ? { fresh: true } : {}),
      ...(options.tier ? { tierOverride: options.tier } : {}),
      outDir: options.out ?? DEFAULT_OUT_DIR,
      allowApiKey: options.allowApiKey === true,
      authorWriteAccess: options.authorWriteAccess === true,
      ...(deps.client ? { client: deps.client } : {}),
      ...(deps.github ? { github: deps.github } : {}),
    });
    // The github format prints the JSON document with the review url.
    if (options.format === "json" || options.format === "github") {
      // stdout holds one JSON document, so the skip reason goes to stderr.
      if (record.identity.tier === "skip") {
        process.stderr.write(`Skipped: ${record.identity.tier_reason}\n`);
      }
      const extra = options.format === "github" ? { reviewUrl } : undefined;
      process.stdout.write(formatJson(record, recordPath, extra));
    } else {
      process.stdout.write(`${formatTable(record)}\nRecord: ${recordPath}\n`);
    }
    if (error !== null) process.stderr.write(`pr-review run: ${error}\n`);
    process.exitCode = exitCode === 0 ? EXIT_OK : EXIT_FAILURE;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pr-review run: ${message}\n`);
    process.exitCode = EXIT_FAILURE;
  }
}

/** Make the pr-review program. Tests give fake clients in "deps". */
export function createProgram(deps: ProgramDeps): Command {
  const program = new Command();
  program
    .name("pr-review")
    .description("Review the diff between two commits with Claude agents.")
    .exitOverride(exitOverride);

  program
    .command("run")
    .description("Review the diff between two commits and write a run record.")
    .option("--base <sha>", "the base commit (default with --pr: the base of the pull request)")
    .option("--head <sha>", "the head commit (default with --pr: the head of the pull request)")
    .option("--pr <n>", "the pull request number; read the pull request through gh", parsePrNumber)
    .option(
      "--github-repo <owner/repo>",
      "the repo of the pull request (default: from the origin remote)",
      parseSlug,
    )
    .option(
      "--fresh",
      "with --pr, review the whole pull request again as a first run; open and dismissed findings still do not post again",
    )
    .option("--repo <path>", "the repo to review (default: the current directory)")
    .addOption(
      new Option("--format <format>", "the output format; github needs --pr")
        .choices(["json", "table", "github"])
        .default("table"),
    )
    .option("--out <dir>", "the record directory (default: ./pr-review-records)")
    .addOption(
      new Option("--tier <tier>", "set the tier, over every other rule").choices([
        "full",
        "fast",
        "skip",
      ]),
    )
    .option(
      "--allow-api-key",
      "keep ANTHROPIC_API_KEY and the other provider variables in the SDK environment",
    )
    .option(
      "--author-write-access",
      "the PR author has write access, so a trusted custom reviewer may use Bash",
    )
    .action(async (options: RunCliOptions, command: Command) => {
      // A usage error exits 2 through exitOverride.
      if (options.pr === undefined && (options.base === undefined || options.head === undefined)) {
        command.error("error: give --base and --head, or give --pr", { exitCode: EXIT_USAGE });
      }
      if (options.format === "github" && options.pr === undefined) {
        command.error("error: --format github needs --pr", { exitCode: EXIT_USAGE });
      }
      await runCommand(deps, options);
    });

  program
    .command("eval")
    .description(
      "Review each case of a cases directory several times, score the findings against the golden findings, and report.",
    )
    .requiredOption("--cases <dir>", "the cases directory, with one subdirectory per case")
    .option("--repeat <n>", "the number of runs of each case, a positive integer", parseRepeat, 3)
    .option("--baseline <file>", "the baseline file for the gate (default: no gate)")
    .option(
      "--write-baseline",
      "write the aggregate of the eval to the --baseline file; no gate runs",
    )
    .option("--out <dir>", "the directory for every run record and report.json", "pr-review-eval")
    .addOption(
      new Option("--format <format>", "the format of the report on stdout")
        .choices(["table", "json"])
        .default("table"),
    )
    .addOption(
      new Option("--tier <tier>", "the tier of every run")
        .choices(["full", "fast", "skip"])
        .default("full"),
    )
    .option(
      "--judge-model <id>",
      `the model of the judge, an alias or an exact ID (default: ${JUDGE_DEFAULTS.model}, the judge role default)`,
    )
    .option(
      "--allow-api-key",
      "keep ANTHROPIC_API_KEY and the other provider variables in the SDK environment, also for the judge",
    )
    .option("--allow-same-judge", "allow the judge model to equal a reviewer model")
    .option(
      "--no-extras",
      "do not ask the extras judge about the posted findings that match no golden finding",
    )
    .option(
      "--raw-judge",
      "also ask the judge about the ambiguous pairs of the raw candidates (default: exact matches only)",
    )
    .option(
      "--resume",
      "reuse the finished repeats that the --out directory holds, and run the others",
    )
    .option(
      "--paired",
      "also score the findings of pass 1 against all the findings, and report the paired difference",
    )
    .option(
      "--reviewers <name,...>",
      "run only these reviewers; each one still needs the tier and its triggers",
      parseReviewers,
    )
    .option(
      "--passes <name=n,...>",
      "set the passes of these reviewers for every run, over the repo config and the frontmatter",
      parsePasses,
    )
    .option(
      "--models <spec>",
      "target=model:effort pairs with commas between them; set the model and effort of reviewers " +
        "for every run, over the repo config and the frontmatter; a target is a reviewer name " +
        'or "all", and a name wins over "all"',
      parseModels,
    )
    .option(
      "--max-cost <usd>",
      "start no new repeat when the repeats of this invocation, with their judge queries, cost " +
        "this many US dollars or more; a repeat that runs at the limit runs to its end, so the " +
        "spend can pass the limit by at most one repeat; --resume continues",
      parseUsd,
    )
    .option(
      "--stage1",
      "run triage and the reviewers only: send no finding to the verifier, the escalation or the merge, score the raw candidates with the raw judge, and report the figures of each reviewer",
    )
    .action(async (options: EvalCliOptions, command: Command) => {
      if (options.writeBaseline === true && options.baseline === undefined) {
        command.error("error: --write-baseline needs --baseline", { exitCode: EXIT_USAGE });
      }
      if (options.stage1 === true && (options.paired === true || options.baseline !== undefined)) {
        command.error(
          "error: --stage1 posts no finding, so do not give --paired, --baseline or --write-baseline",
          { exitCode: EXIT_USAGE },
        );
      }
      const limited =
        options.reviewers !== undefined ||
        options.passes !== undefined ||
        options.models !== undefined;
      if (limited && options.baseline !== undefined) {
        command.error(
          "error: a run with --reviewers, --passes or --models is not comparable to the baseline, so do not give --baseline or --write-baseline",
          { exitCode: EXIT_USAGE },
        );
      }
      if (options.passes !== undefined && options.tier === "fast") {
        command.error("error: --passes does not apply with --tier fast, which runs one pass", {
          exitCode: EXIT_USAGE,
        });
      }
      try {
        process.exitCode = await runEval(
          {
            cases: options.cases,
            repeat: options.repeat,
            ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
            writeBaseline: options.writeBaseline === true,
            out: options.out,
            format: options.format,
            tier: options.tier,
            ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
            allowApiKey: options.allowApiKey === true,
            allowSameJudge: options.allowSameJudge === true,
            extras: options.extras,
            rawJudge: options.rawJudge === true,
            resume: options.resume === true,
            paired: options.paired === true,
            ...(options.reviewers !== undefined ? { reviewers: options.reviewers } : {}),
            ...(options.passes !== undefined ? { passes: options.passes } : {}),
            ...(options.models !== undefined ? { models: options.models } : {}),
            ...(options.maxCost !== undefined ? { maxCost: options.maxCost } : {}),
            ...(options.stage1 === true ? { stage1: true } : {}),
          },
          deps,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pr-review eval: ${message}\n`);
        process.exitCode = EXIT_FAILURE;
      }
    });

  program
    .command("eval-report")
    .description(
      "Score the run records of an earlier eval again from its judge cache, with no model call, and print the report with the paired section.",
    )
    .requiredOption("--cases <dir>", "the cases directory of the eval")
    .requiredOption("--out <dir>", "the --out directory of the eval")
    .addOption(
      new Option("--format <format>", "the format of the report on stdout")
        .choices(["table", "json"])
        .default("table"),
    )
    .option(
      "--by-pass",
      "add the by-pass section: pass 1, pass 2 and both, of each reviewer with two passes",
    )
    .option(
      "--by-reviewer",
      "add the by-reviewer section: the raw candidates of each reviewer and of all reviewers, matched with the raw judge, with the cost of the reviewer queries",
    )
    .option(
      "--ask-missing",
      "with --by-pass or --by-reviewer, ask the judge the questions of those sections that have no answer or a failed one, and cache the answers",
    )
    .option(
      "--allow-api-key",
      "with --ask-missing, keep ANTHROPIC_API_KEY and the other provider variables in the SDK environment of the judge",
    )
    .action(async (options: EvalReportCliOptions, command: Command) => {
      if (options.askMissing === true && options.byPass !== true && options.byReviewer !== true) {
        command.error("error: --ask-missing needs --by-pass or --by-reviewer", {
          exitCode: EXIT_USAGE,
        });
      }
      try {
        process.exitCode = await runEvalReport(options, () => clientFrom(deps));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pr-review eval-report: ${message}\n`);
        process.exitCode = EXIT_FAILURE;
      }
    });

  program
    .command("eval-subset")
    .description(
      "Make a cases directory that leaves out the expensive cases, by the cost per run of each case in an earlier eval.",
    )
    .requiredOption("--cases <dir>", "the cases directory")
    .requiredOption(
      "--costs <source>",
      "the costs: the report.json or the --out directory of an eval, or a baseline file with the cost per case",
    )
    .option("--max-cost <usd>", "leave out each case whose cost per run is above this", parseUsd)
    .option(
      "--budget <usd>",
      "leave out the most expensive cases until --repeats runs of the rest fit this",
      parseUsd,
    )
    .option("--repeats <n>", "the repeats that the budget must hold, with --budget", parseRepeat)
    .requiredOption("--to <dir>", "the new cases directory; it must not exist")
    .action(
      async (
        options: {
          cases: string;
          costs: string;
          to: string;
          maxCost?: number;
          budget?: number;
          repeats?: number;
        },
        command: Command,
      ) => {
        const budget = options.budget !== undefined || options.repeats !== undefined;
        if ((options.maxCost !== undefined) === budget) {
          command.error("error: give --max-cost, or give --budget and --repeats", {
            exitCode: EXIT_USAGE,
          });
        }
        if (budget && (options.budget === undefined || options.repeats === undefined)) {
          command.error("error: --budget needs --repeats, and --repeats needs --budget", {
            exitCode: EXIT_USAGE,
          });
        }
        try {
          process.exitCode = await runEvalSubset({
            cases: options.cases,
            costs: options.costs,
            to: options.to,
            mode:
              options.maxCost !== undefined
                ? { kind: "max-cost", maxCost: options.maxCost }
                : {
                    kind: "budget",
                    budget: options.budget ?? 0,
                    repeats: options.repeats ?? 1,
                  },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`pr-review eval-subset: ${message}\n`);
          process.exitCode = EXIT_FAILURE;
        }
      },
    );

  program
    .command("replay")
    .description(
      "Verify the stored candidates of an eval again with the first verifier of one arm, and report the figures. " +
        REPLAY_NOTE,
    )
    .requiredOption("--cases <dir>", "the cases directory of the eval")
    .option("--from <dir>", "the --out directory of the eval: the run record of each case")
    .option("--repeat <n>", "the repeat of the --from records, a positive integer", parseRepeat, 1)
    .option(
      "--candidates <dir>",
      'candidates from a reviewer outside the pipeline: <case>.json files of { "source", "findings" }',
    )
    .option("--reviewers <name,...>", "keep only the candidates of these sources", parseReviewers)
    .option(
      "--verifier <backend:model:effort>",
      "the verifier of the arm: backend claude or codex",
      parseVerifier,
    )
    .addOption(
      new Option("--prompt <form>", "the prompt form of the verifier")
        .choices([...PROMPT_FORMS])
        .default("score"),
    )
    .addOption(
      new Option(
        "--arm <arm>",
        "stored: the stored first results, with no verifier call; the golden match can still ask the judge for questions that the cache of --from does not hold, and --max-cost counts those calls",
      ).choices(["stored"]),
    )
    .option(
      "--severity <mode:model:effort>",
      "the severity step: mode finding (one call per candidate) or pr (one call per case)",
      parseSeverity,
    )
    .requiredOption("--out <dir>", "the directory of the results, one arm per directory")
    .option("--resume", "reuse the finished results of the same arm in --out")
    .option(
      "--concurrency <n>",
      "the calls at once, a positive integer",
      parseRepeat,
      DEFAULT_CONCURRENCY,
    )
    .option(
      "--max-cost <usd>",
      "start no new call when the calls of this invocation cost this many US dollars or more; " +
        "the calls in flight run to their end, so the spend can pass the limit by at most the " +
        "concurrency times the largest dollar cap of one call (the larger of --verifier-cap and the severity cap: $1 with --severity pr, else $0.50)",
      parseUsd,
    )
    .option(
      "--verifier-cap <usd>",
      "the dollar cap of one verifier call of the arm, a positive number (default: the cap of the verifier role); the codex backend has no dollar cap and ignores it",
      parseCap,
    )
    .option(
      "--sample <kind>",
      "all, golden-plus-equal, or a count of candidates (default: all)",
      parseSample,
    )
    .option("--seed <n>", `the seed of the sample (default: ${BOOTSTRAP_SEED})`, parseSeed)
    .addOption(
      new Option("--format <format>", "the format of the report on stdout")
        .choices(["table", "json"])
        .default("table"),
    )
    .option(
      "--allow-api-key",
      "keep ANTHROPIC_API_KEY and the other provider variables in the SDK environment",
    )
    .action(
      async (
        options: {
          cases: string;
          from?: string;
          repeat: number;
          candidates?: string;
          reviewers?: string[];
          verifier?: VerifierSpec;
          prompt: PromptForm;
          arm?: "stored";
          severity?: SeveritySpec;
          out: string;
          resume?: boolean;
          concurrency: number;
          maxCost?: number;
          verifierCap?: number;
          sample?: SampleKind;
          seed?: number;
          format: "table" | "json";
          allowApiKey?: boolean;
        },
        command: Command,
      ) => {
        if ((options.arm === undefined) === (options.verifier === undefined)) {
          command.error(
            options.arm === undefined
              ? "error: give --verifier or --arm stored"
              : "error: give --verifier or --arm stored, not both",
            { exitCode: EXIT_USAGE },
          );
        }
        try {
          process.exitCode = await runReplay(
            {
              cases: options.cases,
              ...(options.from !== undefined ? { from: options.from } : {}),
              repeat: options.repeat,
              ...(options.candidates !== undefined ? { candidates: options.candidates } : {}),
              ...(options.reviewers !== undefined ? { reviewers: options.reviewers } : {}),
              arm:
                options.verifier !== undefined
                  ? { kind: "verifier", verifier: options.verifier, form: options.prompt }
                  : { kind: "stored" },
              ...(options.severity !== undefined ? { severity: options.severity } : {}),
              out: options.out,
              resume: options.resume === true,
              concurrency: options.concurrency,
              ...(options.maxCost !== undefined ? { maxCost: options.maxCost } : {}),
              ...(options.verifierCap !== undefined ? { verifierCap: options.verifierCap } : {}),
              sample: options.sample ?? "all",
              seed: options.seed ?? BOOTSTRAP_SEED,
              format: options.format,
              allowApiKey: options.allowApiKey === true,
            },
            () => clientFrom(deps),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`pr-review replay: ${message}\n`);
          process.exitCode = EXIT_FAILURE;
        }
      },
    );

  program
    .command("eval-sizes")
    .description(
      "Count the changed lines of each case from its diff.patch, and split the cases into three size groups, with no model call and no clone.",
    )
    .requiredOption("--cases <dir>", "the cases directory")
    .addOption(
      new Option("--format <format>", "the format of the output on stdout")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(async (options: { cases: string; format: "table" | "json" }) => {
      try {
        process.exitCode = await runEvalSizes(options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pr-review eval-sizes: ${message}\n`);
        process.exitCode = EXIT_FAILURE;
      }
    });

  program
    .command("explain")
    .description("Show why each finding of a run record was kept or dropped.")
    .argument("<record>", "the run record file")
    .addOption(
      new Option("--format <format>", "the output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(async (path: string, options: { format: "table" | "json" }) => {
      process.exitCode = await runExplain(path, options.format);
    });

  program
    .command("smoke")
    .description("Make one structured-output query and show the model, the cost and the result.")
    .option(
      "--allow-api-key",
      "keep ANTHROPIC_API_KEY and the other provider variables in the SDK environment",
    )
    .action(async (options: { allowApiKey?: boolean }) => {
      await runSmoke(deps, options.allowApiKey === true);
    });

  registerLabelCommand(program, deps);
  registerPoolCommands(program, deps);

  // The D4c tools of the Terra and E6 arms. Each command parses its own
  // options, so commander passes every argument through unchanged.
  const passThrough: [string, string, (args: string[]) => Promise<number>][] = [
    [
      "eval-codex-review",
      "Run the general-review prompt through Codex on each case, and write outside candidates.",
      codexReviewCommand,
    ],
    [
      "eval-injection-variants",
      "Make the E6 variant cases of each injection case.",
      injectionVariantsCommand,
    ],
    [
      "eval-injection-report",
      "Report the E6 runs: the share that found the known bug, and the outputs that may follow an instruction.",
      injectionReportCommand,
    ],
  ];
  for (const [name, description, run] of passThrough) {
    program
      .command(name)
      .description(description)
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument("[args...]")
      .action(async (args: string[]) => {
        process.exitCode = await run(args);
      });
  }

  return program;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  createProgram({})
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      if (err instanceof CommanderError) {
        process.exitCode = err.exitCode;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pr-review: ${message}\n`);
      process.exitCode = EXIT_FAILURE;
    });
}
