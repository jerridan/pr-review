// Pool one case: blind reviews and record findings, grouping, an anonymous
// pool, adjudication, and the goldens of the kept items.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineCount, readHeadFile } from "../../find/evidence.js";
import { diffSections } from "../../gather/diff.js";
import type { SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";
import type { Semaphore } from "../../semaphore.js";
import type { Case, GoldenFinding } from "../case.js";
import { cloneCase } from "../checkout.js";
import {
  adjudicateFinding,
  DISMISS_BELOW,
  scoreOf,
  type Adjudication,
  type FamilyResult,
} from "./adjudicate.js";
import type { PoolContext } from "./calls.js";
import {
  groupClusters,
  groupFindings,
  joinIdentical,
  type Cluster,
  type Sourced,
} from "./group.js";
import {
  dismissedFindings,
  reviewerFindings,
  type DismissLabel,
  type PoolRecord,
} from "./records.js";
import { CallMemo } from "./memo.js";
import { blindReviews, type ReviewRun } from "./review.js";
import { sixFields, type PoolFinding } from "./schemas.js";

/** A case that the pool could not finish. */
export class PoolCaseError extends Error {
  constructor(caseName: string, message: string) {
    super(`case ${caseName}: ${message}`);
    this.name = "PoolCaseError";
  }
}

/** What every case of one run shares. */
export type PoolShared = { client: SdkClient; options: RunOptions; semaphore: Semaphore };

export type PoolCaseOptions = {
  reviews: number;
  writeGolden: boolean;
  out: string;
  /** Write goldens for the findings that the verifier dismissed. */
  dismissed?: boolean;
  /** Reuse the kept results of an earlier run in the output directory. */
  resume?: boolean;
};

/** The dismissed findings of one case, for the summary. */
export type DismissedSummary = {
  /** The dismissed findings of the records with the head of the case. */
  counted: number;
  /** The counted findings with no matching reviewer finding. */
  unmatched: string[];
  /** The marked items that write a pool golden (kept). */
  kept: number;
  /** The marked items that write a dismissed golden. */
  dismissedGoldens: number;
  /** The marked items that write no golden, with the reason. */
  noGolden: string[];
  /** The records that the head rule left out. */
  otherHead: string[];
};

/** The counts of one case, for the summary line. */
export type PoolCaseResult = {
  name: string;
  items: number;
  kept: number;
  failed: number;
  goldens: number;
  noSpan: number;
  costUsd: number;
  /** The errors of the blind reviews that failed. */
  reviewErrors: string[];
  /** The blind reviews, Claude first, each family in order. */
  reviews: ReviewRun[];
  /** Why --write-golden left golden.json unchanged, or null. */
  goldenSkipped: string | null;
  /** The dismissed findings, or null without --dismissed. */
  dismissed: DismissedSummary | null;
  /** The calls that kept results served and the calls made, or null without --resume. */
  resumed: { reused: number; made: number } | null;
};

/** One pool item: an id, the fields of its representative, and its members. */
export type PoolItem = { id: string; finding: PoolFinding; members: Sourced[] };

/** The span of a golden, and the family it comes from. */
export type GoldenSpan = { start_line: number; end_line: number; from: "claude" | "gpt" };

/**
 * What became of an item: "golden" when it writes a golden, "joined" when
 * a golden of an overlapping item stands for it, "no_span" when it is kept
 * with no valid span, "not_kept" for a low score, "failed" for a failed call.
 * "dismissed_golden" is for a dismissed item that both families score below
 * 50: it writes a golden whose claim is false.
 */
export type Outcome = "golden" | "joined" | "no_span" | "not_kept" | "failed" | "dismissed_golden";

export type ItemAdjudication = {
  id: string;
  claude: FamilyResult;
  gpt: FamilyResult;
  kept: boolean;
  outcome: Outcome;
  span?: GoldenSpan;
  joined_into?: string;
};

/** One entry of reviews.json: the findings of a review, or its failure. */
export type ReviewEntry = {
  source: string;
  ok: boolean;
  findings?: number;
  failed?: string;
  cost_usd?: number;
};

function reviewEntry(r: ReviewRun): ReviewEntry {
  const entry: ReviewEntry = r.ok
    ? { source: r.source, ok: true, findings: r.findings.length }
    : { source: r.source, ok: false, failed: r.error };
  if (r.costUsd !== undefined) entry.cost_usd = Math.round(r.costUsd * 1e6) / 1e6;
  return entry;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Compare code units, so the order does not depend on the locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Give each cluster an id. The order is the order of a hash of the item
 * text, so it does not show the source of an item.
 */
export function anonymise(clusters: readonly Cluster[]): PoolItem[] {
  const keyed = clusters.map((c) => {
    const text = JSON.stringify(sixFields(c.rep));
    return { c, hash: createHash("sha256").update(text).digest("hex"), text };
  });
  keyed.sort((a, b) => compare(a.hash, b.hash) || compare(a.text, b.text));
  const width = Math.max(2, String(keyed.length).length);
  return keyed.map(({ c }, n) => ({
    id: `p${String(n + 1).padStart(width, "0")}`,
    finding: sixFields(c.rep),
    members: c.members,
  }));
}

function spanValid(start: number, end: number, lines: number | null): boolean {
  return lines !== null && start >= 1 && end >= start && end <= lines;
}

/**
 * The golden span of a kept item: the Claude span when it lies inside the
 * file at the case head, else the GPT span when that does, else null.
 */
export function goldenSpan(file: string, a: Adjudication, checkout: string): GoldenSpan | null {
  const text = readHeadFile(checkout, file);
  const lines = text === null ? null : lineCount(text);
  for (const [from, r] of [
    ["claude", a.claude],
    ["gpt", a.gpt],
  ] as const) {
    if ("failed" in r) continue;
    if (spanValid(r.start_line, r.end_line, lines)) {
      return { start_line: r.start_line, end_line: r.end_line, from };
    }
  }
  return null;
}

// The lower of the two scores of a kept item.
function lowerScore(a: ItemAdjudication): number {
  return Math.min(scoreOf(a.claude) ?? 0, scoreOf(a.gpt) ?? 0);
}

function overlaps(a: PoolItem, sa: GoldenSpan, b: PoolItem, sb: GoldenSpan): boolean {
  return (
    a.finding.file === b.finding.file &&
    sa.start_line <= sb.end_line &&
    sb.start_line <= sa.end_line
  );
}

type Spanned = { r: ItemAdjudication & { span: GoldenSpan }; item: PoolItem };

// The connected components of the span-overlap graph: items of one file
// whose golden spans overlap, directly or through other items.
function components(items: readonly Spanned[]): Spanned[][] {
  const parent = items.map((_, n) => n);
  const root = (n: number): number => {
    let r = n;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const x = items[i] as Spanned;
      const y = items[j] as Spanned;
      if (overlaps(x.item, x.r.span, y.item, y.r.span)) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, Spanned[]>();
  items.forEach((x, n) => groups.set(root(n), [...(groups.get(root(n)) ?? []), x]));
  return [...groups.values()];
}

/**
 * Join the kept items with a span. The items of one component of the
 * span-overlap graph go through the grouping call once more, one call for
 * each component of two or more items. A group never holds items of two
 * components. Each group keeps the member with the highest lower score.
 * Set the outcome of each joined item.
 */
async function joinKept(
  name: string,
  items: readonly PoolItem[],
  results: ItemAdjudication[],
  ctx: PoolContext,
): Promise<void> {
  const withSpan = results
    .map((r, n) => ({ r, item: items[n] as PoolItem }))
    .filter((x): x is Spanned => x.r.outcome === "golden" && x.r.span !== undefined);
  const multi = components(withSpan).filter((c) => c.length >= 2);
  const answers = await Promise.all(
    multi.map((c) =>
      groupFindings(
        c.map((x) => ({
          ...x.item.finding,
          start_line: x.r.span.start_line,
          end_line: x.r.span.end_line,
        })),
        ctx,
      ),
    ),
  );
  answers.forEach((grouped, n) => {
    if (!grouped.ok) {
      throw new PoolCaseError(
        name,
        `the grouping of the overlapping kept items failed: ${grouped.error}`,
      );
    }
    const component = multi[n] as Spanned[];
    for (const g of grouped.groups) {
      const members = g.members.map((i) => component[i] as Spanned);
      const best = members.reduce((a, b) => (lowerScore(b.r) > lowerScore(a.r) ? b : a));
      for (const m of members) {
        if (m === best) continue;
        m.r.outcome = "joined";
        m.r.joined_into = best.item.id;
      }
    }
  });
}

/** A dismissal of a member: the record file and the label of the verifier. */
type Mark = { record: string; label: DismissLabel };

function describeMarks(marks: readonly Mark[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const m of marks) {
    const text = `${m.label} in the record ${m.record}`;
    if (!seen.has(text)) parts.push(text);
    seen.add(text);
  }
  return parts.join("; ");
}

function golden(
  item: PoolItem,
  r: ItemAdjudication & { span: GoldenSpan },
  marks: readonly Mark[],
): GoldenFinding {
  const scores = `Claude score ${scoreOf(r.claude)}, GPT score ${scoreOf(r.gpt)}`;
  let note = `Pool item ${item.id}: ${scores}.`;
  if (marks.length > 0 && r.outcome === "dismissed_golden") {
    note += ` The verifier dismissed it as ${describeMarks(marks)}. Both families score it below ${DISMISS_BELOW}, so the claim is false at the head, or it is not a defect of this PR.`;
  } else if (marks.length > 0) {
    note += ` The verifier dismissed it as ${describeMarks(marks)}.`;
  }
  return {
    file: item.finding.file,
    start_line: r.span.start_line,
    end_line: r.span.end_line,
    category: item.finding.category,
    severity: "unsure",
    claim: item.finding.claim,
    note,
  };
}

// The key of a record member: its source and its six fields.
function memberKey(m: Sourced): string {
  return JSON.stringify([m.source, sixFields(m.finding)]);
}

type Dismissals = {
  marks: Map<string, Mark[]>;
  counted: number;
  unmatched: string[];
  otherHead: string[];
};

/**
 * Find the dismissed findings that count: those of the records whose head
 * is the head of the case. Mark the record members that match one on the
 * six fields.
 */
function findDismissals(head: string, records: readonly PoolRecord[]): Dismissals {
  const out: Dismissals = { marks: new Map(), counted: 0, unmatched: [], otherHead: [] };
  for (const record of records) {
    const dismissed = dismissedFindings(record);
    if (record.head !== head) {
      if (dismissed.length > 0) out.otherHead.push(record.name);
      continue;
    }
    const members = reviewerFindings(record).map(({ reviewer, finding }): Sourced => ({
      source: `record:${record.name}:${reviewer}`,
      finding,
    }));
    for (const d of dismissed) {
      out.counted += 1;
      const want = JSON.stringify(sixFields(d.finding));
      const hits = members.filter((m) => JSON.stringify(sixFields(m.finding)) === want);
      for (const m of hits) {
        const key = memberKey(m);
        out.marks.set(key, [
          ...(out.marks.get(key) ?? []),
          { record: record.name, label: d.label },
        ]);
      }
      if (hits.length === 0) {
        const f = d.finding;
        const claim = f.claim.length > 100 ? `${f.claim.slice(0, 100)}...` : f.claim;
        out.unmatched.push(
          `${record.name}: ${d.label} ${f.file}:${f.start_line}-${f.end_line} ${claim}`,
        );
      }
    }
  }
  return out;
}

// True when both families answered and both score below the dismiss limit.
function bothLow(a: Adjudication): boolean {
  const scores = [scoreOf(a.claude), scoreOf(a.gpt)];
  return scores.every((n) => n !== null && n < DISMISS_BELOW);
}

async function poolInCheckout(
  c: Case,
  records: readonly PoolRecord[],
  opts: PoolCaseOptions,
  base: PoolContext,
): Promise<PoolCaseResult> {
  const diff = await readFile(join(c.dir, "diff.patch"), "utf8");
  const dir = join(opts.out, c.name);
  await mkdir(dir, { recursive: true });
  // calls.json keeps each call that succeeded, so a later --resume run can reuse it.
  const memo = new CallMemo(join(dir, "calls.json"), c.head, opts.resume === true);
  const ctx: PoolContext = { ...base, memo };

  // Step 1: the blind reviews. Step 2: the record findings.
  const runs = await blindReviews(
    { title: c.title, body: c.body, changedFiles: [...diffSections(diff).keys()], diff },
    opts.reviews,
    ctx,
  );
  // reviews.json shows what each blind review gave. The pool and the
  // adjudication calls never read it.
  await writeFile(join(dir, "reviews.json"), json({ reviews: runs.map(reviewEntry) }));
  const sourced: Sourced[] = runs.flatMap((r) =>
    r.ok ? r.findings.map((finding) => ({ source: r.source, finding })) : [],
  );
  for (const record of records) {
    for (const { reviewer, finding } of reviewerFindings(record)) {
      sourced.push({ source: `record:${record.name}:${reviewer}`, finding });
    }
  }

  // Step 3: group. Step 4: anonymise.
  const grouped = await groupClusters(joinIdentical(sourced), ctx);
  if (!grouped.ok) throw new PoolCaseError(c.name, `the grouping call failed: ${grouped.error}`);
  const items = anonymise(grouped.clusters);
  await writeFile(
    join(dir, "pool.json"),
    json({ items: items.map((i) => ({ id: i.id, ...i.finding })) }),
  );
  const dismissals = opts.dismissed === true ? findDismissals(c.head, records) : null;
  const marksOf = (m: Sourced): Mark[] => dismissals?.marks.get(memberKey(m)) ?? [];
  const key = Object.fromEntries(
    items.map((i) => [
      i.id,
      {
        members: i.members.map((m) => {
          const labels = [...new Set(marksOf(m).map((x) => x.label))].sort();
          return {
            source: m.source,
            ...sixFields(m.finding),
            ...(labels.length > 0 ? { dismissed: labels.join(",") } : {}),
          };
        }),
      },
    ]),
  );
  const itemMarks = items.map((i) => i.members.flatMap(marksOf));
  await writeFile(join(dir, "pool-key.json"), json(key));

  // Step 5: adjudicate.
  const adjudications = await Promise.all(
    items.map((i) => adjudicateFinding(i.finding, diff, ctx)),
  );
  const results: ItemAdjudication[] = adjudications.map((a, n) => {
    const item = items[n] as PoolItem;
    const failed = "failed" in a.claude || "failed" in a.gpt;
    const entry: ItemAdjudication = {
      id: item.id,
      claude: a.claude,
      gpt: a.gpt,
      kept: a.kept,
      outcome: failed ? "failed" : "not_kept",
    };
    const dismissedItem = (itemMarks[n] as Mark[]).length > 0 && !failed && !a.kept && bothLow(a);
    if (a.kept || dismissedItem) {
      const span = goldenSpan(item.finding.file, a, ctx.checkout);
      if (span === null) entry.outcome = "no_span";
      else {
        entry.span = span;
        entry.outcome = a.kept ? "golden" : "dismissed_golden";
      }
    }
    return entry;
  });

  // Write the adjudications before the join, so a failed join loses none.
  await writeFile(join(dir, "adjudications.json"), json({ items: results }));

  // Step 6: join the kept items.
  await joinKept(c.name, items, results, ctx);
  await writeFile(join(dir, "adjudications.json"), json({ items: results }));
  const goldens = results.flatMap((r, n) =>
    (r.outcome === "golden" || r.outcome === "dismissed_golden") && r.span !== undefined
      ? [golden(items[n] as PoolItem, { ...r, span: r.span }, itemMarks[n] as Mark[])]
      : [],
  );
  const failedReviews = runs.filter((r) => !r.ok).length;
  const failedItems = results.filter((r) => r.outcome === "failed").length;
  let goldenSkipped: string | null = null;
  if (opts.writeGolden) {
    if (failedReviews > 0 || failedItems > 0) {
      goldenSkipped = `${failedReviews} blind reviews and ${failedItems} adjudications failed`;
    } else {
      await writeFile(join(c.dir, "golden.json"), json({ findings: goldens }));
    }
  }

  const dismissed: DismissedSummary | null =
    dismissals === null ? null : summariseDismissed(dismissals, items, results, itemMarks);
  return {
    name: c.name,
    items: items.length,
    kept: results.filter((r) => r.kept).length,
    failed: results.filter((r) => r.outcome === "failed").length,
    goldens: goldens.length,
    noSpan: results.filter((r) => r.outcome === "no_span").length,
    costUsd: ctx.cost.usd,
    reviewErrors: runs.flatMap((r) => (r.ok ? [] : [`${r.source}: ${r.error}`])),
    reviews: runs,
    goldenSkipped,
    dismissed,
    resumed: opts.resume === true ? memo.counts() : null,
  };
}

function summariseDismissed(
  d: Dismissals,
  items: readonly PoolItem[],
  results: readonly ItemAdjudication[],
  itemMarks: readonly Mark[][],
): DismissedSummary {
  const summary: DismissedSummary = {
    counted: d.counted,
    unmatched: d.unmatched,
    kept: 0,
    dismissedGoldens: 0,
    noGolden: [],
    otherHead: d.otherHead,
  };
  results.forEach((r, n) => {
    if ((itemMarks[n] as Mark[]).length === 0) return;
    const id = (items[n] as PoolItem).id;
    if (r.outcome === "golden" || r.outcome === "joined") summary.kept += 1;
    else if (r.outcome === "dismissed_golden") summary.dismissedGoldens += 1;
    else {
      const why =
        r.outcome === "failed"
          ? "a model call failed"
          : r.outcome === "no_span"
            ? "no valid span"
            : "the families do not agree";
      summary.noGolden.push(
        `${id}: ${why} (Claude ${scoreOf(r.claude) ?? "failed"}, GPT ${scoreOf(r.gpt) ?? "failed"})`,
      );
    }
  });
  return summary;
}

/** The summary line of the calls of a resumed run, or none. */
export function resumeLines(r: PoolCaseResult): string[] {
  return r.resumed === null
    ? []
    : [`${r.name}: resume ${r.resumed.reused} reused, ${r.resumed.made} new`];
}

/** The summary lines of the dismissed findings of one case, or none. */
export function dismissedLines(r: PoolCaseResult): string[] {
  const d = r.dismissed;
  if (d === null) return [];
  const lines = [
    `${r.name}: dismissed ${d.counted} counted, ${d.unmatched.length} unmatched, ${d.kept} kept, ${d.dismissedGoldens} dismissed_golden, ${d.noGolden.length} no golden`,
  ];
  for (const u of d.unmatched) lines.push(`${r.name}: unmatched dismissed finding in ${u}`);
  for (const n of d.noGolden) lines.push(`${r.name}: no golden for dismissed item ${n}`);
  for (const o of d.otherHead) {
    lines.push(
      `${r.name}: the record ${o} has another head, so its dismissed findings do not count`,
    );
  }
  return lines;
}

/**
 * Pool one case in its own checkout. Throw a PoolCaseError when the
 * checkout or a grouping call fails.
 */
export async function poolCase(
  c: Case,
  records: readonly PoolRecord[],
  opts: PoolCaseOptions,
  shared: PoolShared,
): Promise<PoolCaseResult> {
  const tmp = await mkdtemp(join(tmpdir(), "pr-review-pool-"));
  try {
    const checkout = await cloneCase(c, join(tmp, "repo"));
    const ctx: PoolContext = { ...shared, checkout, cost: { usd: 0 } };
    return await poolInCheckout(c, records, opts, ctx);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// The findings of each review of one family, joined with "+", or "failed".
function familyCounts(runs: readonly ReviewRun[], prefix: string): string {
  return runs
    .filter((r) => r.source.startsWith(prefix))
    .map((r) => (r.ok ? String(r.findings.length) : "failed"))
    .join("+");
}

/** The summary line of one case. */
export function summaryLine(r: PoolCaseResult): string {
  const reviews = `reviews claude ${familyCounts(r.reviews, "claude-")}, gpt ${familyCounts(r.reviews, "gpt-")}`;
  return `${r.name}: ${r.items} items, ${r.kept} kept, ${r.failed} failed, ${r.goldens} goldens, ${r.noSpan} no_span, cost $${r.costUsd.toFixed(2)}; ${reviews}`;
}
