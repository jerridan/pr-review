// The committed baseline must describe the committed case set. A pin move
// without a new baseline, or a baseline from a single repeat, fails here.
// The baseline goes through readBaseline, the strict reader of the gate, so a
// file that the gate refuses also fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readBaseline } from "../src/eval/baseline.js";

const pinPath = fileURLToPath(new URL("../eval/cases.json", import.meta.url));
const baselinePath = fileURLToPath(new URL("../eval/baseline.json", import.meta.url));

function pinnedRef(): string {
  const pin = JSON.parse(readFileSync(pinPath, "utf8")) as { ref?: unknown };
  if (typeof pin.ref !== "string" || !/^[0-9a-f]{40}$/.test(pin.ref)) {
    throw new Error(`eval/cases.json has no full commit sha in "ref": ${String(pin.ref)}`);
  }
  return pin.ref;
}

describe("the committed eval baseline", () => {
  it("was written against the pinned cases ref", async () => {
    const baseline = await readBaseline(baselinePath);
    expect(baseline.cases_ref).toBe(pinnedRef());
  });

  it("was written at two repeats or more", async () => {
    const baseline = await readBaseline(baselinePath);
    expect(baseline.repeat).toBeGreaterThanOrEqual(2);
  });
});
