// One model call of the pool, on either family. A call that fails gets
// one retry. A semaphore bounds the calls in flight.
import type { z } from "zod";
import type { EvalRole } from "../../config/models.js";
import type { SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";
import type { Semaphore } from "../../semaphore.js";
import { runCodex } from "../codex.js";
import type { CallMemo } from "./memo.js";
import { codexPrompt, type Message } from "./prompts.js";

/** What every call of one case shares. */
export type PoolContext = {
  client: SdkClient;
  options: RunOptions;
  /** The case checkout at its head: the cwd of every call. */
  checkout: string;
  semaphore: Semaphore;
  /** The sum of the cost of the Claude calls, in USD. */
  cost: { usd: number };
  /** The kept results of the calls of the case. The adjudicate command has none. */
  memo?: CallMemo;
};

export type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A check of a parsed result. It gives an error, or null when the result is good. */
export type Check<T> = (value: T) => string | null;

/** The attempts of one call: the first and one retry. */
export const ATTEMPTS = 2;

/** The most characters of codex stderr that the failure text of a GPT call holds. */
export const STDERR_TAIL = 500;

/**
 * The failure text of a failed codex call: the error, then the end of
 * stderr. Codex writes its banner and the prompt first and the cause of a
 * failure last, so the end of stderr holds the cause. The text is one
 * line, so the error line of the command is one line too.
 */
export function codexFailure(error: string, stderr: string): string {
  const tail = stderr
    .trim()
    .slice(-STDERR_TAIL)
    .replace(/\s*\n\s*/g, " | ")
    .trim();
  return tail === "" ? error : `${error}; codex stderr ends: ${tail}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withRetry<T>(
  once: () => Promise<CallResult<T>>,
  check: Check<T>,
): Promise<CallResult<T>> {
  let last: CallResult<T> = { ok: false, error: "no call" };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    last = await once();
    if (last.ok) {
      const problem = check(last.value);
      if (problem === null) return last;
      last = { ok: false, error: problem };
    }
  }
  return last;
}

/** One Claude call through the SDK client, with one retry. */
export function claudeCall<T>(
  role: EvalRole,
  m: Message,
  schema: z.ZodType<T>,
  ctx: PoolContext,
  check: Check<T> = () => null,
): Promise<CallResult<T>> {
  const once = (): Promise<CallResult<T>> =>
    ctx.semaphore(async () => {
      try {
        const outcome = await ctx.client.query<T>(
          { role, systemPrompt: m.system, userMessage: m.user, schema, cwd: ctx.checkout },
          ctx.options,
        );
        ctx.cost.usd += outcome.raw?.costUsd ?? 0;
        if (outcome.ok) return { ok: true, value: outcome.output };
        return { ok: false, error: `${outcome.failure.kind}: ${outcome.failure.message}` };
      } catch (err) {
        return { ok: false, error: `thrown: ${messageOf(err)}` };
      }
    });
  return withRetry(once, check);
}

/** One GPT call through the codex CLI, with one retry. */
export function gptCall<T>(
  m: Message,
  schema: z.ZodType<T>,
  what: string,
  ctx: PoolContext,
  check: Check<T> = () => null,
): Promise<CallResult<T>> {
  const once = (): Promise<CallResult<T>> =>
    ctx.semaphore(async () => {
      const outcome = await runCodex(codexPrompt(m), ctx.checkout, schema, what);
      return outcome.ok
        ? { ok: true, value: outcome.output }
        : { ok: false, error: codexFailure(outcome.error, outcome.stderr) };
    });
  return withRetry(once, check);
}
