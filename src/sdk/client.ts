// The SDK boundary. This is the only module that imports the Agent SDK.
// Tests replace it with the fake in "fake.ts".
import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { roleConfig, type QueryRole, type RoleConfig } from "../config/models.js";
import type { QueryFailure } from "../schemas/record.js";
import { buildQueryOptions, type RunOptions } from "./options.js";

export type { RunOptions } from "./options.js";

export interface QueryRequest {
  role: QueryRole;
  reviewerName?: string;
  systemPrompt: string;
  userMessage: string;
  schema: z.ZodType;
  cwd: string;
  overrides?: Partial<Pick<RoleConfig, "model" | "effort">>;
  /**
   * The tools of a reviewer. They narrow the read-only set of the role and
   * never widen it. When this is not set, the role gets its full set.
   */
  tools?: readonly string[];
  /**
   * True when the run grants Bash to this query (a trusted custom reviewer
   * whose author has write access). Only a role with read-only tools can
   * get it. Write and Edit stay disallowed.
   */
  bash?: boolean;
}

export type QueryMeta = {
  model: string;
  durationMs: number;
  stopReason: string | null;
  subtype: string;
  usage: unknown;
  costUsd: number | null;
};

export type QueryOutcome<T> =
  | { ok: true; output: T; raw: QueryMeta }
  | { ok: false; failure: QueryFailure; raw: QueryMeta | null };

export interface SdkClient {
  query<T>(req: QueryRequest, options: RunOptions): Promise<QueryOutcome<T>>;
}

/** The fields of the SDK result message that the client reads. */
export type ResultFields = {
  subtype: string;
  duration_ms: number;
  stop_reason: string | null;
  total_cost_usd?: number;
  modelUsage?: unknown;
  errors?: string[];
  structured_output?: unknown;
};

const LIMIT_SUBTYPES = new Set(["error_max_turns", "error_max_budget_usd"]);

// The token counts of one model entry in the SDK result's "modelUsage".
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

/**
 * The tokens of one query: the sum of the input, output, cache read and
 * cache creation counts of each model in "usage" (the "modelUsage" map of
 * the result). A count that is not a finite number of 0 or more is not
 * in the sum.
 */
export function usageTokens(usage: unknown): number {
  if (usage === null || typeof usage !== "object") return 0;
  let total = 0;
  for (const entry of Object.values(usage as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    for (const field of TOKEN_FIELDS) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) total += value;
    }
  }
  return total;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn the final result message into an outcome. The order of the checks
 * sets the failure kind when more than one condition is true: a refusal
 * comes first, because the verdict treats it apart.
 */
export function classifyResult<T>(
  result: ResultFields,
  model: string,
  schema: z.ZodType,
): QueryOutcome<T> {
  const raw: QueryMeta = {
    model,
    durationMs: result.duration_ms,
    stopReason: result.stop_reason ?? null,
    subtype: result.subtype,
    usage: result.modelUsage,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
  };
  const fail = (kind: QueryFailure["kind"], message: string): QueryOutcome<T> => ({
    ok: false,
    failure: { kind, message },
    raw,
  });

  if (result.stop_reason === "refusal") return fail("refusal", "The stop reason is refusal.");
  if (result.stop_reason === "max_tokens") {
    return fail("max_tokens", "The stop reason is max_tokens.");
  }
  if (result.subtype !== "success") {
    const errors = result.errors ?? [];
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    const kind = LIMIT_SUBTYPES.has(result.subtype) ? "limit" : "subtype";
    return fail(kind, `The result subtype is ${result.subtype}${detail}`);
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    return fail("no-structured-output", "The result has no structured output.");
  }
  const parsed = schema.safeParse(result.structured_output);
  if (!parsed.success) {
    return fail(
      "no-structured-output",
      `The structured output does not match the schema: ${parsed.error.message}`,
    );
  }
  return { ok: true, output: parsed.data as T, raw };
}

/** The SDK "query" function, or a fake of it in tests. */
export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

const TIMED_OUT = Symbol("timed out");

/**
 * Make the real SDK client. Each query spawns its own Claude Code process.
 * "run" is the SDK "query" function; tests give a fake.
 */
export function createSdkClient(run: QueryFn = query): SdkClient {
  return {
    async query<T>(req: QueryRequest, options: RunOptions): Promise<QueryOutcome<T>> {
      // A bad request is a bug in the caller, so this throws and is not a
      // query failure.
      const sdkOptions = buildQueryOptions(req, options);
      const model = sdkOptions.model as string;
      const timeoutMs = roleConfig(req.role).timeoutMs;
      // Each query has its own controller. The timer aborts it, and the
      // query ends at that time also when the SDK does not stop.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(TIMED_OUT);
        }, timeoutMs);
      });
      const consume = async (): Promise<SDKResultMessage | undefined> => {
        let last: SDKResultMessage | undefined;
        for await (const message of run({
          prompt: req.userMessage,
          options: { ...(sdkOptions as Options), abortController: controller },
        })) {
          if (message.type === "result") last = message;
        }
        return last;
      };
      let result: SDKResultMessage | undefined;
      try {
        // Promise.race attaches a handler to both promises, so an abort
        // error after the timeout is not an unhandled rejection.
        const winner = await Promise.race([consume(), timedOut]);
        if (winner === TIMED_OUT) {
          return {
            ok: false,
            failure: { kind: "timeout", message: `The query did not end in ${timeoutMs} ms.` },
            raw: null,
          };
        }
        result = winner;
      } catch (err) {
        return { ok: false, failure: { kind: "thrown", message: errorMessage(err) }, raw: null };
      } finally {
        clearTimeout(timer);
      }
      if (!result) {
        return {
          ok: false,
          failure: { kind: "thrown", message: "The SDK ended without a result message." },
          raw: null,
        };
      }
      return classifyResult<T>(result, model, req.schema);
    },
  };
}
