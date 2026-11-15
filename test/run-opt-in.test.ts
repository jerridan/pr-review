import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReview } from "../src/run.js";
import type { QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import { cleanup, makeFixture, tempDir, type Fixture } from "./fixtures/eval-fixture.js";

const made: string[] = [];
let fx: Fixture;
beforeAll(async () => {
  fx = await makeFixture();
  made.push(fx.repo);
}, 60_000);
afterAll(() => cleanup(made));

const META = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

function fake() {
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    if (req.role === "triage") {
      return {
        ok: true,
        output: {
          tier: "full",
          reason: "r",
          confidence: "high",
          categories: ["bug"],
          hotspots: [],
          file_notes: [],
          summary: "s",
        },
        raw: META,
      };
    }
    if (req.role === "reviewer") return { ok: true, output: { findings: [] }, raw: META };
    throw new Error(`unexpected role ${req.role}`);
  });
}

async function reviewersOf(only?: string[]): Promise<string[]> {
  const client = fake();
  const out = tempDir("opt-in", made);
  rmSync(out, { recursive: true, force: true });
  await runReview({
    repo: fx.repo,
    base: fx.base,
    head: fx.head,
    outDir: join(out, "r"),
    format: "json",
    allowApiKey: false,
    client,
    ...(only ? { onlyReviewers: only } : {}),
  });
  return [
    ...new Set(client.calls.filter((c) => c.role === "reviewer").map((c) => c.reviewerName)),
  ].sort() as string[];
}

describe("the opt-in reviewer in a run", () => {
  it("runs general-review and no other reviewer when onlyReviewers names it", async () => {
    expect(await reviewersOf(["general-review"])).toEqual(["general-review"]);
  }, 60_000);

  it("does not run general-review in a normal run", async () => {
    expect(await reviewersOf()).not.toContain("general-review");
  }, 60_000);
});
