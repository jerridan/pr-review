// The text that the run posts to GitHub: the review body, the inline
// comments, the check run, the cleanup comment and the failure review.
// This text is output, not a prompt, so its templates live here.
import { diffSections } from "../gather/diff.js";
import type { PostedFinding, RunRecord } from "../schemas/record.js";
import type { InlineComment } from "./client.js";
import {
  CLEANUP_MARKER,
  formatFingerprintMarker,
  formatRunMarker,
  type RunMarker,
} from "./markers.js";
import { redact } from "./sanitize.js";

// The longest failure message that a failure review holds.
const MAX_FAILURE_MESSAGE = 500;

/**
 * Make model text safe in markdown: "<" and ">" become entities. Thus the
 * text cannot hide a part of itself in an HTML comment, and it cannot
 * forge a marker of the tool.
 */
function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Put text on one line: each run of whitespace becomes one space.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const VERDICT_TEXT: Record<RunRecord["posted"]["verdict"], string> = {
  "would approve": "Would approve",
  "would request changes": "Would request changes",
  incomplete: "Review incomplete",
  skipped: "Skipped",
};

// The right-side line ranges of each hunk, per file. Each line in a range
// is an added line or a context line.
function rightSideRanges(diff: string): Map<string, [number, number][]> {
  const ranges = new Map<string, [number, number][]>();
  for (const [path, section] of diffSections(diff)) {
    const list: [number, number][] = [];
    for (const match of section.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      if (count > 0) list.push([start, start + count - 1]);
    }
    ranges.set(path, list);
  }
  return ranges;
}

/**
 * Split the findings: a finding goes inline only when one hunk of the
 * diff holds every line of its span on the right side. Every other
 * finding goes in the review body. Each part keeps the input order.
 */
export function placeFindings(
  findings: PostedFinding[],
  diff: string,
): { inline: PostedFinding[]; body: PostedFinding[] } {
  const ranges = rightSideRanges(diff);
  const inline: PostedFinding[] = [];
  const body: PostedFinding[] = [];
  for (const f of findings) {
    const fits = (ranges.get(f.file) ?? []).some(
      ([start, end]) => f.start_line >= start && f.end_line <= end,
    );
    (fits ? inline : body).push(f);
  }
  return { inline, body };
}

function lineRange(f: PostedFinding): string {
  return f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}-${f.end_line}`;
}

// The title of a finding: its category and its place.
function title(f: PostedFinding): string {
  const category = f.category.charAt(0).toUpperCase() + f.category.slice(1);
  return `${category} at ${f.file}:${lineRange(f)}`;
}

// The bold severity, the title and the claim, on one line.
function headline(f: PostedFinding): string {
  return `**${f.severity}** ${escapeText(title(f))}: ${escapeText(oneLine(f.claim))}`;
}

function permalink(slug: string, head: string, f: PostedFinding): string {
  return `https://github.com/${slug}/blob/${head}/${encodeURI(f.file)}#L${f.start_line}-L${f.end_line}`;
}

// The counts of the posted findings, by severity.
function countBy(findings: PostedFinding[], severity: PostedFinding["severity"]): number {
  return findings.filter((f) => f.severity === severity).length;
}

// The counts as a markdown table.
function countsTable(findings: PostedFinding[]): string[] {
  return [
    "| Blocking | Suggestions | Nits |",
    "|---|---|---|",
    `| ${countBy(findings, "blocking")} | ${countBy(findings, "suggestion")} | ${countBy(findings, "nit")} |`,
  ];
}

// The open blocking findings of earlier runs also set the verdict. Name
// them, so the counts of the new findings do not contradict the verdict.
// This gives an empty list when no blocking finding is carried.
function carriedNote(record: RunRecord): string[] {
  const n = record.posted.carried.filter((f) => f.severity === "blocking").length;
  return n > 0 ? [`Open from earlier runs: ${n} blocking.`] : [];
}

function list(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

// Each part of the coverage, as "<label>: <value>". A part whose value is
// "none" or "0" carries no news; "news" says so.
function coverageParts(record: RunRecord): { text: string; news: boolean }[] {
  const c = record.posted.coverage;
  const prior = record.identity.prior;
  const skipped = c.reviewers_skipped.map(
    (s) => `${s.name} (${s.reason}${s.pass !== undefined ? `, pass ${s.pass}` : ""})`,
  );
  const withoutBash = c.reviewers_without_bash.map((r) => `${r.name} (${r.reason})`);
  const named = (label: string, names: string[]): { text: string; news: boolean } => ({
    text: `${label}: ${list(names)}`,
    news: names.length > 0,
  });
  return [
    { text: `reviewers ran: ${list(c.reviewers_ran)}`, news: true },
    named("reviewers failed", c.reviewers_failed),
    named("reviewers skipped", skipped),
    named("reviewers without Bash", withoutBash),
    named("sensitive paths without hunks", c.sensitive_without_hunks),
    {
      text: `findings dropped by failed verifier calls: ${c.findings_dropped_by_failed_verifier}`,
      news: c.findings_dropped_by_failed_verifier > 0,
    },
    // A later run with no prior record, or a fresh run that could not
    // fetch the last reviewed head, says so (R7).
    ...(prior?.source === "marker" && !prior.fetch_failed
      ? [{ text: "no prior record", news: true }]
      : []),
    ...(prior?.fetch_failed
      ? [{ text: `fresh run: could not fetch ${prior.head.slice(0, 7)}`, news: true }]
      : []),
  ];
}

/** The coverage line of the table output: every part, on one line. */
export function renderCoverage(record: RunRecord): string {
  return `Coverage: ${coverageParts(record)
    .map((p) => p.text)
    .join("; ")}`;
}

// The coverage as bullets. Only the parts that carry news are listed.
function coverageBullets(record: RunRecord): string[] {
  return coverageParts(record)
    .filter((p) => p.news)
    .map((p) => `- ${p.text.charAt(0).toUpperCase()}${p.text.slice(1)}`);
}

// How many findings the reviewers raised, and how many the verifier dropped.
function candidatesLine(record: RunRecord): string {
  const all = record.stages.verifications;
  if (all.length === 0) return "- No candidate finding raised";
  const dropped = all.filter((v) => !v.passed).length;
  const noun = all.length === 1 ? "candidate finding" : "candidate findings";
  return `- ${all.length} ${noun} raised, ${dropped} dropped by the verifier`;
}

// The cost in dollars and the time the stages took.
function costLine(record: RunRecord): string {
  const { total_cost_usd, stage_ms } = record.cost;
  const cost = total_cost_usd === null ? "Cost unknown" : `Cost $${total_cost_usd.toFixed(2)}`;
  const ms = Object.values(stage_ms).reduce((sum, n) => sum + n, 0);
  return `- ${cost}, ${Math.round(ms / 1000)} s of run time`;
}

// The folded block at the end of the body: coverage, candidates and cost.
function detailsBlock(record: RunRecord): string[] {
  return [
    "<details><summary>Coverage and cost</summary>",
    "",
    ...coverageBullets(record),
    candidatesLine(record),
    costLine(record),
    "",
    "</details>",
  ];
}

const VERDICT_ICON: Record<RunRecord["posted"]["verdict"], string> = {
  "would approve": "\u2705",
  "would request changes": "\u274c",
  incomplete: "\u26a0\ufe0f",
  skipped: "",
};

/** The text after the marker of a skip review. */
export function renderSkipLine(reason: string): string {
  return `**Skipped** at tier skip: ${escapeText(oneLine(reason))}`;
}

/**
 * The review body. Line 1: the run marker. Then the verdict as a heading
 * with its icon, the tier and the tier reason, the counts as a table, the
 * open blocking findings of earlier runs (when there are any), the
 * findings outside the diff, the carried markers, a folded block with the
 * coverage, the candidates and the cost, and the tool version. At the
 * skip tier, the body is one line: the marker and the reason.
 */
export function renderReviewBody(input: {
  marker: RunMarker;
  record: RunRecord;
  slug: string;
  bodyFindings: PostedFinding[];
  carriedMarkers: string[];
  sinceHead?: string;
}): string {
  const { marker, record } = input;
  const { identity, posted } = record;
  if (marker.tier === "skip") {
    return `${formatRunMarker(marker)} ${renderSkipLine(identity.tier_reason)}`;
  }
  const lines = [
    formatRunMarker(marker),
    `## ${VERDICT_ICON[posted.verdict]} ${VERDICT_TEXT[posted.verdict]}`,
    "",
    `**Tier** ${identity.tier}. ${escapeText(oneLine(identity.tier_reason))}`,
    "",
    ...countsTable(posted.findings),
    "",
    ...carriedNote(record),
  ];
  if (input.sinceHead !== undefined) {
    lines.push(`Review of changes since ${input.sinceHead.slice(0, 7)}`);
  }
  if (input.bodyFindings.length > 0) {
    lines.push("", "### Findings outside the diff", "");
    for (const f of input.bodyFindings) {
      const link = `[${escapeText(f.file)}#L${f.start_line}-L${f.end_line}](${permalink(input.slug, identity.head, f)})`;
      lines.push(`- ${headline(f)} ${link} ${formatFingerprintMarker(f.fingerprint)}`);
    }
  }
  if (input.carriedMarkers.length > 0) lines.push("", ...input.carriedMarkers);
  lines.push("", ...detailsBlock(record), "", `<sub>pr-review ${identity.tool_version}</sub>`);
  return lines.join("\n");
}

/** The inline comment of a finding, on the right side of its span. */
export function renderInlineComment(f: PostedFinding): InlineComment {
  const body = [
    headline(f),
    "",
    escapeText(f.explanation.trim()),
    "",
    formatFingerprintMarker(f.fingerprint),
  ].join("\n");
  const multi = f.end_line > f.start_line;
  return {
    path: f.file,
    line: f.end_line,
    ...(multi ? { start_line: f.start_line, start_side: "RIGHT" as const } : {}),
    side: "RIGHT",
    body,
  };
}

/**
 * The check run text: the verdict as title; the number of posted
 * findings, the counts as a table, the open blocking findings of earlier
 * runs, and the coverage, the candidates and the cost as bullets.
 */
export function renderCheckRun(record: RunRecord): { title: string; summary: string } {
  const n = record.posted.findings.length;
  return {
    title: VERDICT_TEXT[record.posted.verdict],
    summary: [
      `${n} ${n === 1 ? "finding" : "findings"} posted.`,
      "",
      ...countsTable(record.posted.findings),
      "",
      ...carriedNote(record),
      ...coverageBullets(record),
      candidatesLine(record),
      costLine(record),
    ].join("\n"),
  };
}

/** The cleanup comment of the verified pre-existing findings (R6). */
export function renderCleanupComment(findings: PostedFinding[]): string {
  const lines = [
    CLEANUP_MARKER,
    "### Cleanup opportunities",
    "",
    "These issues are in code that this pull request does not change. They do not change the verdict.",
    "",
  ];
  if (findings.length === 0) lines.push("None remain.");
  for (const f of findings) lines.push(`- ${headline(f)}`);
  return lines.join("\n");
}

/** Remove token-like text, put the text on one line, escape it and cut it. */
function safeMessage(message: string): string {
  return escapeText(oneLine(redact(message))).slice(0, MAX_FAILURE_MESSAGE);
}

/** The body of the failure review of R5a: the marker and one line. */
export function renderFailureBody(marker: RunMarker, stage: string, message: string): string {
  return `${formatRunMarker(marker)}\npr-review failed at ${stage}: ${safeMessage(message)}`;
}
