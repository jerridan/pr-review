// Run the triage query: one SDK query with the diff inline and no tools.
import type { GatherResult } from "../gather/index.js";
import { loadPrompt, render } from "../prompts/load.js";
import type { QueryFailure } from "../schemas/record.js";
import { TriageBriefSchema, type TriageBrief } from "../schemas/triage.js";
import type { QueryMeta, SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import { wrapUntrusted } from "../untrusted.js";

function describeFiles(gathered: GatherResult): string {
  const lines = ["Changed files (hunks after exclusions):"];
  for (const file of gathered.changedFiles) {
    lines.push(`- ${file.path} (${file.hunks} ${file.hunks === 1 ? "hunk" : "hunks"})`);
  }
  lines.push("", "Sensitive files:");
  lines.push(
    ...(gathered.sensitive.length > 0 ? gathered.sensitive.map((p) => `- ${p}`) : ["- none"]),
  );
  lines.push("", "Excluded files (not in the diff):");
  lines.push(
    ...(gathered.excluded.length > 0
      ? gathered.excluded.map((e) => `- ${e.path} (${e.reason})`)
      : ["- none"]),
  );
  return lines.join("\n");
}

/** Build the triage user message from the prompt file template. */
export function buildTriageMessage(template: string, gathered: GatherResult): string {
  // File paths come from the change too, so they go in a block as well.
  const files = wrapUntrusted("files", describeFiles(gathered));
  const diff = wrapUntrusted("diff", gathered.diff);
  return render(template, { files: files.block, diff: diff.block });
}

export async function runTriage(
  client: SdkClient,
  options: RunOptions,
  gathered: GatherResult,
  cwd: string,
): Promise<{ brief: TriageBrief | null; failure: QueryFailure | null; meta: QueryMeta | null }> {
  const prompt = loadPrompt("triage.md");
  const template = prompt.frontmatter.user_message;
  if (typeof template !== "string") {
    throw new Error('prompts/triage.md has no "user_message" string in its frontmatter.');
  }
  const userMessage = buildTriageMessage(template, gathered);
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
