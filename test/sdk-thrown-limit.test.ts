// A query that throws after it reached its dollar or turn limit.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSdkClient, type QueryFn, type QueryRequest } from "../src/sdk/client.js";

const request: QueryRequest = {
  role: "verifier",
  systemPrompt: "s",
  userMessage: "u",
  schema: z.object({}),
  cwd: process.cwd(),
};
const options = { allowApiKey: false, env: {} };

const resultMessage = (subtype: string, cost: number): SDKMessage =>
  ({
    type: "result",
    subtype,
    duration_ms: 5,
    stop_reason: null,
    total_cost_usd: cost,
    modelUsage: {},
  }) as unknown as SDKMessage;

// A query function that yields the messages and then throws the text.
const throwing =
  (messages: SDKMessage[], text: string): QueryFn =>
  () =>
    (async function* () {
      yield* messages;
      throw new Error(text);
    })();

describe("a query that throws after a limit stop", () => {
  it.each(["error_max_budget_usd", "error_max_turns"])(
    "gives kind limit and the cost of the result for %s, with any error text",
    async (subtype) => {
      const client = createSdkClient(throwing([resultMessage(subtype, 0.93)], "some other text"));
      const outcome = await client.query(request, options);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure.kind).toBe("limit");
      expect(outcome.failure.message).toContain(subtype);
      expect(outcome.raw?.costUsd).toBe(0.93);
    },
  );

  it("keeps kind thrown when the last result is not a limit stop", async () => {
    const client = createSdkClient(
      throwing([resultMessage("error_during_execution", 0.1)], "boom"),
    );
    const outcome = await client.query(request, options);
    expect(outcome.ok === false && outcome.failure.kind).toBe("thrown");
  });

  it.each([
    "Claude Code returned an error result: Reached maximum budget ($0.5)",
    "Claude Code returned an error result: Reached maximum number of turns (30)",
  ])("falls back to the error text when no result came: %s", async (text) => {
    const client = createSdkClient(throwing([], text));
    const outcome = await client.query(request, options);
    expect(outcome.ok === false && outcome.failure.kind).toBe("limit");
    expect(outcome.ok === false && outcome.raw).toBeNull();
  });

  it("keeps kind thrown for another error with no result", async () => {
    const client = createSdkClient(throwing([], "spawn failed"));
    const outcome = await client.query(request, options);
    expect(outcome.ok === false && outcome.failure.kind).toBe("thrown");
  });
});
