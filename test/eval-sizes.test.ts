// D4c S3: pr-review eval-sizes counts the changed lines of each case and
// splits the cases into three size groups, with no model call and no clone.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import { sizeGroups, type SizesReport } from "../src/eval/sizes.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import { captureOutput, cleanup, exitCodeOf, output, tempDir } from "./fixtures/eval-fixture.js";

const made: string[] = [];
afterAll(() => cleanup(made));
captureOutput();

// A file with two added lines and one removed line. The "---" and "+++"
// headers and the "\ No newline" line do not count. The removed line
// "-- x" and the added line "++ y" start like headers, but they are in the
// hunk, so they count.
const CODE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "--- x",
  "+++ y",
  "+const b = 2;",
  " const c = 3;",
  "\\ No newline at end of file",
  "",
].join("\n");

// A generated file (a lock file): its lines are excluded.
const LOCK = [
  "diff --git a/package-lock.json b/package-lock.json",
  "index 3333333..4444444 100644",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " same",
  "",
].join("\n");

// A rename with a change but no full similarity: it counts.
const RENAME_EDIT = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 90%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "index 5555555..6666666 100644",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "",
].join("\n");

// A rename-only file: excluded. It has no hunk, so it adds 0 lines.
const RENAME_ONLY = [
  "diff --git a/src/same.ts b/src/moved.ts",
  "similarity index 100%",
  "rename from src/same.ts",
  "rename to src/moved.ts",
  "",
].join("\n");

// Write one case directory per entry: case.json and diff.patch only.
function casesDir(entries: Record<string, string>): string {
  const root = tempDir("sizes", made);
  for (const [name, patch] of Object.entries(entries)) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "case.json"), JSON.stringify({ name }));
    writeFileSync(join(root, name, "diff.patch"), patch);
  }
  return root;
}

async function sizes(cases: string, ...extra: string[]) {
  const client = createFakeSdkClient(() => {
    throw new Error("eval-sizes makes no model call");
  });
  const code = await exitCodeOf(
    createProgram({ client }).parseAsync([
      "node",
      "pr-review",
      "eval-sizes",
      "--cases",
      cases,
      ...extra,
    ]),
  );
  return { code, client };
}

const reportOf = (): SizesReport => JSON.parse(output.stdout) as SizesReport;

describe("pr-review eval-sizes: the changed lines of a case", () => {
  it("counts the added and removed lines in the hunks, and not the headers", async () => {
    const cases = casesDir({ one: CODE });
    const { code, client } = await sizes(cases, "--format", "json");
    expect(code, output.stderr).toBe(0);
    expect(client.calls).toEqual([]);
    expect(reportOf().cases).toEqual([
      expect.objectContaining({ name: "one", changed_lines: 3, excluded_lines: 0 }),
    ]);
  });

  it("gives the lines of the excluded files as a second figure", async () => {
    const cases = casesDir({ mixed: CODE + LOCK + RENAME_EDIT + RENAME_ONLY });
    const { code } = await sizes(cases, "--format", "json");
    expect(code, output.stderr).toBe(0);
    const [entry] = reportOf().cases;
    expect(entry).toMatchObject({ name: "mixed", changed_lines: 5, excluded_lines: 2 });
    expect(entry?.excluded_files).toEqual(["package-lock.json", "src/moved.ts"]);
  });

  it("prints a table by default, with each case, its group and both figures", async () => {
    const cases = casesDir({ big: CODE + RENAME_EDIT, small: LOCK + RENAME_EDIT });
    const { code } = await sizes(cases);
    expect(code, output.stderr).toBe(0);
    expect(output.stdout).toMatch(/small\s+2\s+2\s+small/);
    expect(output.stdout).toMatch(/big\s+5\s+0\s+medium/);
    expect(output.stdout).toMatch(/large\s+0 cases\s+none/);
  });

  it("exits 2 when a case has no diff.patch", async () => {
    const cases = casesDir({ one: CODE });
    mkdirSync(join(cases, "two"));
    writeFileSync(join(cases, "two", "case.json"), "{}");
    const { code } = await sizes(cases);
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/two.*diff\.patch/);
  });
});

// The cases with "n" lines each, named so that the name order is the index order.
const named = (counts: number[]) =>
  counts.map((n, i) => ({
    name: `c${String(i).padStart(2, "0")}`,
    changed_lines: n,
    excluded_lines: 0,
    excluded_files: [],
  }));

const groupSizes = (report: SizesReport) => report.groups.map((g) => g.cases.length);

describe("the size groups", () => {
  it("splits 28 cases into 10, 9 and 9, the larger group first", () => {
    const report = sizeGroups(named(Array.from({ length: 28 }, (_, i) => 100 - i)));
    expect(report.groups.map((g) => g.group)).toEqual(["small", "medium", "large"]);
    expect(groupSizes(report)).toEqual([10, 9, 9]);
    // The smallest counts are 73 to 82, and the largest are 92 to 100.
    expect(report.groups[0]?.range).toEqual({ min: 73, max: 82 });
    expect(report.groups[2]?.range).toEqual({ min: 92, max: 100 });
  });

  it("splits 9 cases into three groups of 3", () => {
    const report = sizeGroups(named([9, 8, 7, 6, 5, 4, 3, 2, 1]));
    expect(groupSizes(report)).toEqual([3, 3, 3]);
    expect(report.groups.map((g) => g.range)).toEqual([
      { min: 1, max: 3 },
      { min: 4, max: 6 },
      { min: 7, max: 9 },
    ]);
  });

  it("gives 2 cases a small and a medium group, and an empty large group with no range", () => {
    const report = sizeGroups(named([50, 10]));
    expect(groupSizes(report)).toEqual([1, 1, 0]);
    expect(report.groups[0]?.cases).toEqual(["c01"]);
    expect(report.groups[2]).toEqual({ group: "large", cases: [], range: null });
    expect(report.cases.map((c) => [c.name, c.group])).toEqual([
      ["c01", "small"],
      ["c00", "medium"],
    ]);
  });

  it("orders cases with the same count by name", () => {
    const report = sizeGroups([
      { name: "zeta", changed_lines: 5, excluded_lines: 0, excluded_files: [] },
      { name: "alpha", changed_lines: 5, excluded_lines: 0, excluded_files: [] },
      { name: "mid", changed_lines: 5, excluded_lines: 0, excluded_files: [] },
    ]);
    expect(report.cases.map((c) => [c.name, c.group])).toEqual([
      ["alpha", "small"],
      ["mid", "medium"],
      ["zeta", "large"],
    ]);
  });
});
