#!/usr/bin/env node
// The pr-review command line. Exit codes: 0 when a run writes a record,
// 1 when a run cannot write a record, 2 on a usage error.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { z } from "zod";
import { ROLE_DEFAULTS, resolveModel } from "./config/models.js";
import { loadPrompt } from "./prompts/load.js";
import type { SdkClient } from "./sdk/client.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** The trivial schema of the smoke query. */
export const SmokeOutputSchema = z.strictObject({ ok: z.boolean(), word: z.string() });
export type SmokeOutput = z.infer<typeof SmokeOutputSchema>;

interface RunCliOptions {
  base: string;
  head: string;
  repo?: string;
  format: "json" | "table";
  out?: string;
  tier?: "full" | "fast" | "skip";
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
async function clientFrom(deps: { client?: SdkClient }): Promise<SdkClient> {
  if (deps.client) return deps.client;
  const { createSdkClient } = await import("./sdk/client.js");
  return createSdkClient();
}

function formatCost(costUsd: number | null | undefined): string {
  return typeof costUsd === "number" ? `$${costUsd.toFixed(4)}` : "unknown";
}

async function runSmoke(deps: { client?: SdkClient }, allowApiKey: boolean): Promise<void> {
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

// The record-and-run package replaces this stub.
async function runReview(_deps: { client?: SdkClient }, _options: RunCliOptions): Promise<void> {
  process.stderr.write("pr-review run: not implemented\n");
  process.exitCode = EXIT_FAILURE;
}

/** Make the pr-review program. Tests give a fake client in "deps". */
export function createProgram(deps: { client?: SdkClient }): Command {
  const program = new Command();
  program
    .name("pr-review")
    .description("Review the diff between two commits with Claude agents.")
    .exitOverride(exitOverride);

  program
    .command("run")
    .description("Review the diff between two commits and write a run record.")
    .requiredOption("--base <sha>", "the base commit")
    .requiredOption("--head <sha>", "the head commit")
    .option("--repo <path>", "the repo to review (default: the current directory)")
    .addOption(
      new Option("--format <format>", "the output format")
        .choices(["json", "table"])
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
    .option("--allow-api-key", "keep ANTHROPIC_API_KEY in the SDK environment")
    .action(async (options: RunCliOptions) => {
      await runReview(deps, options);
    });

  program
    .command("smoke")
    .description("Make one structured-output query and show the model, the cost and the result.")
    .option("--allow-api-key", "keep ANTHROPIC_API_KEY in the SDK environment")
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
