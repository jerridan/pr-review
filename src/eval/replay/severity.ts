// The severity step of the replay (D4c R6). It labels the candidates whose
// verifier result says that the claim holds and is in scope, under the
// severity policy, with no tools. "finding" makes one call for each such
// candidate. "pr" makes one call for each case, with all of them.
import type { ZodType } from "zod";
import { resolveModel, type Effort } from "../../config/models.js";
import { loadPrompt, render, type PromptFile } from "../../prompts/load.js";
import type { Finding } from "../../schemas/finding.js";
import type { QueryFailure } from "../../schemas/record.js";
import {
  SeverityFindingOutputSchema,
  SeverityPrOutputSchema,
  type CallMeta,
  type SeverityEntry,
  type SeverityFindingOutput,
  type SeverityPrOutput,
} from "../../schemas/replay.js";
import type { SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";
import { wrapUntrusted } from "../../untrusted.js";
import { readPolicy } from "../label/policy.js";

export const SEVERITY_MODES = ["finding", "pr"] as const;
export type SeverityMode = (typeof SEVERITY_MODES)[number];

/** The --severity value: the mode, the model and the effort. */
export type SeveritySpec = { mode: SeverityMode; model: string; effort: Effort };

/** The text of a spec, as the results file stores it. */
export const specText = (spec: SeveritySpec): string => `${spec.mode}:${spec.model}:${spec.effort}`;

/** The role of the calls of a mode. */
export const severityRole = (mode: SeverityMode) =>
  mode === "finding" ? ("severity-finding" as const) : ("severity-pr" as const);

/** One candidate for the step: the finding and the quotes of its verifier result. */
export type SeverityItem = { finding: Finding; quotes: string[] };

function field(prompt: PromptFile, file: string, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/${file} has no "${name}" string in its frontmatter.`);
  }
  return value;
}

// The step sees the finding as the verifier does: no reviewer, no severity
// estimate and no confidence.
function shownFinding(f: Finding): Record<string, unknown> {
  return {
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    category: f.category,
    claim: f.claim,
    evidence: f.evidence,
    explanation: f.explanation,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Asked<T> = { output: T | null; failure: QueryFailure | null; call: CallMeta };

async function ask<T>(
  client: SdkClient,
  options: RunOptions,
  spec: SeveritySpec,
  req: { system: string; userMessage: string; cwd: string; schema: ZodType },
): Promise<Asked<T>> {
  const model = resolveModel(spec.model);
  const start = performance.now();
  const meta = (cost: number | null, ms: number | null, used: string | null): CallMeta => ({
    model: used ?? model,
    effort: spec.effort,
    cost_usd: cost,
    duration_ms: ms ?? Math.round(performance.now() - start),
  });
  try {
    const outcome = await client.query<T>(
      {
        role: severityRole(spec.mode),
        systemPrompt: req.system,
        userMessage: req.userMessage,
        schema: req.schema,
        cwd: req.cwd,
        overrides: { model, effort: spec.effort },
      },
      options,
    );
    const call = meta(
      outcome.raw?.costUsd ?? null,
      outcome.raw?.durationMs ?? null,
      outcome.raw?.model ?? null,
    );
    return outcome.ok
      ? { output: outcome.output, failure: null, call }
      : { output: null, failure: outcome.failure, call };
  } catch (err) {
    return {
      output: null,
      failure: { kind: "thrown", message: messageOf(err) },
      call: meta(null, null, null),
    };
  }
}

/** Label one candidate (mode "finding"). */
export async function labelFinding(
  client: SdkClient,
  options: RunOptions,
  spec: SeveritySpec,
  item: SeverityItem,
  description: string,
  cwd: string,
): Promise<SeverityEntry> {
  const file = "severity-finding.md";
  const prompt = loadPrompt(file);
  const quotes = item.quotes.join("\n");
  const userMessage = render(field(prompt, file, "user_message"), {
    finding: wrapUntrusted("finding", JSON.stringify(shownFinding(item.finding), null, 2)).block,
    quotes: wrapUntrusted(
      "quotes",
      quotes.trim() === "" ? field(prompt, file, "no_quotes_text") : quotes,
    ).block,
    description: wrapUntrusted(
      "description",
      description.trim() === "" ? field(prompt, file, "no_description_text") : description,
    ).block,
    policy: wrapUntrusted("policy", readPolicy().trim()).block,
  });
  const asked = await ask<SeverityFindingOutput>(client, options, spec, {
    system: prompt.body,
    userMessage,
    cwd,
    schema: SeverityFindingOutputSchema,
  });
  return {
    spec: specText(spec),
    label: asked.output?.severity ?? null,
    rationale: asked.output?.rationale ?? "",
    ...(asked.failure ? { failure: asked.failure } : {}),
    call: asked.call,
    shared_by: 1,
  };
}

/**
 * Label the candidates of one case in one call (mode "pr"). The entries
 * come in the order of "items". A candidate that the output gives no label
 * gets the label null.
 */
export async function labelCase(
  client: SdkClient,
  options: RunOptions,
  spec: SeveritySpec,
  items: SeverityItem[],
  description: string,
  cwd: string,
): Promise<SeverityEntry[]> {
  const file = "severity-pr.md";
  const prompt = loadPrompt(file);
  const shown = items.map((item, index) => ({
    index,
    ...shownFinding(item.finding),
    quotes: item.quotes,
  }));
  const userMessage = render(field(prompt, file, "user_message"), {
    findings: wrapUntrusted("findings", JSON.stringify(shown, null, 2)).block,
    description: wrapUntrusted(
      "description",
      description.trim() === "" ? field(prompt, file, "no_description_text") : description,
    ).block,
    policy: wrapUntrusted("policy", readPolicy().trim()).block,
  });
  const asked = await ask<SeverityPrOutput>(client, options, spec, {
    system: prompt.body,
    userMessage,
    cwd,
    schema: SeverityPrOutputSchema,
  });
  return items.map((_, index) => {
    const label = asked.output?.labels.find((l) => l.index === index);
    return {
      spec: specText(spec),
      label: label?.severity ?? null,
      rationale: label?.rationale ?? "",
      ...(asked.failure ? { failure: asked.failure } : {}),
      call: asked.call,
      shared_by: items.length,
    };
  });
}
