// The judge of the labeler: GPT through the Codex CLI. The runner spawns
// "codex" from PATH. Codex finds its own login. The runner reads no
// credential and passes the parent environment through unchanged.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JudgeResultSchema, type JudgeResult } from "../../schemas/label.js";
import { toSdkJsonSchema } from "../../schemas/json-schema.js";

/** The model of the judge. */
export const CODEX_MODEL = "gpt-6.1-sol";
/** The reasoning effort of the judge. */
export const CODEX_EFFORT = "high";
/** The most characters of stderr that the record of a call holds. */
export const STDERR_LIMIT = 2000;
/** The wall-clock limit of one codex call, in milliseconds. */
export const CODEX_TIMEOUT_MS = 900_000;

export type CodexJudgeOutcome =
  { ok: true; output: JudgeResult; stderr: string } | { ok: false; error: string; stderr: string };

/** The argv of one judge call. The prompt is the last argument. */
export function codexArgs(
  checkout: string,
  schemaFile: string,
  outFile: string,
  prompt: string,
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
    CODEX_MODEL,
    "-c",
    `model_reasoning_effort=${CODEX_EFFORT}`,
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
 * Run one judge call in "checkout" and give its parsed result. A non-zero
 * exit, a missing out file, or an out file that fails the judge schema
 * gives a failed call. The runner never throws for these.
 */
export async function runCodexJudge(prompt: string, checkout: string): Promise<CodexJudgeOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-label-judge-"));
  let stderr = "";
  const fail = (error: string): CodexJudgeOutcome => ({ ok: false, error, stderr });
  try {
    const schemaFile = join(dir, "schema.json");
    const outFile = join(dir, "out.json");
    await writeFile(schemaFile, JSON.stringify(toSdkJsonSchema(JudgeResultSchema)));
    const result = await exec(codexArgs(checkout, schemaFile, outFile, prompt), checkout);
    // Codex prints its banner and the whole prompt first, and an error last.
    // So the record keeps the end of stderr, not the start.
    stderr = result.stderr.slice(-STDERR_LIMIT);
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
    const parsed = JudgeResultSchema.safeParse(value);
    if (!parsed.success)
      return fail(`the out file fails the judge schema: ${parsed.error.message}`);
    return { ok: true, output: parsed.data, stderr };
  } catch (err) {
    return fail(messageOf(err));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
