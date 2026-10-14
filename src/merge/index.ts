// Merge: fingerprint the verified findings, group overlapping lines in
// one file, merge each group of two or more with one query, rank, and cap.
import { readHeadFile } from "../find/evidence.js";
import { loadPrompt, render } from "../prompts/load.js";
import type { Finding, Severity } from "../schemas/finding.js";
import { MergeOutputSchema, type MergeOutput } from "../schemas/merge.js";
import type { PostedFinding, QueryFailure, RunRecord } from "../schemas/record.js";
import type { VerifierResult } from "../schemas/verifier.js";
import type { SdkClient } from "../sdk/client.js";
import type { RunOptions } from "../sdk/options.js";
import type { Semaphore } from "../semaphore.js";
import { wrapUntrusted } from "../untrusted.js";
import { applyCap, nonBlockingCap, type CapConfig } from "./cap.js";
import { fingerprint } from "./fingerprint.js";

type Verified = { finding: Finding; result: VerifierResult };
type MergeRecord = RunRecord["stages"]["merges"][number];

const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, suggestion: 1, nit: 2 };

/**
 * Group findings whose line ranges overlap in one file. Overlap is
 * transitive. Each group lists indices in ascending order; the groups are
 * in the order of their first index.
 */
export function groupFindings(
  items: Pick<Finding, "file" | "start_line" | "end_line">[],
): number[][] {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        a.item.file.localeCompare(b.item.file) ||
        a.item.start_line - b.item.start_line ||
        a.index - b.index,
    );
  const groups: number[][] = [];
  let current: number[] = [];
  let file = "";
  let end = -Infinity;
  for (const { item, index } of order) {
    if (current.length > 0 && item.file === file && item.start_line <= end) {
      current.push(index);
      end = Math.max(end, item.end_line);
    } else {
      if (current.length > 0) groups.push(current);
      current = [index];
      file = item.file;
      end = item.end_line;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g) => g.sort((a, b) => a - b)).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

function rank(posted: PostedFinding[]): PostedFinding[] {
  return [...posted].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.score - a.score ||
      a.file.localeCompare(b.file) ||
      a.start_line - b.start_line,
  );
}

function describeMembers(members: Verified[]): string {
  const list = members.map((m, i) => {
    const shown: Record<string, unknown> = {
      member_index: i,
      file: m.finding.file,
      start_line: m.finding.start_line,
      end_line: m.finding.end_line,
      category: m.finding.category,
      severity: m.result.severity,
      score: m.result.score,
      claim: m.finding.claim,
      explanation: m.finding.explanation,
      evidence: m.finding.evidence,
    };
    if (m.finding.suggested_fix !== undefined) shown.suggested_fix = m.finding.suggested_fix;
    return shown;
  });
  return JSON.stringify(list, null, 2);
}

// Return the reason to reject a merge result, or null when it is valid.
function rejection(output: MergeOutput, members: Verified[]): string | null {
  if (output.merged.length === 0) return "The merge result has no findings.";
  const used = new Set<number>();
  for (const entry of output.merged) {
    if (used.has(entry.member_index)) {
      return `The merge result uses member ${entry.member_index} more than once.`;
    }
    used.add(entry.member_index);
  }
  for (const entry of output.merged) {
    const member = members[entry.member_index] as Verified;
    if (SEVERITY_RANK[entry.severity] < SEVERITY_RANK[member.result.severity]) {
      return `The merge result upgrades the severity of member ${entry.member_index} from ${member.result.severity} to ${entry.severity}.`;
    }
  }
  const top = Math.max(...members.map((m) => m.result.score));
  const keepsTop = output.merged.some((e) => members[e.member_index]?.result.score === top);
  if (!keepsTop) {
    return "The merge result changes the line range: it does not keep the highest-scoring member.";
  }
  return null;
}

export async function mergeFindings(
  client: SdkClient,
  options: RunOptions,
  verified: Verified[],
  ctx: { cwd: string; totalHunks: number; semaphore: Semaphore; caps?: CapConfig },
): Promise<{
  posted: PostedFinding[];
  capped: PostedFinding[];
  merges: RunRecord["stages"]["merges"];
}> {
  const headFiles = new Map<string, string | null>();
  const headFile = (file: string): string | null => {
    if (!headFiles.has(file)) headFiles.set(file, readHeadFile(ctx.cwd, file));
    return headFiles.get(file) ?? null;
  };
  // The posted severity is always the verifier's, unless merge lowers it.
  const toPosted = (v: Verified): PostedFinding => ({
    ...v.finding,
    fingerprint: fingerprint(v.finding, headFile(v.finding.file)),
    severity: v.result.severity,
    score: v.result.score,
    verifier: v.result,
  });

  const prompt = loadPrompt("merge.md");
  const template = prompt.frontmatter.user_message;
  if (typeof template !== "string") {
    throw new Error('prompts/merge.md has no "user_message" string in its frontmatter.');
  }

  const mergeGroup = async (
    group: number[],
  ): Promise<{ posted: PostedFinding[]; record: MergeRecord | null }> => {
    const members = group.map((i) => verified[i] as Verified);
    if (members.length === 1) return { posted: members.map(toPosted), record: null };
    const unmerged = members.map(toPosted);

    const userMessage = render(template, {
      findings: wrapUntrusted("findings", describeMembers(members)).block,
    });
    let outcome;
    try {
      outcome = await ctx.semaphore(() =>
        client.query<MergeOutput>(
          {
            role: "merge",
            systemPrompt: prompt.body,
            userMessage,
            schema: MergeOutputSchema,
            cwd: ctx.cwd,
          },
          options,
        ),
      );
    } catch (err) {
      const failure: QueryFailure = {
        kind: "thrown",
        message: err instanceof Error ? err.message : String(err),
      };
      return { posted: unmerged, record: { group, result: failure } };
    }
    if (!outcome.ok) return { posted: unmerged, record: { group, result: outcome.failure } };

    const output = outcome.output;
    const bad = output.merged.find(
      (e) =>
        !Number.isInteger(e.member_index) || e.member_index < 0 || e.member_index >= members.length,
    );
    if (bad) {
      const failure: QueryFailure = {
        kind: "out-of-range",
        message: `The member index ${bad.member_index} is not from 0 to ${members.length - 1}.`,
      };
      return { posted: unmerged, record: { group, result: failure } };
    }
    const reason = rejection(output, members);
    if (reason) return { posted: unmerged, record: { group, result: output, rejected: reason } };

    // Merge rewrites only claim, explanation and suggested_fix, and may
    // lower the severity. The rest comes from the member that it keeps.
    const posted = output.merged.map((entry) => {
      const base = toPosted(members[entry.member_index] as Verified);
      const { suggested_fix: _old, ...rest } = base;
      return {
        ...rest,
        claim: entry.claim,
        explanation: entry.explanation,
        ...(entry.suggested_fix !== undefined ? { suggested_fix: entry.suggested_fix } : {}),
        severity: entry.severity,
      };
    });
    return { posted, record: { group, result: output } };
  };

  const results = await Promise.all(groupFindings(verified.map((v) => v.finding)).map(mergeGroup));
  const merges = results.flatMap((r) => (r.record ? [r.record] : []));
  const { posted, capped } = applyCap(
    rank(results.flatMap((r) => r.posted)),
    nonBlockingCap(ctx.totalHunks, ctx.caps),
  );
  return { posted, capped, merges };
}
