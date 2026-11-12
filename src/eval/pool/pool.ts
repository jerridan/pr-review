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
import { adjudicateFinding, scoreOf, type Adjudication, type FamilyResult } from "./adjudicate.js";
import type { PoolContext } from "./calls.js";
import {
  groupClusters,
  groupFindings,
  joinIdentical,
  type Cluster,
  type Sourced,
} from "./group.js";
import { reviewerFindings, type PoolRecord } from "./records.js";
import { blindReviews } from "./review.js";
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

export type PoolCaseOptions = { reviews: number; writeGolden: boolean; out: string };

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
};

/** One pool item: an id, the fields of its representative, and its members. */
export type PoolItem = { id: string; finding: PoolFinding; members: Sourced[] };

/** The span of a golden, and the family it comes from. */
export type GoldenSpan = { start_line: number; end_line: number; from: "claude" | "gpt" };

/**
 * What became of an item: "golden" when it writes a golden, "joined" when
 * a golden of an overlapping item stands for it, "no_span" when it is kept
 * with no valid span, "not_kept" for a low score, "failed" for a failed call.
 */
export type Outcome = "golden" | "joined" | "no_span" | "not_kept" | "failed";

export type ItemAdjudication = {
  id: string;
  claude: FamilyResult;
  gpt: FamilyResult;
  kept: boolean;
  outcome: Outcome;
  span?: GoldenSpan;
  joined_into?: string;
};

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

/**
 * Join the kept items with a span. The items whose spans overlap another
 * kept item in the same file go through the grouping call once more. Each
 * group keeps the member with the highest lower score. Set the outcome of
 * each item.
 */
async function joinKept(
  name: string,
  items: readonly PoolItem[],
  results: ItemAdjudication[],
  ctx: PoolContext,
): Promise<void> {
  const withSpan = results
    .map((r, n) => ({ r, item: items[n] as PoolItem }))
    .filter(
      (x): x is { r: ItemAdjudication & { span: GoldenSpan }; item: PoolItem } =>
        x.r.span !== undefined,
    );
  const overlapping = withSpan.filter((x) =>
    withSpan.some((y) => y !== x && overlaps(x.item, x.r.span, y.item, y.r.span)),
  );
  for (const x of withSpan) x.r.outcome = "golden";
  if (overlapping.length < 2) return;
  const grouped = await groupFindings(
    overlapping.map((x) => ({
      ...x.item.finding,
      start_line: x.r.span.start_line,
      end_line: x.r.span.end_line,
    })),
    ctx,
  );
  if (!grouped.ok) {
    throw new PoolCaseError(
      name,
      `the grouping of the overlapping kept items failed: ${grouped.error}`,
    );
  }
  for (const g of grouped.groups) {
    const members = g.members.map((i) => overlapping[i] as (typeof overlapping)[number]);
    const best = members.reduce((a, b) => (lowerScore(b.r) > lowerScore(a.r) ? b : a));
    for (const m of members) {
      if (m === best) continue;
      m.r.outcome = "joined";
      m.r.joined_into = best.item.id;
    }
  }
}

function golden(item: PoolItem, r: ItemAdjudication & { span: GoldenSpan }): GoldenFinding {
  return {
    file: item.finding.file,
    start_line: r.span.start_line,
    end_line: r.span.end_line,
    category: item.finding.category,
    severity: "unsure",
    claim: item.finding.claim,
    note: `Pool item ${item.id}: Claude score ${scoreOf(r.claude)}, GPT score ${scoreOf(r.gpt)}.`,
  };
}

async function poolInCheckout(
  c: Case,
  records: readonly PoolRecord[],
  opts: PoolCaseOptions,
  ctx: PoolContext,
): Promise<PoolCaseResult> {
  const diff = await readFile(join(c.dir, "diff.patch"), "utf8");

  // Step 1: the blind reviews. Step 2: the record findings.
  const runs = await blindReviews(
    { title: c.title, body: c.body, changedFiles: [...diffSections(diff).keys()], diff },
    opts.reviews,
    ctx,
  );
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
  const dir = join(opts.out, c.name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "pool.json"),
    json({ items: items.map((i) => ({ id: i.id, ...i.finding })) }),
  );
  const key = Object.fromEntries(
    items.map((i) => [
      i.id,
      { members: i.members.map((m) => ({ source: m.source, ...sixFields(m.finding) })) },
    ]),
  );
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
    if (a.kept) {
      const span = goldenSpan(item.finding.file, a, ctx.checkout);
      if (span === null) entry.outcome = "no_span";
      else entry.span = span;
    }
    return entry;
  });

  // Step 6: join the kept items.
  await joinKept(c.name, items, results, ctx);
  await writeFile(join(dir, "adjudications.json"), json({ items: results }));
  const goldens = results.flatMap((r, n) =>
    r.outcome === "golden" && r.span !== undefined
      ? [golden(items[n] as PoolItem, { ...r, span: r.span })]
      : [],
  );
  if (opts.writeGolden) await writeFile(join(c.dir, "golden.json"), json({ findings: goldens }));

  return {
    name: c.name,
    items: items.length,
    kept: results.filter((r) => r.kept).length,
    failed: results.filter((r) => r.outcome === "failed").length,
    goldens: goldens.length,
    noSpan: results.filter((r) => r.outcome === "no_span").length,
    costUsd: ctx.cost.usd,
    reviewErrors: runs.flatMap((r) => (r.ok ? [] : [`${r.source}: ${r.error}`])),
  };
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

/** The summary line of one case. */
export function summaryLine(r: PoolCaseResult): string {
  return `${r.name}: ${r.items} items, ${r.kept} kept, ${r.failed} failed, ${r.goldens} goldens, ${r.noSpan} no_span, cost $${r.costUsd.toFixed(2)}`;
}
