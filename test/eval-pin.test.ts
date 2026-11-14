// The committed baseline must describe the committed case set. A pin move
// without a new baseline, or a baseline from a single repeat, fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readJson(relative: string): Record<string, unknown> {
  const url = new URL(`../${relative}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as Record<string, unknown>;
}

const pin = readJson("eval/cases.json");
const baseline = readJson("eval/baseline.json");

describe("the committed eval baseline", () => {
  it("was written against the pinned cases ref", () => {
    expect(baseline.cases_ref).toBe(pin.ref);
  });

  it("was written at two repeats or more", () => {
    expect(baseline.repeat).toBeGreaterThanOrEqual(2);
  });
});
