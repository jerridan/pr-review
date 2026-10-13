// The SDK boundary. This is the only module that imports the Agent SDK.
// Tests replace it with the fake in "fake.ts".
import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import type { Role, RoleConfig } from "../config/models.js";
import type { QueryFailure } from "../schemas/record.js";
import { buildQueryOptions, type RunOptions } from "./options.js";

export type { RunOptions } from "./options.js";

export interface QueryRequest {
  role: Role;
  reviewerName?: string;
  systemPrompt: string;
  userMessage: string;
  schema: z.ZodType;
  cwd: string;
  overrides?: Partial<Pick<RoleConfig, "model" | "effort">>;
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

/** Make the real SDK client. Each query spawns its own Claude Code process. */
export function createSdkClient(): SdkClient {
  return {
    async query<T>(req: QueryRequest, options: RunOptions): Promise<QueryOutcome<T>> {
      // A bad request is a bug in the caller, so this throws and is not a
      // query failure.
      const sdkOptions = buildQueryOptions(req, options);
      const model = sdkOptions.model as string;
      let result: SDKResultMessage | undefined;
      try {
        for await (const message of query({
          prompt: req.userMessage,
          options: sdkOptions as Options,
        })) {
          if (message.type === "result") result = message;
        }
      } catch (err) {
        return { ok: false, failure: { kind: "thrown", message: errorMessage(err) }, raw: null };
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
