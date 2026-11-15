// The verifier backends of the replay. Each backend makes one first
// verifier call for one candidate. "claude" calls the SDK client with the
// verifier role. "codex" runs the Codex CLI with the model and the effort
// of the arm.
import type { z } from "zod";
import { ROLE_DEFAULTS, resolveModel, type Effort } from "../../config/models.js";
import { codexQuotaError, runCodex } from "../codex.js";
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

// The failure of a codex call that did not give a result. A usage limit is
// "limit". An out file that is missing, not JSON, or against the schema is
// "no-structured-output". Every other failure is "thrown". The message keeps
// the error text of the Codex runner.
function codexFailure(error: string, stderr: string): QueryFailure {
  if (codexQuotaError(stderr)) {
    return { kind: "limit", message: `the Codex quota or usage limit stopped the call: ${error}` };
  }
  const noOutput = /^(codex wrote no out file|the out file )/.test(error);
  return { kind: noOutput ? "no-structured-output" : "thrown", message: error };
}

/**
 * The codex backend. "verify" runs the Codex CLI with the model and the
 * effort of the arm and one prompt string: the system prompt, a blank line,
 * then the user message. Codex gives no cost, so cost_usd is null and the
 * call keeps the tokens. A failed call gives a failure, never a throw.
 */
export function codexBackend(spec: VerifierSpec): VerifierBackend {
  return {
    spec,
    unavailable: null,
    capUsd: 0,
    async verify(call) {
      const start = performance.now();
      const meta = (tokens: number | null): CallMeta => ({
        model: spec.model,
        effort: spec.effort,
        cost_usd: null,
        duration_ms: Math.round(performance.now() - start),
        tokens,
      });
      try {
        const prompt = `${call.system.trimEnd()}\n\n${call.userMessage}`;
        const outcome = await runCodex(prompt, call.cwd, call.schema, "verifier", {
          model: spec.model,
          effort: spec.effort,
        });
        return outcome.ok
          ? { output: outcome.output, failure: null, call: meta(outcome.tokens) }
          : {
              output: null,
              failure: codexFailure(outcome.error, outcome.stderr),
              call: meta(outcome.tokens),
            };
      } catch (err) {
        return {
          output: null,
          failure: { kind: "thrown", message: messageOf(err) },
          call: meta(null),
        };
      }
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
