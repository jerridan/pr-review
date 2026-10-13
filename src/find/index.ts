// Find: run each selected reviewer, one query per pass, and check each
// finding before it goes to verification.
import { diffSections } from "../gather/diff.js";
import type { RepoConfig } from "../config/repo-config.js";
import type { GatherResult } from "../gather/index.js";
import { loadPrompt, render, type PromptFile } from "../prompts/load.js";
import { effectiveModel, type ReviewerDefinition } from "../reviewers/loader.js";
import { FindingsOutputSchema, type Finding, type FindingsOutput } from "../schemas/finding.js";
import type { QueryFailure } from "../schemas/record.js";
import type { TriageBrief } from "../schemas/triage.js";
import type { QueryMeta, SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import type { Semaphore } from "../semaphore.js";
import { wrapUntrusted } from "../untrusted.js";
import {
  diffEvidenceText,
  evidenceMatches,
  lineCount,
  lineRangeValid,
  normalizeFindingPath,
  normalizeWs,
  readHeadFile,
} from "./evidence.js";

export interface ReviewerRun {
  name: string;
  pass: number;
  status: "ok" | "failed";
  failure?: QueryFailure;
  findings: Finding[];
  dropped: { finding: Finding; reason: "bad-quote" | "out-of-range" }[];
  meta: QueryMeta | null;
}

type FindContext = {
  gathered: GatherResult;
  brief: TriageBrief | null;
  cwd: string;
  semaphore: Semaphore;
  /** The repo config. It sets the model and the effort of each reviewer. */
  config: RepoConfig;
  /**
   * The diff split per file (see diffSections). The run splits it once and
   * gives it here. When it is not set, runReviewers splits the diff itself.
   */
  sections?: Map<string, string>;
};

/** The texts of prompts/reviewer-user.md that the user message uses. */
export type ReviewerTexts = {
  template: string;
  noBriefText: string;
  briefText: string;
  hotspotLine: string;
  emptyListText: string;
};

function field(prompt: PromptFile, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/reviewer-user.md has no "${name}" string in its frontmatter.`);
  }
  return value;
}

/** Read the template (the body) and the brief texts (the frontmatter). */
export function reviewerTexts(prompt: PromptFile): ReviewerTexts {
  return {
    template: prompt.body,
    noBriefText: field(prompt, "no_brief_text"),
    briefText: field(prompt, "brief_text"),
    hotspotLine: field(prompt, "hotspot_line"),
    emptyListText: field(prompt, "empty_list_text"),
  };
}

function describeBrief(texts: ReviewerTexts, brief: TriageBrief | null): string {
  if (!brief) return texts.noBriefText;
  const hotspots =
    brief.hotspots.length > 0
      ? brief.hotspots.map((hotspot) => render(texts.hotspotLine, { hotspot })).join("\n")
      : texts.emptyListText;
  return render(texts.briefText, { summary: brief.summary, hotspots });
}

/** Build the reviewer user message: the brief, then the diff, then the instructions. */
export function buildReviewerMessage(
  texts: ReviewerTexts,
  gathered: GatherResult,
  brief: TriageBrief | null,
): string {
  // The brief comes from a model that read the diff, so it is untrusted too.
  const briefBlock = wrapUntrusted("triage_brief", describeBrief(texts, brief));
  const diffBlock = wrapUntrusted("diff", gathered.diff);
  return render(texts.template, { brief: briefBlock.block, diff: diffBlock.block });
}

// A key that is the same for two findings with the same fields.
function findingKey(f: Finding): string {
  return JSON.stringify([
    f.file,
    f.start_line,
    f.end_line,
    f.category,
    f.severity_estimate,
    f.confidence,
    f.claim,
    f.evidence,
    f.suggested_fix ?? null,
    f.explanation,
    f.needs_context,
  ]);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run every pass of every selected reviewer. All queries start at once,
 * and the semaphore bounds them. "onFinding" gets each checked finding as
 * its pass returns, so verification starts per finding. A finding that an
 * earlier pass of the same reviewer gave is not sent again.
 */
export async function runReviewers(
  client: SdkClient,
  options: RunOptions,
  selected: { def: ReviewerDefinition; trigger: string }[],
  ctx: FindContext,
  onFinding: (f: Finding, reviewer: string) => void,
): Promise<ReviewerRun[]> {
  const texts = reviewerTexts(loadPrompt("reviewer-user.md"));
  const sections = ctx.sections ?? diffSections(ctx.gathered.diff);
  // Each head file is read and normalized once, and so is the diff text
  // of each file, also when many findings name the same file.
  const headFiles = new Map<string, { raw: string; normalized: string } | null>();
  const headFile = (file: string): { raw: string; normalized: string } | null => {
    if (!headFiles.has(file)) {
      const raw = readHeadFile(ctx.cwd, file);
      headFiles.set(file, raw === null ? null : { raw, normalized: normalizeWs(raw) });
    }
    return headFiles.get(file) ?? null;
  };
  const fileDiffs = new Map<string, string>();
  const fileDiff = (file: string): string => {
    let text = fileDiffs.get(file);
    if (text === undefined) {
      text = diffEvidenceText(sections.get(file) ?? "");
      fileDiffs.set(file, text);
    }
    return text;
  };

  const runPass = async (
    def: ReviewerDefinition,
    pass: number,
    seen: Set<string>,
  ): Promise<ReviewerRun> => {
    const name = def.frontmatter.name;
    const userMessage = buildReviewerMessage(texts, ctx.gathered, ctx.brief);
    let outcome;
    try {
      outcome = await ctx.semaphore(() =>
        client.query<FindingsOutput>(
          {
            role: "reviewer",
            reviewerName: name,
            systemPrompt: def.systemPrompt,
            userMessage,
            schema: FindingsOutputSchema,
            cwd: ctx.cwd,
            overrides: effectiveModel(def, ctx.config),
            tools: def.frontmatter.tools,
          },
          options,
        ),
      );
    } catch (err) {
      const failure: QueryFailure = { kind: "thrown", message: messageOf(err) };
      return { name, pass, status: "failed", failure, findings: [], dropped: [], meta: null };
    }
    if (!outcome.ok) {
      return {
        name,
        pass,
        status: "failed",
        failure: outcome.failure,
        findings: [],
        dropped: [],
        meta: outcome.raw,
      };
    }

    const findings: Finding[] = [];
    const dropped: ReviewerRun["dropped"] = [];
    for (const reported of outcome.output.findings) {
      // The path is normalized here, once. Every later stage gets the
      // finding with the normalized path.
      const file = normalizeFindingPath(reported.file);
      if (file === null) {
        dropped.push({ finding: reported, reason: "out-of-range" });
        continue;
      }
      const finding = file === reported.file ? reported : { ...reported, file };
      const text = headFile(file);
      if (!lineRangeValid(finding, text === null ? null : lineCount(text.raw))) {
        dropped.push({ finding, reason: "out-of-range" });
      } else if (!evidenceMatches(finding.evidence, text?.normalized ?? null, fileDiff(file))) {
        dropped.push({ finding, reason: "bad-quote" });
      } else {
        findings.push(finding);
      }
    }
    for (const finding of findings) {
      const key = findingKey(finding);
      if (seen.has(key)) continue;
      seen.add(key);
      onFinding(finding, name);
    }
    return { name, pass, status: "ok", findings, dropped, meta: outcome.raw };
  };

  const tasks: Promise<ReviewerRun>[] = [];
  for (const { def } of selected) {
    const seen = new Set<string>();
    for (let pass = 1; pass <= def.frontmatter.passes; pass++) {
      tasks.push(runPass(def, pass, seen));
    }
  }
  return Promise.all(tasks);
}
