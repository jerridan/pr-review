// The cases subset by cost (D8): make a cases directory that leaves out
// the expensive cases. The cost per run of each case comes from an earlier
// eval: its report.json, its --out directory, or a baseline file.
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { EXIT_OK, EXIT_USAGE } from "../cli.js";
import { costPerRun, readBaseline } from "./baseline.js";
import { CaseError, loadCases, type Case } from "./case.js";

/** The flags of "pr-review eval-subset". Exactly one mode is set. */
export type EvalSubsetOptions = {
  cases: string;
  costs: string;
  to: string;
  mode: { kind: "max-cost"; maxCost: number } | { kind: "budget"; budget: number; repeats: number };
};

/** The file that the subset command writes at the root of the new cases directory. */
export const SUBSET_FILE = "subset.json";

// A limit or a sum within this distance of the budget is at the budget.
const TOLERANCE = 1e-9;

class SubsetError extends Error {}

function say(message: string): void {
  process.stderr.write(`pr-review eval-subset: ${message}\n`);
}

const RepeatCost = z.object({ failed: z.boolean(), cost_usd: z.number().nullable() });
const ReportCosts = z.object({
  cases: z.array(z.object({ name: z.string(), repeats: z.array(RepeatCost) })),
});
const ResultCost = z.object({ metrics: RepeatCost });

// The costs per run in report.json.
function reportCosts(value: unknown, path: string): Map<string, number> {
  const parsed = ReportCosts.safeParse(value);
  if (!parsed.success) throw new SubsetError(`${path} is not an eval report.json`);
  const costs = new Map<string, number>();
  for (const c of parsed.data.cases) {
    const cost = costPerRun(c.repeats);
    if (cost !== null) costs.set(c.name, cost);
  }
  return costs;
}

// The costs per run in an --out directory, from the result.json of each
// repeat of each case.
async function outCosts(dir: string, cases: Case[]): Promise<Map<string, number>> {
  const costs = new Map<string, number>();
  for (const c of cases) {
    let names: string[];
    try {
      names = (await readdir(join(dir, c.name))).filter((n) => /^[1-9][0-9]*$/.test(n));
    } catch {
      continue;
    }
    const repeats: z.infer<typeof RepeatCost>[] = [];
    for (const n of names) {
      // A repeat with no result.json did not end, so it has no cost. A
      // result.json that is not valid stops the command: a cost from fewer
      // repeats would not show.
      const path = join(dir, c.name, n, "result.json");
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        const reason = err instanceof Error ? err.message : String(err);
        throw new SubsetError(`cannot read ${path}: ${reason}`);
      }
      let parsed;
      try {
        parsed = ResultCost.safeParse(JSON.parse(text));
      } catch {
        throw new SubsetError(`${path} is not valid JSON`);
      }
      if (!parsed.success) throw new SubsetError(`${path} has no failed flag or cost`);
      repeats.push(parsed.data.metrics);
    }
    const cost = costPerRun(repeats);
    if (cost !== null) costs.set(c.name, cost);
  }
  return costs;
}

// The costs per run of the source: an --out directory, a report.json, or
// a baseline file.
async function readCosts(source: string, cases: Case[]): Promise<Map<string, number>> {
  let isDir: boolean;
  try {
    isDir = (await stat(source)).isDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SubsetError(`cannot read the cost source ${source}: ${reason}`);
  }
  if (isDir) return outCosts(source, cases);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(source, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SubsetError(`the cost source ${source} is not valid JSON: ${reason}`);
  }
  if (typeof value === "object" && value !== null && "cases" in value) {
    return reportCosts(value, source);
  }
  let baseline;
  try {
    baseline = await readBaseline(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SubsetError(`the cost source ${source} is no report.json and no baseline: ${reason}`);
  }
  if (baseline.case_costs === undefined) {
    throw new SubsetError(
      `the baseline ${source} has no cost per case. Give a report.json or an --out directory of an eval.`,
    );
  }
  return new Map(Object.entries(baseline.case_costs));
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The kept cases and the limit. "max-cost" keeps each case at or below the
 * limit. "budget" leaves out the most expensive case, and of two equal
 * costs the later name, until the repeats of the rest fit the budget. Its
 * limit is the highest cost that stays, or null when no case stays.
 */
export function chooseSubset(
  costs: Map<string, number>,
  mode: EvalSubsetOptions["mode"],
): { kept: string[]; leftOut: string[]; limit: number | null } {
  const names = [...costs.keys()].sort(byName);
  if (mode.kind === "max-cost") {
    const kept = names.filter((n) => (costs.get(n) ?? 0) <= mode.maxCost + TOLERANCE);
    return { kept, leftOut: names.filter((n) => !kept.includes(n)), limit: mode.maxCost };
  }
  const order = [...names].sort(
    (a, b) => (costs.get(b) ?? 0) - (costs.get(a) ?? 0) || byName(b, a),
  );
  const sum = (list: string[]) => list.reduce((s, n) => s + (costs.get(n) ?? 0), 0);
  let rest = order;
  while (rest.length > 0 && mode.repeats * sum(rest) > mode.budget + TOLERANCE)
    rest = rest.slice(1);
  const kept = names.filter((n) => rest.includes(n));
  const limit = kept.length === 0 ? null : Math.max(...kept.map((n) => costs.get(n) ?? 0));
  return { kept, leftOut: names.filter((n) => !rest.includes(n)), limit };
}

const usd = (value: number | null): string => (value === null ? "none" : `$${value.toFixed(4)}`);

/**
 * Make the subset: print each case with its cost and whether it stays,
 * copy the kept cases to --to, and write subset.json there. Give 0, or 2
 * for a usage error, an invalid case, or a case with no cost.
 */
export async function runEvalSubset(opts: EvalSubsetOptions): Promise<number> {
  try {
    let cases: Case[];
    try {
      cases = await loadCases(opts.cases);
    } catch (err) {
      if (err instanceof CaseError) throw new SubsetError(err.message);
      throw err;
    }
    const to = resolve(opts.to);
    if (
      await stat(to).then(
        () => true,
        () => false,
      )
    ) {
      throw new SubsetError(`${to} exists. Give a new directory with --to.`);
    }
    const source = resolve(opts.costs);
    const all = await readCosts(source, cases);
    const missing = cases.filter((c) => !all.has(c.name)).map((c) => c.name);
    if (missing.length > 0) {
      throw new SubsetError(
        missing.map((name) => `case ${name} has no cost in ${source}`).join("; "),
      );
    }
    const costs = new Map(cases.map((c) => [c.name, all.get(c.name) ?? 0]));
    const { kept, leftOut, limit } = chooseSubset(costs, opts.mode);

    await mkdir(to, { recursive: true });
    for (const c of cases.filter((c) => kept.includes(c.name))) {
      await cp(c.dir, join(to, c.name), { recursive: true });
    }
    const file = {
      source,
      mode: opts.mode.kind,
      ...(opts.mode.kind === "max-cost"
        ? { max_cost: opts.mode.maxCost }
        : { budget: opts.mode.budget, repeats: opts.mode.repeats }),
      limit,
      kept,
      left_out: leftOut,
      costs: Object.fromEntries(costs),
    };
    // The case loader reads only the subdirectories, so it ignores this file.
    await writeFile(join(to, SUBSET_FILE), `${JSON.stringify(file, null, 2)}\n`);

    const width = Math.max(...cases.map((c) => c.name.length));
    const lines = [...costs.keys()].sort(byName).map((name) => {
      const cost = usd(costs.get(name) ?? null);
      return `${name.padEnd(width)}  ${cost.padStart(10)}  ${kept.includes(name) ? "kept" : "left out"}`;
    });
    lines.push(
      "",
      `source: ${source}`,
      `limit: ${usd(limit)}`,
      `kept ${kept.length} of ${cases.length} cases in ${to}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT_OK;
  } catch (err) {
    if (!(err instanceof SubsetError)) throw err;
    say(err.message);
    return EXIT_USAGE;
  }
}
