// D8 R5 and R6: a cases subset by the cost per run of each case.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";
import { loadCases } from "../src/eval/case.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import { captureOutput, cleanup, exitCodeOf, output, tempDir } from "./fixtures/eval-fixture.js";

const made: string[] = [];
afterAll(() => cleanup(made));
captureOutput();

// A case directory that the case loader accepts. The loader does not read
// the bundle, so a placeholder is enough.
function writeCases(names: string[]): string {
  const root = tempDir("subset-cases", made);
  for (const name of names) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "case.json"),
      JSON.stringify({
        name,
        source: "fixture",
        base: "a".repeat(40),
        head: "b".repeat(40),
        title: "t",
        body: "b",
        origin: "",
        language: "typescript",
      }),
    );
    writeFileSync(join(dir, "repo.bundle"), "placeholder");
    writeFileSync(join(dir, "diff.patch"), "");
    writeFileSync(join(dir, "golden.json"), JSON.stringify({ findings: [] }));
  }
  return root;
}

const repeat = (n: number, cost: number | null, failed = false) => ({
  repeat: n,
  failed,
  cost_usd: cost,
  judge_cost_usd: 9,
});

// The cost per run: a 2 (the mean of 1 and 3), b 5, c 1 (the failed
// repeat does not count), d 5. The judge cost does not count.
function writeReport(): string {
  const dir = tempDir("subset-report", made);
  const path = join(dir, "report.json");
  writeFileSync(
    path,
    JSON.stringify({
      cases: [
        { name: "a", repeats: [repeat(1, 1), repeat(2, 3)] },
        { name: "b", repeats: [repeat(1, 5)] },
        { name: "c", repeats: [repeat(1, 1), repeat(2, null, true)] },
        { name: "d", repeats: [repeat(1, 5), repeat(2, 5)] },
      ],
    }),
  );
  return path;
}

async function subset(...args: string[]): Promise<number> {
  const client = createFakeSdkClient(() => {
    throw new Error("the subset command makes no query");
  });
  return exitCodeOf(
    createProgram({ client }).parseAsync(["node", "pr-review", "eval-subset", ...args]),
  );
}

type SubsetFile = {
  source: string;
  limit: number | null;
  kept: string[];
  left_out: string[];
  costs: Record<string, number>;
};

const subsetFile = (dir: string): SubsetFile =>
  JSON.parse(readFileSync(join(dir, "subset.json"), "utf8")) as SubsetFile;

describe("pr-review eval-subset (D8 R5)", () => {
  it("leaves out each case whose cost per run is above --max-cost", async () => {
    const to = join(tempDir("subset-to", made), "subset");
    const code = await subset(
      "--cases",
      writeCases(["a", "b", "c", "d"]),
      "--costs",
      writeReport(),
      "--max-cost",
      "2",
      "--to",
      to,
    );
    expect(code, output.stderr).toBe(0);
    const file = subsetFile(to);
    expect(file.kept).toEqual(["a", "c"]);
    expect(file.left_out).toEqual(["b", "d"]);
    expect(file.costs).toEqual({ a: 2, b: 5, c: 1, d: 5 });
    expect((await loadCases(to)).map((c) => c.name)).toEqual(["a", "c"]);
    expect(output.stdout).toMatch(/^b\s+\$5\.0000\s+left out$/m);
    expect(output.stdout).toMatch(/^a\s+\$2\.0000\s+kept$/m);
  });

  it("leaves out the most expensive cases until the repeats fit the budget, and states the limit", async () => {
    const to = join(tempDir("subset-to", made), "subset");
    // All four: 2 x 13 = 26. Without d (the later of the two at 5): 2 x 8 = 16.
    const code = await subset(
      "--cases",
      writeCases(["a", "b", "c", "d"]),
      "--costs",
      writeReport(),
      "--budget",
      "16",
      "--repeats",
      "2",
      "--to",
      to,
    );
    expect(code, output.stderr).toBe(0);
    const file = subsetFile(to);
    expect(file.kept).toEqual(["a", "b", "c"]);
    expect(file.left_out).toEqual(["d"]);
    expect(file.limit).toBe(5);
    expect(output.stdout).toMatch(/limit: \$5\.0000/);
    expect((await loadCases(to)).map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("names a case that has no cost in the source", async () => {
    const to = join(tempDir("subset-to", made), "subset");
    const code = await subset(
      "--cases",
      writeCases(["a", "b", "c", "d", "e"]),
      "--costs",
      writeReport(),
      "--max-cost",
      "2",
      "--to",
      to,
    );
    expect(code).toBe(2);
    expect(output.stderr).toMatch(/case e has no cost/);
  });

  it("exits 2 when no mode or both modes are given", async () => {
    const cases = writeCases(["a"]);
    const report = writeReport();
    const base = ["--cases", cases, "--costs", report];
    const to = () => join(tempDir("subset-to", made), "subset");
    expect(await subset(...base, "--to", to())).toBe(2);
    expect(
      await subset(...base, "--max-cost", "2", "--budget", "4", "--repeats", "2", "--to", to()),
    ).toBe(2);
    expect(await subset(...base, "--budget", "4", "--to", to())).toBe(2);
  });

  it("reads the costs of an --out directory from its result files", async () => {
    const out = tempDir("subset-out", made);
    const result = (name: string, n: number, cost: number) => {
      mkdirSync(join(out, name, String(n)), { recursive: true });
      writeFileSync(
        join(out, name, String(n), "result.json"),
        JSON.stringify({
          case: name,
          repeat: n,
          metrics: { repeat: n, failed: false, cost_usd: cost },
        }),
      );
    };
    result("a", 1, 1);
    result("a", 2, 3);
    result("b", 1, 7);
    const to = join(tempDir("subset-to", made), "subset");
    const code = await subset(
      "--cases",
      writeCases(["a", "b"]),
      "--costs",
      out,
      "--max-cost",
      "4",
      "--to",
      to,
    );
    expect(code, output.stderr).toBe(0);
    expect(subsetFile(to)).toMatchObject({ kept: ["a"], left_out: ["b"], costs: { a: 2, b: 7 } });
  });

  it("reads the costs of a baseline file (D8 R6)", async () => {
    const dir = tempDir("subset-baseline", made);
    const path = join(dir, "baseline.json");
    writeFileSync(
      path,
      JSON.stringify({
        recall: 0.5,
        precision: 0.5,
        margin: { recall: 0.05, precision: 0.05 },
        cases_ref: null,
        repeat: 2,
        written_at: "2026-11-14T00:00:00.000Z",
        tool_version: "0.1.0",
        case_costs: { a: 3, b: 1 },
      }),
    );
    const to = join(tempDir("subset-to", made), "subset");
    const code = await subset(
      "--cases",
      writeCases(["a", "b"]),
      "--costs",
      path,
      "--max-cost",
      "2",
      "--to",
      to,
    );
    expect(code, output.stderr).toBe(0);
    expect(subsetFile(to)).toMatchObject({ kept: ["b"], left_out: ["a"] });
  });
});
