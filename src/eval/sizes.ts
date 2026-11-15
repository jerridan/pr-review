// The size groups of a case set (D4c S3). The command reads the diff.patch
// of each case and makes no model call and no clone. The changed lines of a
// case are the added and the removed lines in the hunks of its diff. The
// files that the review run excludes do not count in the first figure:
// rename-only files and files that match the default generated globs. A
// repo config can add generated globs, but the command makes no clone, so
// it reads no repo config.
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EXIT_OK, EXIT_USAGE } from "../cli.js";
import { GENERATED_GLOBS, matchesAny } from "../config/globs.js";
import { diffSections } from "../gather/diff.js";
import { columns } from "./report.js";

/** The changed lines of one diff, and the lines of the files that the run excludes. */
export type ChangedLines = {
  changed: number;
  excluded: number;
  /** The excluded files, by new path, in path order. */
  excludedFiles: string[];
};

// A rename with no change has this line in its header.
const RENAME_ONLY = /^similarity index 100%$/m;

// The added and removed lines of the hunks of one file section. A hunk
// starts at an "@@" line. The "---" and "+++" headers come before the first
// hunk, so they do not count. A "\ No newline" line does not count.
function sectionLines(text: string): number {
  let inHunk = false;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) count += 1;
  }
  return count;
}

/** Count the changed lines of a patch, with the excluded files apart. */
export function countChangedLines(patch: string): ChangedLines {
  let changed = 0;
  let excluded = 0;
  const excludedFiles: string[] = [];
  for (const [path, text] of diffSections(patch)) {
    const lines = sectionLines(text);
    if (RENAME_ONLY.test(text) || matchesAny(path, GENERATED_GLOBS)) {
      excluded += lines;
      excludedFiles.push(path);
    } else {
      changed += lines;
    }
  }
  excludedFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { changed, excluded, excludedFiles };
}

export const SIZE_GROUPS = ["small", "medium", "large"] as const;
export type SizeGroup = (typeof SIZE_GROUPS)[number];

/** The size of one case. */
export type CaseSize = {
  name: string;
  /** The changed lines with no excluded file. */
  changed_lines: number;
  /** The changed lines of the excluded files. */
  excluded_lines: number;
  excluded_files: string[];
};

/** The output of eval-sizes. */
export type SizesReport = {
  /** The cases in size order: by changed lines, then by name. */
  cases: (CaseSize & { group: SizeGroup })[];
  /** The three groups. An empty group has the range null. */
  groups: { group: SizeGroup; cases: string[]; range: { min: number; max: number } | null }[];
};

/**
 * Sort the cases by changed lines, then by name, and split them into three
 * groups whose sizes differ by at most one. The larger groups come first.
 */
export function sizeGroups(cases: CaseSize[]): SizesReport {
  const sorted = [...cases].sort(
    (a, b) => a.changed_lines - b.changed_lines || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const base = Math.floor(sorted.length / 3);
  const extra = sorted.length % 3;
  const out: SizesReport = { cases: [], groups: [] };
  let start = 0;
  SIZE_GROUPS.forEach((group, i) => {
    const size = base + (i < extra ? 1 : 0);
    const members = sorted.slice(start, start + size);
    start += size;
    out.cases.push(...members.map((c) => ({ ...c, group })));
    const first = members[0];
    const last = members.at(-1);
    out.groups.push({
      group,
      cases: members.map((c) => c.name),
      range:
        first === undefined || last === undefined
          ? null
          : { min: first.changed_lines, max: last.changed_lines },
    });
  });
  return out;
}

/** Render the sizes as text: one row for each case, then one for each group. */
export function renderSizes(report: SizesReport): string {
  const lines = [
    "Changed lines: the added and removed lines of each diff. Excluded: the lines of rename-only and generated files, which the review run leaves out.",
    "",
    ...columns([
      ["case", "changed", "excluded", "group"],
      ...report.cases.map((c) => [
        c.name,
        String(c.changed_lines),
        String(c.excluded_lines),
        c.group,
      ]),
    ]),
    "",
    ...columns([
      ["group", "cases", "range"],
      ...report.groups.map((g) => [
        g.group,
        `${g.cases.length} ${g.cases.length === 1 ? "case" : "cases"}`,
        g.range === null ? "none" : `${g.range.min} to ${g.range.max}`,
      ]),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

/** The flags of "pr-review eval-sizes". */
export type EvalSizesOptions = { cases: string; format: "table" | "json" };

class SizesError extends Error {}

// The size of each case: each subdirectory with a case.json, in name order.
async function readSizes(dir: string): Promise<CaseSize[]> {
  const root = resolve(dir);
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SizesError(`cannot read the cases directory ${root}: ${reason}`);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sizes: CaseSize[] = [];
  for (const name of names) {
    const caseDir = join(root, name);
    try {
      await access(join(caseDir, "case.json"));
    } catch {
      continue;
    }
    let patch: string;
    try {
      patch = await readFile(join(caseDir, "diff.patch"), "utf8");
    } catch {
      throw new SizesError(`case ${name}: diff.patch is missing`);
    }
    const counted = countChangedLines(patch);
    sizes.push({
      name,
      changed_lines: counted.changed,
      excluded_lines: counted.excluded,
      excluded_files: counted.excludedFiles,
    });
  }
  if (sizes.length === 0) throw new SizesError(`the cases directory ${root} holds no case`);
  return sizes;
}

/** Print the size groups of the cases. Give 0, or 2 for a cases directory that is not valid. */
export async function runEvalSizes(opts: EvalSizesOptions): Promise<number> {
  let sizes: CaseSize[];
  try {
    sizes = await readSizes(opts.cases);
  } catch (err) {
    if (!(err instanceof SizesError)) throw err;
    process.stderr.write(`pr-review eval-sizes: ${err.message}\n`);
    return EXIT_USAGE;
  }
  const report = sizeGroups(sizes);
  process.stdout.write(
    opts.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderSizes(report),
  );
  return EXIT_OK;
}
