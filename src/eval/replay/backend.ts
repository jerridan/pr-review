// The verifier backends of the replay. Each backend makes one first
// verifier call for one candidate. "claude" calls the SDK client with the
// verifier role. "codex" is the place of the Codex CLI verifier: the Codex
// call takes no model option and no effort option yet, so the backend
// refuses before any call.
import type { z } from "zod";
import { ROLE_DEFAULTS, resolveModel, type Effort } from "../../config/models.js";
import type { QueryFailure } from "../../schemas/record.js";
import type { CallMeta } from "../../schemas/replay.js";
import type { SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";

export const BACKENDS = ["claude", "codex"] as const;
export type BackendName = (typeof BACKENDS)[number];

/** The --verifier value: the backend, the model and the effort. */
export type VerifierSpec = { backend: BackendName; model: string; effort: Effort };

/** One verifier call: the prompt of the form, the case clone, the schema of the form. */
export type VerifierCall = { system: string; userMessage: string; cwd: string; schema: z.ZodType };

/** The outcome of one verifier call, and its cost, duration, model and effort. */
export type VerifierOutcome = {
  output: unknown;
  failure: QueryFailure | null;
  call: CallMeta;
};

export interface VerifierBackend {
  readonly spec: VerifierSpec;
  /**
   * The reason why the backend cannot run, or null. The replay checks it
   * before any call and exits with the usage code.
   */
  readonly unavailable: string | null;
  /** The largest dollar cap of one call, for the bound of --max-cost. */
  readonly capUsd: number;
  verify(call: VerifierCall): Promise<VerifierOutcome>;
}

/** The text of the codex refusal. */
export const CODEX_UNAVAILABLE =
  "the codex verifier needs the model and effort options of the Codex call";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The claude backend: the SDK client with the verifier role, and the model and effort of the arm. */
export function claudeBackend(
  spec: VerifierSpec,
  client: SdkClient,
  options: RunOptions,
): VerifierBackend {
  const model = resolveModel(spec.model);
  return {
    spec,
    unavailable: null,
    capUsd: ROLE_DEFAULTS.verifier.maxBudgetUsd,
    async verify(call) {
      const start = performance.now();
      const meta = (
        cost: number | null,
        duration: number | null,
        used: string | null,
      ): CallMeta => ({
        model: used ?? model,
        effort: spec.effort,
        cost_usd: cost,
        duration_ms: duration ?? Math.round(performance.now() - start),
      });
      try {
        const outcome = await client.query(
          {
            role: "verifier",
            systemPrompt: call.system,
            userMessage: call.userMessage,
            schema: call.schema,
            cwd: call.cwd,
            overrides: { model, effort: spec.effort },
          },
          options,
        );
        const raw = outcome.raw;
        const callMeta = meta(raw?.costUsd ?? null, raw?.durationMs ?? null, raw?.model ?? null);
        return outcome.ok
          ? { output: outcome.output, failure: null, call: callMeta }
          : { output: null, failure: outcome.failure, call: callMeta };
      } catch (err) {
        return {
          output: null,
          failure: { kind: "thrown", message: messageOf(err) },
          call: meta(null, null, null),
        };
      }
    },
  };
}

/**
 * The codex backend. It refuses before any call, because the Codex call
 * takes no model option and no effort option yet. When the call takes
 * them (runCodex(prompt, checkout, schema, what, { model, effort })) and
 * its outcome holds "tokens", "verify" calls it with one prompt string
 * (the system prompt, then the user message), and gives cost_usd null and
 * the tokens; "unavailable" becomes null.
 */
export function codexBackend(spec: VerifierSpec): VerifierBackend {
  return {
    spec,
    unavailable: CODEX_UNAVAILABLE,
    capUsd: 0,
    verify() {
      return Promise.reject(new Error(CODEX_UNAVAILABLE));
    },
  };
}

/** The backend of a --verifier value. */
export function backendFor(
  spec: VerifierSpec,
  client: () => SdkClient,
  options: RunOptions,
): VerifierBackend {
  return spec.backend === "codex" ? codexBackend(spec) : claudeBackend(spec, client(), options);
}
