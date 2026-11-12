// R4: a case with the source "pool". The eval loader loads it with its
// golden.json. The pool loader loads it also without golden.json.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseError, loadCases, loadPoolCase } from "../src/eval/case.js";
import { makeFixtureCase, type FixtureCase } from "./fixtures/pool-fakes.js";

let work = "";
let fx: FixtureCase;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pr-review-pool-case-"));
  fx = await makeFixtureCase(work, "fixture-7");
}, 60_000);

afterAll(() => {
  for (const dir of [fx?.repo, work]) if (dir) rmSync(dir, { recursive: true, force: true });
});

function casesDir(label: string, golden: boolean): string {
  const root = join(work, label);
  mkdirSync(root);
  cpSync(fx.template, join(root, "fixture-7"), { recursive: true });
  if (golden)
    writeFileSync(join(root, "fixture-7", "golden.json"), JSON.stringify({ findings: [] }));
  return root;
}

describe("a pool case", () => {
  it("loads in the eval loader with the source pool", async () => {
    const root = casesDir("with-golden", true);
    expect(JSON.parse(readFileSync(join(root, "fixture-7", "case.json"), "utf8")).source).toBe(
      "pool",
    );
    const [c] = await loadCases(root);
    expect(c?.source).toBe("pool");
    expect(c?.golden).toEqual([]);
  });

  it("loads for the pool without golden.json, while the eval loader still requires it", async () => {
    const root = casesDir("no-golden", false);
    const c = await loadPoolCase(join(root, "fixture-7"));
    expect(c).toMatchObject({ name: "fixture-7", source: "pool", title: "Add an average helper" });
    await expect(loadCases(root)).rejects.toThrow(CaseError);
    await expect(loadCases(root)).rejects.toThrow(/golden\.json is missing/);
  });

  it("fails for the pool when diff.patch is missing", async () => {
    const root = casesDir("no-diff", false);
    rmSync(join(root, "fixture-7", "diff.patch"));
    await expect(loadPoolCase(join(root, "fixture-7"))).rejects.toThrow(/diff\.patch is missing/);
  });
});
