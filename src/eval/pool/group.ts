// Group the findings of the pool. Identical findings join in code. Then one
// Claude call groups the findings that state the same defect at the same
// place.
import { z } from "zod";
import { claudeCall, type PoolContext } from "./calls.js";
import { groupMessage } from "./prompts.js";
import { GroupOutputSchema, sixFields, type GroupOutput, type PoolFinding } from "./schemas.js";

/** A finding with its source label. */
export type Sourced = { source: string; finding: PoolFinding };

/** A group of findings. "rep" is the member whose fields the group takes. */
export type Cluster = { rep: PoolFinding; members: Sourced[] };

/** One group of a grouping call: indexes into its input, and the representative. */
export type Group = { members: number[]; representative: number };

export type GroupResult = { ok: true; groups: Group[] } | { ok: false; error: string };

// Compare code units, so the order does not depend on the locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Join the findings with identical file, lines and claim. The member whose
 * source sorts first represents the group. The groups keep the order of
 * their first member.
 */
export function joinIdentical(items: readonly Sourced[]): Cluster[] {
  const groups = new Map<string, Sourced[]>();
  for (const item of items) {
    const f = item.finding;
    const key = JSON.stringify([f.file, f.start_line, f.end_line, f.claim]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map((members) => {
    const first = [...members].sort((a, b) => compare(a.source, b.source))[0] as Sourced;
    return { rep: first.finding, members };
  });
}

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `i${i + 1}`);
}

// Turn the answer into groups of indexes. Every finding is in one group.
// A finding that the answer leaves out is a group of its own.
function toGroups(out: GroupOutput, names: readonly string[]): Group[] | string {
  const index = new Map(names.map((name, i) => [name, i]));
  const seen = new Set<number>();
  const groups: Group[] = [];
  for (const g of out.groups) {
    const members: number[] = [];
    for (const name of g.members) {
      const i = index.get(name);
      if (i === undefined) return `the grouping names the unknown id ${name}`;
      if (seen.has(i)) return `the grouping puts ${name} in two groups`;
      seen.add(i);
      members.push(i);
    }
    if (members.length === 0) continue;
    const rep = index.get(g.representative);
    if (rep === undefined || !members.includes(rep)) {
      return `the representative ${g.representative} is not a member of its group`;
    }
    groups.push({ members, representative: rep });
  }
  for (let i = 0; i < names.length; i++) {
    if (!seen.has(i)) groups.push({ members: [i], representative: i });
  }
  return groups;
}

const KeptGroupsSchema = z.array(
  z.object({ members: z.array(z.number()), representative: z.number() }),
);

/**
 * Group "findings" with one Claude call. Fewer than two findings need no
 * call. An answer that names an unknown id, puts a finding in two groups,
 * or names a representative outside its group is a failed call.
 */
export async function groupFindings(
  findings: readonly PoolFinding[],
  ctx: PoolContext,
): Promise<GroupResult> {
  const names = ids(findings.length);
  if (findings.length < 2) {
    return { ok: true, groups: names.map((_, i) => ({ members: [i], representative: i })) };
  }
  // A kept answer is for the same findings in the same order.
  const key = JSON.stringify(findings.map(sixFields));
  const old = ctx.memo?.get("group", key, KeptGroupsSchema);
  if (old !== undefined) return { ok: true, groups: old };
  let groups: Group[] = [];
  const result = await claudeCall(
    "pool-grouper",
    groupMessage(findings, names),
    GroupOutputSchema,
    ctx,
    (out) => {
      const g = toGroups(out, names);
      if (typeof g === "string") return g;
      groups = g;
      return null;
    },
  );
  if (!result.ok) return { ok: false, error: result.error };
  ctx.memo?.set("group", key, groups);
  return { ok: true, groups };
}

/** Group the clusters with the grouping call. Each group of clusters becomes one cluster. */
export async function groupClusters(
  clusters: readonly Cluster[],
  ctx: PoolContext,
): Promise<{ ok: true; clusters: Cluster[] } | { ok: false; error: string }> {
  const result = await groupFindings(
    clusters.map((c) => c.rep),
    ctx,
  );
  if (!result.ok) return result;
  return {
    ok: true,
    clusters: result.groups.map((g) => ({
      rep: (clusters[g.representative] as Cluster).rep,
      members: g.members.flatMap((i) => (clusters[i] as Cluster).members),
    })),
  };
}
