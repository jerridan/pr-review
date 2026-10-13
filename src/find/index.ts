// Find: run each selected reviewer, one query per pass, and check each
// finding before it goes to verification.
import { diffSections } from "../gather/diff.js";
import { CLAUDE_FILE, RULES_FILE, type RepoConfig } from "../config/repo-config.js";
import type { GatherResult } from "../gather/index.js";
import { loadPrompt, render, type PromptFile } from "../prompts/load.js";
import { fingerprint } from "../merge/fingerprint.js";
import { effectiveModel, effectivePasses, type ReviewerDefinition } from "../reviewers/loader.js";
import { FindingsOutputSchema, type Finding, type FindingsOutput } from "../schemas/finding.js";
import type { QueryFailure } from "../schemas/record.js";
import type { TriageBrief } from "../schemas/triage.js";
import type { QueryMeta, SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import type { Semaphore } from "../semaphore.js";
import type { Tier } from "../triage/tier.js";
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
  /** The repo config. It sets the model, the effort and the passes of each reviewer. */
  config: RepoConfig;
  /**
   * The tier of the run. At the fast tier every reviewer runs one pass.
   * Absent means full: the passes of the config or the frontmatter.
   */
  tier?: Tier;
  /**
   * The base commit's CLAUDE.md and .pr-review/rules.md, for the rules
   * block of each reviewer's system prompt. Absent means neither file.
   */
  rules?: RuleTexts;
  /**
   * The diff split per file (see diffSections). The run splits it once and
   * gives it here. When it is not set, runReviewers splits the diff itself.
   */
  sections?: Map<string, string>;
};

/** The reviewer that gets the history block in its user message. */
export const HISTORY_REVIEWER = "history";

/** The most bytes of each file in the rules block. A longer file is cut. */
export const RULE_FILE_CAP_BYTES = 16384;

/** The base commit's CLAUDE.md and .pr-review/rules.md, or null for a file that is absent. */
export type RuleTexts = { claudeMd: string | null; rulesMd: string | null };

const NO_RULES: RuleTexts = { claudeMd: null, rulesMd: null };

/** The texts of prompts/reviewer-user.md that the user message uses. */
export type ReviewerTexts = {
  template: string;
  historyTemplate: string;
  noBriefText: string;
  briefText: string;
  hotspotLine: string;
  emptyListText: string;
  noDescriptionText: string;
  noHistoryText: string;
};

function fieldOf(prompt: PromptFile, file: string, name: string): string {
  const value = prompt.frontmatter[name];
  if (typeof value !== "string") {
    throw new Error(`prompts/${file} has no "${name}" string in its frontmatter.`);
  }
  return value;
}

function field(prompt: PromptFile, name: string): string {
  return fieldOf(prompt, "reviewer-user.md", name);
}

/** Read the templates (the body, and the history variant) and the block texts. */
export function reviewerTexts(prompt: PromptFile): ReviewerTexts {
  return {
    template: prompt.body,
    historyTemplate: field(prompt, "history_user_message"),
    noBriefText: field(prompt, "no_brief_text"),
    briefText: field(prompt, "brief_text"),
    hotspotLine: field(prompt, "hotspot_line"),
    emptyListText: field(prompt, "empty_list_text"),
    noDescriptionText: field(prompt, "no_description_text"),
    noHistoryText: field(prompt, "no_history_text"),
  };
}

// Cut the text to "cap" bytes, on a character boundary.
function capUtf8(text: string, cap: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return { text, truncated: false };
  let end = cap;
  // A continuation byte (10xxxxxx) at the cut belongs to a character that
  // starts before the cut, so the cut moves back to that character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * The files that go into the rules block, in order: the root CLAUDE.md,
 * then .pr-review/rules.md. Each text is cut to RULE_FILE_CAP_BYTES.
 */
export function injectedRuleFiles(
  rules: RuleTexts,
): { path: string; text: string; truncated: boolean }[] {
  const files: { path: string; text: string | null }[] = [
    { path: CLAUDE_FILE, text: rules.claudeMd },
    { path: RULES_FILE, text: rules.rulesMd },
  ];
  return files.flatMap((f) =>
    f.text === null ? [] : [{ path: f.path, ...capUtf8(f.text, RULE_FILE_CAP_BYTES) }],
  );
}

/**
 * The system prompt of a reviewer: its body, then one rules block that
 * holds each file that the base commit has. The wrapper text is in
 * prompts/reviewer-rules.md. With neither file, the prompt is the body.
 */
export function buildReviewerSystemPrompt(
  body: string,
  rules: { claudeMd: string | null; rulesMd: string | null },
): { prompt: string; injected: { path: string; truncated: boolean }[] } {
  const files = injectedRuleFiles(rules);
  if (files.length === 0) return { prompt: body, injected: [] };
  const wrapper = loadPrompt("reviewer-rules.md");
  const fileText = fieldOf(wrapper, "reviewer-rules.md", "file_text");
  const note = render(fieldOf(wrapper, "reviewer-rules.md", "truncated_text"), {
    limit: String(RULE_FILE_CAP_BYTES),
  });
  const parts = files.map((f) =>
    render(fileText, { path: f.path, text: f.text.trimEnd(), note: f.truncated ? note : "" }),
  );
  return {
    prompt: render(wrapper.body, { body: body.trimEnd(), files: parts.join("\n\n") }),
    injected: files.map((f) => ({ path: f.path, truncated: f.truncated })),
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

/**
 * Build the reviewer user message: the brief, the description, the
 * history when "withHistory" is true, then the diff, then the instructions.
 */
export function buildReviewerMessage(
  texts: ReviewerTexts,
  gathered: GatherResult,
  brief: TriageBrief | null,
  withHistory = false,
): string {
  // The brief comes from a model that read the diff, so it is untrusted too.
  const blocks: Record<string, string> = {
    brief: wrapUntrusted("triage_brief", describeBrief(texts, brief)).block,
    description: wrapUntrusted(
      "description",
      gathered.description.trim() === "" ? texts.noDescriptionText : gathered.description,
    ).block,
    diff: wrapUntrusted("diff", gathered.diff).block,
  };
  if (!withHistory) return render(texts.template, blocks);
  const history = gathered.history?.text ?? "";
  blocks.history = wrapUntrusted("history", history === "" ? texts.noHistoryText : history).block;
  return render(texts.historyTemplate, blocks);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run every pass of every selected reviewer. All queries start at once,
 * and the semaphore bounds them. "onFinding" gets each checked finding as
 * its pass returns, so verification starts per finding. A finding with the
 * fingerprint of a finding that the same reviewer already gave is not sent
 * again.
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
    const userMessage = buildReviewerMessage(
      texts,
      ctx.gathered,
      ctx.brief,
      name === HISTORY_REVIEWER,
    );
    let outcome;
    try {
      outcome = await ctx.semaphore(() =>
        client.query<FindingsOutput>(
          {
            role: "reviewer",
            reviewerName: name,
            systemPrompt: systemPrompts.get(def) ?? def.systemPrompt,
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
    // The passes of a reviewer have the same inputs, so they often give
    // the same finding. One copy per fingerprint goes to verification:
    // the copy of the pass that returns first.
    for (const finding of findings) {
      const key = fingerprint(finding, headFile(finding.file)?.raw ?? null);
      if (seen.has(key)) continue;
      seen.add(key);
      onFinding(finding, name);
    }
    return { name, pass, status: "ok", findings, dropped, meta: outcome.raw };
  };

  // Each reviewer's system prompt is built once, for all of its passes.
  const systemPrompts = new Map(
    selected.map(({ def }) => [
      def,
      buildReviewerSystemPrompt(def.systemPrompt, ctx.rules ?? NO_RULES).prompt,
    ]),
  );
  const tasks: Promise<ReviewerRun>[] = [];
  for (const { def } of selected) {
    const seen = new Set<string>();
    const passes = effectivePasses(def, ctx.config, ctx.tier ?? "full");
    for (let pass = 1; pass <= passes; pass++) {
      tasks.push(runPass(def, pass, seen));
    }
  }
  return Promise.all(tasks);
}
