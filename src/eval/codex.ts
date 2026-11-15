// One call of GPT through the Codex CLI, for the labeler and the pool. The
// runner spawns "codex" from PATH. Codex finds its own login. The runner
// reads no credential and passes the parent environment through unchanged.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { toSdkJsonSchema } from "../schemas/json-schema.js";

/** The GPT model of the eval: the judge of the labeler and the pool calls. */
export const CODEX_MODEL = "gpt-6.1-sol";
/** The reasoning effort of every codex call. */
export const CODEX_EFFORT = "high";
/** The most characters of stderr that the record of a call holds. */
export const STDERR_LIMIT = 2000;
/** The wall-clock limit of one codex call, in milliseconds. */
export const CODEX_TIMEOUT_MS = 900_000;

/**
 * The slug of the Terra model. The command "codex debug models" lists this
 * slug in codex-cli 0.167.0.
 */
export const TERRA_MODEL = "gpt-6.1-terra";

export type CodexEffort = "low" | "medium" | "high" | "xhigh";
/** The model and the effort of one call. A missing field takes the default. */
export type CodexOptions = { model?: string; effort?: CodexEffort };

/** "tokens" is the count that codex prints at the end of stderr, or null. */
export type CodexOutcome<T> = (
  { ok: true; output: T; stderr: string } | { ok: false; error: string; stderr: string }
) & { tokens: number | null };

// The form of the token count. At the end of a call, codex prints the line
// "tokens used" and then the count on the next line, with commas, for
// example "21,755". Source: the stored stderr tails of the label records of
// earlier runs in this repo.
const TOKENS_RE = /tokens used\s*\n\s*([\d,]+)/gi;

/** The token count at the end of a stderr text, or null when it holds none. */
export function codexTokens(stderr: string): number | null {
  const matches = [...stderr.matchAll(TOKENS_RE)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  const count = Number(last.replaceAll(",", ""));
  return Number.isFinite(count) ? count : null;
}

// The form of a quota stop. Codex prints "ERROR: You've hit your usage
// limit." and then the time of the next try. The apostrophe is straight or
// curly, and "You have" also occurs. Source: the stored stderr tails of the
// label and pool records of earlier runs, and CODEX_ERROR in
// test/fixtures/pool-fakes.ts.
const QUOTA_RE = /hit your usage limit/i;

/** True when the stderr tail of a call shows a usage or quota limit. */
export function codexQuotaError(stderr: string): boolean {
  return QUOTA_RE.test(stderr);
}

/** The argv of one call. The prompt is the last argument. */
export function codexArgs(
  checkout: string,
  schemaFile: string,
  outFile: string,
  prompt: string,
  opts: CodexOptions = {},
): string[] {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-C",
    checkout,
    "-s",
    "read-only",
    "-m",
    opts.model ?? CODEX_MODEL,
    "-c",
    `model_reasoning_effort=${opts.effort ?? CODEX_EFFORT}`,
    "--output-schema",
    schemaFile,
    "-o",
    outFile,
    prompt,
  ];
}

type ExecResult = { error: Error | null; stderr: string };

function exec(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "codex",
      args,
      { cwd, timeout: CODEX_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, _stdout, stderr) => resolve({ error, stderr: String(stderr ?? "") }),
    );
    // Codex reads stdin when it is not a TTY. Close it, so codex does not wait.
    child.stdin?.end();
  });
}

// The message of a failed exec. The error message of execFile holds the
// whole command line, with the prompt, so this message does not use it.
function exitMessage(err: Error): string {
  const { code, signal } = err as Error & { code?: unknown; signal?: unknown };
  if (typeof signal === "string") return `codex stopped on the signal ${signal}`;
  if (typeof code === "number") return `codex exited with code ${code}`;
  if (typeof code === "string") return `codex did not start: ${code}`;
  return "codex failed";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one codex call in "checkout" and give its parsed result. "schema"
 * is the output schema, and "what" names it in an error. A non-zero exit,
 * a missing out file, or an out file that fails the schema gives a failed
 * call. The runner never throws for these.
 */
export async function runCodex<T>(
  prompt: string,
  checkout: string,
  schema: z.ZodType<T>,
  what: string,
  opts: CodexOptions = {},
): Promise<CodexOutcome<T>> {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-codex-"));
  let stderr = "";
  let tokens: number | null = null;
  const fail = (error: string): CodexOutcome<T> => ({ ok: false, error, stderr, tokens });
  try {
    const schemaFile = join(dir, "schema.json");
    const outFile = join(dir, "out.json");
    await writeFile(schemaFile, JSON.stringify(toSdkJsonSchema(schema)));
    const result = await exec(codexArgs(checkout, schemaFile, outFile, prompt, opts), checkout);
    // Codex prints its banner and the whole prompt first, and an error last.
    // So the record keeps the end of stderr, not the start.
    stderr = result.stderr.slice(-STDERR_LIMIT);
    tokens = codexTokens(result.stderr);
    if (result.error) return fail(exitMessage(result.error));
    let text: string;
    try {
      text = await readFile(outFile, "utf8");
    } catch {
      return fail("codex wrote no out file");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      return fail(`the out file is not JSON: ${messageOf(err)}`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return fail(`the out file fails the ${what} schema: ${parsed.error.message}`);
    return { ok: true, output: parsed.data, stderr, tokens };
  } catch (err) {
    return fail(messageOf(err));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
