// The pool and adjudicate commands. "pool" builds a pooled golden set for
// each case. "adjudicate" runs the adjudication of the pool on one finding.
// Exit codes of pool: 0 when every call succeeded, 1 when a case failed or
// a call failed after its retry, 2 on a usage error. Exit codes of
// adjudicate: 0 when both calls succeeded, 1 when a call failed or the
// checkout failed, 2 on a usage error.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommanderError, type Command, InvalidArgumentError } from "commander";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type ProgramDeps } from "../../cli.js";
import type { SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";
import { createSemaphore } from "../../semaphore.js";
import { CaseError, loadPoolCase, type Case } from "../case.js";
import { cloneCase } from "../checkout.js";
import { adjudicateFinding } from "./adjudicate.js";
import { poolCase, summaryLine, PoolCaseError } from "./pool.js";
import {
  casePrNumber,
  findFingerprint,
  inputFinding,
  PoolInputError,
  readJsonFile,
  readRecord,
  type PoolRecord,
} from "./records.js";
import { sixFields, type PoolFinding } from "./schemas.js";

/** The most model calls of the pool in flight at once, over both families. */
export const POOL_CONCURRENCY = 4;

export type PoolOptions = {
  caseDirs: string[];
  out: string;
  records: string[];
  reviews: number;
  writeGolden: boolean;
};

export type AdjudicateOptions = {
  caseDir: string;
  record?: string;
  fingerprint?: string;
  finding?: string;
  out?: string;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function say(command: string, message: string): void {
  process.stderr.write(`pr-review ${command}: ${message}\n`);
}

// The SDK loads only when the command needs the real client.
async function clientOf(deps: ProgramDeps): Promise<SdkClient> {
  if (deps.client) return deps.client;
  const { createSdkClient } = await import("../../sdk/client.js");
  return createSdkClient();
}

// The pool calls get no claude.ai MCP servers. The env does not otherwise
// change: buildQueryOptions removes the provider variables.
function runOptions(): RunOptions {
  return { allowApiKey: false, env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } };
}

// Load the cases and the records, and check that each record is of the PR
// of each case. Give a usage error message, or the inputs.
async function poolInputs(
  opts: PoolOptions,
): Promise<{ cases: Case[]; records: PoolRecord[] } | string> {
  try {
    const cases: Case[] = [];
    for (const dir of opts.caseDirs) cases.push(await loadPoolCase(dir));
    const records: PoolRecord[] = [];
    for (const path of opts.records) records.push(await readRecord(path));
    for (const c of cases) {
      const pr = casePrNumber(c.name);
      for (const r of records) {
        if (pr === null) {
          return `case ${c.name} has no PR number at the end of its name, so it takes no --record`;
        }
        if (r.pr !== pr) {
          return `the record ${r.path} is of PR ${r.pr ?? "none"}, not of PR ${pr} of case ${c.name}`;
        }
      }
    }
    return { cases, records };
  } catch (err) {
    if (err instanceof CaseError || err instanceof PoolInputError) return err.message;
    throw err;
  }
}

/** Run the pool command and give its exit code. */
export async function runPool(opts: PoolOptions, deps: ProgramDeps): Promise<number> {
  const inputs = await poolInputs(opts);
  if (typeof inputs === "string") {
    say("pool", inputs);
    return EXIT_USAGE;
  }
  const shared = {
    client: await clientOf(deps),
    options: runOptions(),
    semaphore: createSemaphore(POOL_CONCURRENCY),
  };
  let code = EXIT_OK;
  // The cases go one at a time. The semaphore bounds the calls of a case.
  for (const c of inputs.cases) {
    try {
      const result = await poolCase(
        c,
        inputs.records,
        { reviews: opts.reviews, writeGolden: opts.writeGolden, out: resolve(opts.out) },
        shared,
      );
      process.stdout.write(`${summaryLine(result)}\n`);
      for (const error of result.reviewErrors)
        say("pool", `case ${c.name}: a review failed: ${error}`);
      if (result.failed > 0)
        say("pool", `case ${c.name}: ${result.failed} items had a failed call.`);
      if (result.reviewErrors.length > 0 || result.failed > 0) code = EXIT_FAILURE;
    } catch (err) {
      if (!(
        err instanceof PoolCaseError ||
        err instanceof CaseError ||
        err instanceof PoolInputError
      ))
        throw err;
      say("pool", err.message);
      code = EXIT_FAILURE;
    }
  }
  return code;
}

// Give the finding of the command, or a usage error message.
async function findingOf(opts: AdjudicateOptions): Promise<PoolFinding | string> {
  const byRecord = opts.record !== undefined || opts.fingerprint !== undefined;
  if (byRecord === (opts.finding !== undefined)) {
    return "give --record with --fingerprint, or --finding";
  }
  try {
    if (opts.finding !== undefined) {
      return inputFinding(
        await readJsonFile(opts.finding, "finding file"),
        `the finding file ${opts.finding}`,
      );
    }
    if (opts.record === undefined || opts.fingerprint === undefined) {
      return "give --record with --fingerprint";
    }
    const record = await readRecord(opts.record);
    const found = findFingerprint(record, opts.fingerprint);
    return (
      found ?? `the record ${opts.record} holds no finding with the fingerprint ${opts.fingerprint}`
    );
  } catch (err) {
    if (err instanceof PoolInputError) return err.message;
    throw err;
  }
}

/** Run the adjudicate command and give its exit code. */
export async function runAdjudicate(opts: AdjudicateOptions, deps: ProgramDeps): Promise<number> {
  let c: Case;
  try {
    c = await loadPoolCase(opts.caseDir);
  } catch (err) {
    if (!(err instanceof CaseError)) throw err;
    say("adjudicate", err.message);
    return EXIT_USAGE;
  }
  const finding = await findingOf(opts);
  if (typeof finding === "string") {
    say("adjudicate", finding);
    return EXIT_USAGE;
  }
  const client = await clientOf(deps);
  const tmp = await mkdtemp(join(tmpdir(), "pr-review-adjudicate-"));
  try {
    let checkout: string;
    try {
      checkout = await cloneCase(c, join(tmp, "repo"));
    } catch (err) {
      say("adjudicate", messageOf(err));
      return EXIT_FAILURE;
    }
    const diff = await readFile(join(c.dir, "diff.patch"), "utf8");
    const ctx = {
      client,
      options: runOptions(),
      checkout,
      semaphore: createSemaphore(2),
      cost: { usd: 0 },
    };
    const result = await adjudicateFinding(finding, diff, ctx);
    const text = `${JSON.stringify({ finding: sixFields(finding), ...result }, null, 2)}\n`;
    if (opts.out === undefined) process.stdout.write(text);
    else await writeFile(opts.out, text);
    const failed = "failed" in result.claude || "failed" in result.gpt;
    for (const [family, r] of [
      ["claude", result.claude],
      ["gpt", result.gpt],
    ] as const) {
      if ("failed" in r)
        say("adjudicate", `the ${family} call failed after its retry: ${r.failed}`);
    }
    return failed ? EXIT_FAILURE : EXIT_OK;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Parse a count flag: a positive integer.
function parseCount(value: string): number {
  const n = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError("Give a positive integer.");
  }
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// A usage error exits 2. Help keeps 0. The callback throws, so commander
// does not call process.exit.
function exitOverride(err: CommanderError): never {
  if (err.exitCode === EXIT_OK) throw err;
  throw new CommanderError(EXIT_USAGE, err.code, err.message);
}

/** Add the "pool" and "adjudicate" commands to "program". */
export function registerPoolCommands(program: Command, deps: ProgramDeps): void {
  program
    .command("pool")
    .description("Build a pooled golden set for each case from blind reviews and records.")
    .exitOverride(exitOverride)
    .argument("<case-dir...>", "the case directories")
    .requiredOption("--out <dir>", "the output directory, with one subdirectory per case")
    .option("--record <path>", "a run record of the PR of the case; repeat for more", collect, [])
    .option("--reviews <n>", "the blind reviews of each family, a positive integer", parseCount, 2)
    .option("--write-golden", "write golden.json in each case directory")
    .action(
      async (
        caseDirs: string[],
        options: { out: string; record: string[]; reviews: number; writeGolden?: boolean },
      ) => {
        try {
          process.exitCode = await runPool(
            {
              caseDirs,
              out: options.out,
              records: options.record,
              reviews: options.reviews,
              writeGolden: options.writeGolden === true,
            },
            deps,
          );
        } catch (err) {
          say("pool", messageOf(err));
          process.exitCode = EXIT_FAILURE;
        }
      },
    );

  program
    .command("adjudicate")
    .description(
      "Adjudicate one finding at the head of a case with a Claude model and a GPT model.",
    )
    .exitOverride(exitOverride)
    .argument("<case-dir>", "the case directory")
    .option("--record <path>", "a run record that holds the finding")
    .option("--fingerprint <fp>", "the fingerprint of the finding in the record")
    .option("--finding <path>", "a JSON file with file, start_line, end_line, category and claim")
    .option("--out <path>", "the output file (default: stdout)")
    .action(async (caseDir: string, options: Omit<AdjudicateOptions, "caseDir">) => {
      try {
        process.exitCode = await runAdjudicate({ caseDir, ...options }, deps);
      } catch (err) {
        say("adjudicate", messageOf(err));
        process.exitCode = EXIT_FAILURE;
      }
    });
}
