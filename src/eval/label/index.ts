// The label command: give each golden finding of each case a severity and
// a category under the severity policy. Exit 0 when every call succeeded,
// 1 when a case checkout failed or a call failed after its retry, and 2 on
// a usage error.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommanderError, type Command, InvalidArgumentError, Option } from "commander";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type ProgramDeps } from "../../cli.js";
import type { SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";
import { createSemaphore } from "../../semaphore.js";
import { CaseError, loadCases, type Case } from "../case.js";
import { cloneCase } from "../checkout.js";
import { labelCase } from "./loop.js";
import {
  caseResult,
  json,
  renderLabelTable,
  summaryOf,
  writeCaseFiles,
  writeGolden,
  type CaseResult,
} from "./output.js";
import { readPolicy } from "./policy.js";

/** The flags of "pr-review label". */
export type LabelOptions = {
  cases: string;
  runs: number;
  concurrency: number;
  writeGolden: boolean;
  only?: string;
  out?: string;
  format: "table" | "json";
  allowApiKey: boolean;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function say(message: string): void {
  process.stderr.write(`pr-review label: ${message}\n`);
}

// The SDK loads only when the command needs the real client.
async function clientOf(deps: ProgramDeps): Promise<SdkClient> {
  if (deps.client) return deps.client;
  const { createSdkClient } = await import("../../sdk/client.js");
  return createSdkClient();
}

// Label one case in its own checkout. Give null when the checkout fails.
async function labelOneCase(
  c: Case,
  opts: LabelOptions,
  shared: { client: SdkClient; options: RunOptions; policy: string },
  semaphore: ReturnType<typeof createSemaphore>,
): Promise<CaseResult | null> {
  const tmp = await mkdtemp(join(tmpdir(), "pr-review-label-"));
  try {
    let checkout: string;
    try {
      checkout = await cloneCase(c, join(tmp, "repo"));
    } catch (err) {
      say(messageOf(err));
      return null;
    }
    const ctx = { client: shared.client, options: shared.options, checkout, runs: opts.runs };
    const outcomes = await labelCase(c, ctx, shared.policy, semaphore);
    const result = caseResult(c.name, opts.runs, outcomes);
    const dir = opts.out === undefined ? c.dir : join(resolve(opts.out), c.name);
    await writeCaseFiles(dir, result);
    if (opts.writeGolden) await writeGolden(c.dir, result.labels.findings);
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Run the label command and give its exit code. */
export async function runLabel(opts: LabelOptions, deps: ProgramDeps): Promise<number> {
  let cases: Case[];
  try {
    cases = await loadCases(opts.cases);
  } catch (err) {
    if (!(err instanceof CaseError)) throw err;
    say(err.message);
    return EXIT_USAGE;
  }
  if (opts.only !== undefined) {
    cases = cases.filter((c) => c.name === opts.only);
    if (cases.length === 0) {
      say(`no case has the name ${opts.only}`);
      return EXIT_USAGE;
    }
  }

  const shared = {
    client: await clientOf(deps),
    // The scorer gets no claude.ai MCP servers. The env does not otherwise
    // change: buildQueryOptions removes the provider variables.
    options: {
      allowApiKey: opts.allowApiKey,
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    },
    policy: readPolicy(),
  };
  // One semaphore bounds the findings of every case.
  const semaphore = createSemaphore(opts.concurrency);
  const labeled = await Promise.all(cases.map((c) => labelOneCase(c, opts, shared, semaphore)));
  const results = labeled.filter((r): r is CaseResult => r !== null);
  const checkoutFailed = results.length < labeled.length;

  const summary = summaryOf(results);
  const summaryDir = resolve(opts.out ?? opts.cases);
  await mkdir(summaryDir, { recursive: true });
  await writeFile(join(summaryDir, "label-summary.json"), json(summary));
  process.stdout.write(opts.format === "json" ? json(summary) : renderLabelTable(results, summary));

  const failedRuns = summary.cases.reduce((n, c) => n + c.failed_runs, 0);
  if (failedRuns > 0) say(`${failedRuns} runs failed after a retry.`);
  return checkoutFailed || failedRuns > 0 ? EXIT_FAILURE : EXIT_OK;
}

// Parse a count flag: a positive integer.
function parseCount(value: string): number {
  const n = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError("Give a positive integer.");
  }
  return n;
}

// A usage error exits 2. Help keeps 0. The callback throws, so commander
// does not call process.exit.
function exitOverride(err: CommanderError): never {
  if (err.exitCode === EXIT_OK) throw err;
  throw new CommanderError(EXIT_USAGE, err.code, err.message);
}

type LabelCliOptions = Omit<LabelOptions, "writeGolden" | "allowApiKey"> & {
  writeGolden?: boolean;
  allowApiKey?: boolean;
};

/** Add the "label" command to "program". */
export function registerLabelCommand(program: Command, deps: ProgramDeps): void {
  program
    .command("label")
    .description(
      "Label the severity and the category of each golden finding under the severity policy.",
    )
    .exitOverride(exitOverride)
    .requiredOption("--cases <dir>", "the cases directory, with one subdirectory per case")
    .option("--runs <n>", "the independent runs of each finding, a positive integer", parseCount, 3)
    .option(
      "--concurrency <n>",
      "the most findings in flight at once, a positive integer",
      parseCount,
      2,
    )
    .option("--write-golden", "write the chosen blocking, suggestion and nit labels to golden.json")
    .option("--only <case>", "label only the case with this name")
    .option("--out <dir>", "the output directory (default: each case directory)")
    .addOption(
      new Option("--format <format>", "the format of the totals on stdout")
        .choices(["table", "json"])
        .default("table"),
    )
    .option(
      "--allow-api-key",
      "keep ANTHROPIC_API_KEY and the other provider variables in the SDK environment",
    )
    .action(async (options: LabelCliOptions) => {
      try {
        process.exitCode = await runLabel(
          {
            cases: options.cases,
            runs: options.runs,
            concurrency: options.concurrency,
            writeGolden: options.writeGolden === true,
            ...(options.only !== undefined ? { only: options.only } : {}),
            ...(options.out !== undefined ? { out: options.out } : {}),
            format: options.format,
            allowApiKey: options.allowApiKey === true,
          },
          deps,
        );
      } catch (err) {
        say(messageOf(err));
        process.exitCode = EXIT_FAILURE;
      }
    });
}
