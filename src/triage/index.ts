// Run the triage query: one SDK query with the diff inline and no tools.
import type { GatherResult } from "../gather/index.js";
import { loadPrompt, render, type PromptFile } from "../prompts/load.js";
import type { QueryFailure } from "../schemas/record.js";
import { TriageBriefSchema, type TriageBrief } from "../schemas/triage.js";
import type { QueryMeta, SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import { wrapUntrusted } from "../untrusted.js";

/** The texts of prompts/triage.md that the user message uses. */
export type TriageTexts = {
  template: string;
  filesText: string;
  changedFileLine: string;
  fileLine: string;
  excludedFileLine: string;
  emptyListText: string;
};

function field(prompt: PromptFile, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/triage.md has no "${name}" string in its frontmatter.`);
  }
  return value;
}

/** Read the user message texts from the frontmatter of the triage prompt. */
export function triageTexts(prompt: PromptFile): TriageTexts {
  return {
    template: field(prompt, "user_message"),
    filesText: field(prompt, "files_text"),
    changedFileLine: field(prompt, "changed_file_line"),
    fileLine: field(prompt, "file_line"),
    excludedFileLine: field(prompt, "excluded_file_line"),
    emptyListText: field(prompt, "empty_list_text"),
  };
}

function describeFiles(texts: TriageTexts, gathered: GatherResult): string {
  const list = (lines: string[]): string =>
    lines.length > 0 ? lines.join("\n") : texts.emptyListText;
  return render(texts.filesText, {
    changed: list(
      gathered.changedFiles.map((f) =>
        render(texts.changedFileLine, { path: f.path, hunks: String(f.hunks) }),
      ),
    ),
    sensitive: list(gathered.sensitive.map((path) => render(texts.fileLine, { path }))),
    excluded: list(
      gathered.excluded.map((e) =>
        render(texts.excludedFileLine, { path: e.path, reason: e.reason }),
      ),
    ),
  });
}

/** Build the triage user message from the prompt file texts. */
export function buildTriageMessage(texts: TriageTexts, gathered: GatherResult): string {
  // File paths come from the change too, so they go in a block as well.
  const files = wrapUntrusted("files", describeFiles(texts, gathered));
  const diff = wrapUntrusted("diff", gathered.diff);
  return render(texts.template, { files: files.block, diff: diff.block });
}

export async function runTriage(
  client: SdkClient,
  options: RunOptions,
  gathered: GatherResult,
  cwd: string,
): Promise<{ brief: TriageBrief | null; failure: QueryFailure | null; meta: QueryMeta | null }> {
  const prompt = loadPrompt("triage.md");
  const userMessage = buildTriageMessage(triageTexts(prompt), gathered);
  try {
    const outcome = await client.query<TriageBrief>(
      { role: "triage", systemPrompt: prompt.body, userMessage, schema: TriageBriefSchema, cwd },
      options,
    );
    if (outcome.ok) return { brief: outcome.output, failure: null, meta: outcome.raw };
    return { brief: null, failure: outcome.failure, meta: outcome.raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { brief: null, failure: { kind: "thrown", message }, meta: null };
  }
}
