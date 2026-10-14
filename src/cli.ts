#!/usr/bin/env node
// The pr-review command line. Exit codes: 0 when a run writes a record,
// 1 when a run cannot write a record or cannot post the review that
// --format github asked for, 2 on a usage error.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { ROLE_DEFAULTS, resolveModel } from "./config/models.js";
import type { GitHubClient } from "./github/client.js";
import { formatJson } from "./output/json.js";
import { formatTable } from "./output/table.js";
import { loadPrompt } from "./prompts/load.js";
import { runReview } from "./run.js";
import type { SdkClient } from "./sdk/client.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

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
    .command("smoke")
    .description("Make one structured-output query and show the model, the cost and the result.")
    .option(
      "--allow-api-key",
      "keep ANTHROPIC_API_KEY and the other provider variables in the SDK environment",
    )
    .action(async (options: { allowApiKey?: boolean }) => {
      await runSmoke(deps, options.allowApiKey === true);
    });

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
