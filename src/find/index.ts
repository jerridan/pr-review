// Find: run each selected reviewer, one query per pass, and check each
// finding before it goes to verification.
import type { GatherResult } from "../gather/index.js";
import { loadPrompt, render } from "../prompts/load.js";
import { reviewerOverrides, type ReviewerDefinition } from "../reviewers/loader.js";
import { FindingsOutputSchema, type Finding, type FindingsOutput } from "../schemas/finding.js";
import type { QueryFailure } from "../schemas/record.js";
import type { TriageBrief } from "../schemas/triage.js";
import type { QueryMeta, SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import type { Semaphore } from "../semaphore.js";
import { wrapUntrusted } from "../untrusted.js";
import { evidenceMatches, lineCount, lineRangeValid, readHeadFile } from "./evidence.js";

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
};

function describeBrief(brief: TriageBrief | null): string {
  if (!brief) return "No triage brief is available for this change.";
  const hotspots = brief.hotspots.length > 0 ? brief.hotspots.map((h) => `- ${h}`) : ["- none"];
  return [`Summary: ${brief.summary}`, "", "Hotspots:", ...hotspots].join("\n");
}

/** Build the reviewer user message: the brief, then the diff, then the instructions. */
export function buildReviewerMessage(
  template: string,
  gathered: GatherResult,
  brief: TriageBrief | null,
): string {
  // The brief comes from a model that read the diff, so it is untrusted too.
  const briefBlock = wrapUntrusted("triage_brief", describeBrief(brief));
  const diffBlock = wrapUntrusted("diff", gathered.diff);
  return render(template, { brief: briefBlock.block, diff: diffBlock.block });
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
  const template = loadPrompt("reviewer-user.md").body;
  const headFiles = new Map<string, string | null>();
  const headFile = (file: string): string | null => {
    if (!headFiles.has(file)) headFiles.set(file, readHeadFile(ctx.cwd, file));
    return headFiles.get(file) ?? null;
  };

  const runPass = async (
    def: ReviewerDefinition,
    pass: number,
    seen: Set<string>,
  ): Promise<ReviewerRun> => {
    const name = def.frontmatter.name;
    const userMessage = buildReviewerMessage(template, ctx.gathered, ctx.brief);
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
            overrides: reviewerOverrides(def),
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
    for (const finding of outcome.output.findings) {
      const text = headFile(finding.file);
      if (!lineRangeValid(finding, text === null ? null : lineCount(text))) {
        dropped.push({ finding, reason: "out-of-range" });
      } else if (!evidenceMatches(finding.evidence, text, ctx.gathered.diff)) {
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
