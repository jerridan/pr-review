// The prompt forms of the replay verifier: "score" (prompts/verifier.md),
// "truth" (no severity) and "bands" (five named bands in place of the
// score). Each form has the user message fields of prompts/verifier.md and
// its own output schema. A result of any form becomes one ReplayResult.
import type { z } from "zod";
import { loadPrompt } from "../../prompts/load.js";
import {
  BANDS,
  BandsResultSchema,
  TruthResultSchema,
  type Band,
  type BandsResult,
  type ReplayResult,
  type TruthResult,
} from "../../schemas/replay.js";
import { VerifierResultSchema, type VerifierResult } from "../../schemas/verifier.js";
import { verifierTexts, type VerifierPrompt } from "../../verify/index.js";

export const PROMPT_FORMS = ["score", "truth", "bands"] as const;
export type PromptForm = (typeof PROMPT_FORMS)[number];

const FILES: Record<PromptForm, string> = {
  score: "verifier.md",
  truth: "verifier-truth.md",
  bands: "verifier-bands.md",
};

/** One loaded form: its prompt, its schema, and how a result becomes a ReplayResult. */
export type LoadedForm = {
  form: PromptForm;
  prompt: VerifierPrompt;
  schema: z.ZodType;
  /** The score of each band, from the frontmatter. Empty for the other forms. */
  bandScores: Partial<Record<Band, number>>;
  normalize: (output: unknown) => ReplayResult;
};

// The score of each band, from the "bands" map of the frontmatter. Each band
// of the schema needs an integer score from 0 to 100.
function bandScores(frontmatter: Record<string, unknown>): Record<Band, number> {
  const map = frontmatter.bands;
  if (typeof map !== "object" || map === null) {
    throw new Error('prompts/verifier-bands.md has no "bands" map in its frontmatter.');
  }
  const scores = {} as Record<Band, number>;
  for (const band of BANDS) {
    const score = (map as Record<string, unknown>)[band];
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error(
        `prompts/verifier-bands.md gives no score from 0 to 100 for the band ${band}.`,
      );
    }
    scores[band] = score;
  }
  return scores;
}

/** Load the prompt of a form. Throw when the file or a field is missing. */
export function loadForm(form: PromptForm): LoadedForm {
  const file = loadPrompt(FILES[form]);
  const prompt: VerifierPrompt = { system: file.body, texts: verifierTexts(file) };
  if (form === "truth") {
    return {
      form,
      prompt,
      schema: TruthResultSchema,
      bandScores: {},
      normalize: (output) => ({ ...(output as TruthResult), severity: null }),
    };
  }
  if (form === "bands") {
    const scores = bandScores(file.frontmatter);
    return {
      form,
      prompt,
      schema: BandsResultSchema,
      bandScores: scores,
      normalize: (output) => {
        const r = output as BandsResult;
        return { ...r, score: scores[r.band] };
      },
    };
  }
  return {
    form,
    prompt,
    schema: VerifierResultSchema,
    bandScores: {},
    normalize: (output) => ({ ...(output as VerifierResult) }),
  };
}
