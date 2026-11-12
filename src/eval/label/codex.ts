// The judge of the labeler: GPT through the Codex CLI. The call itself is
// in "../codex.ts", which the pool shares. The runner reads no credential.
import { JudgeResultSchema, type JudgeResult } from "../../schemas/label.js";
import { runCodex, type CodexOutcome } from "../codex.js";

export { CODEX_EFFORT, CODEX_MODEL, CODEX_TIMEOUT_MS, STDERR_LIMIT, codexArgs } from "../codex.js";

export type CodexJudgeOutcome = CodexOutcome<JudgeResult>;

/**
 * Run one judge call in "checkout" and give its parsed result. A non-zero
 * exit, a missing out file, or an out file that fails the judge schema
 * gives a failed call. The runner never throws for these.
 */
export function runCodexJudge(prompt: string, checkout: string): Promise<CodexJudgeOutcome> {
  return runCodex(prompt, checkout, JudgeResultSchema, "judge");
}
