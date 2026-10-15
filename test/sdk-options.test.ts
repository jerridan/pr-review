import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { SmokeOutputSchema } from "../src/cli.js";
import { MODEL_IDS, ROLE_DEFAULTS, resolveModel, type Role } from "../src/config/models.js";
import { FindingsOutputSchema } from "../src/schemas/finding.js";
import { toSdkJsonSchema } from "../src/schemas/json-schema.js";
import { MergeOutputSchema } from "../src/schemas/merge.js";
import { TriageBriefSchema } from "../src/schemas/triage.js";
import { VerifierResultSchema } from "../src/schemas/verifier.js";
import {
  classifyResult,
  createSdkClient,
  usageTokens,
  type QueryFn,
  type QueryOutcome,
  type QueryRequest,
} from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import { buildQueryOptions, type RunOptions } from "../src/sdk/options.js";
import { createSemaphore } from "../src/semaphore.js";

// The pinned values from the spec. The test holds its own copy so that a
// change to the config module fails here.
const EXPECTED: Record<
  Role,
  {
    model: string;
    effort: string;
    maxTurns: number;
    maxBudgetUsd: number;
    timeoutMs: number;
    tools: "read-only" | "none";
    schema: z.ZodType;
  }
> = {
  triage: {
    model: "claude-sonnet-5-5",
    effort: "medium",
    maxTurns: 5,
    maxBudgetUsd: 0.5,
    timeoutMs: 120_000,
    tools: "none",
    schema: TriageBriefSchema,
  },
  reviewer: {
    model: "claude-opus-5-5",
    effort: "low",
    maxTurns: 40,
    maxBudgetUsd: 2,
    timeoutMs: 600_000,
    tools: "read-only",
    schema: FindingsOutputSchema,
  },
  verifier: {
    model: "claude-sonnet-5-5",
    effort: "high",
    maxTurns: 25,
    maxBudgetUsd: 0.5,
    timeoutMs: 300_000,
    tools: "read-only",
    schema: VerifierResultSchema,
  },
  "verifier-escalation": {
    model: "claude-opus-5-5",
    effort: "high",
    maxTurns: 25,
    maxBudgetUsd: 1,
    timeoutMs: 300_000,
    tools: "read-only",
    schema: VerifierResultSchema,
  },
  merge: {
    model: "claude-sonnet-5-5",
    effort: "medium",
    maxTurns: 5,
    maxBudgetUsd: 0.25,
    timeoutMs: 120_000,
    tools: "none",
    schema: MergeOutputSchema,
  },
  smoke: {
    model: "claude-sonnet-5-5",
    effort: "low",
    maxTurns: 2,
    maxBudgetUsd: 0.05,
    timeoutMs: 60_000,
    tools: "none",
    schema: SmokeOutputSchema,
  },
};

const WRITE_AND_NET_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
];
const READ_TOOLS = ["Read", "Grep", "Glob"];
// Each rule approves its tool only for paths in the head checkout (the cwd).
const SCOPED_READ_RULES = ["Read(./**)", "Grep(./**)", "Glob(./**)"];
// Variables that send the subprocess to a credential or an endpoint that
// is not the subscription login.
const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
const HEAD_WORKTREE = "/tmp/pr-review-head-abc1234";

function request(role: Role, extra: Partial<QueryRequest> = {}): QueryRequest {
  return {
    role,
    systemPrompt: `system prompt for ${role}`,
    userMessage: "user message",
    schema: EXPECTED[role].schema,
    cwd: HEAD_WORKTREE,
    ...extra,
  };
}

function runOptions(allowApiKey: boolean): RunOptions {
  return {
    allowApiKey,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-test-not-real",
      ANTHROPIC_AUTH_TOKEN: "auth-test-not-real",
      ANTHROPIC_BASE_URL: "https://proxy.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-not-real",
    },
  };
}

// A rule with no "(specifier)" matches every use of the tool, so it
// approves a read of any path on the machine.
function bareRules(rules: string[]): string[] {
  return rules.filter((rule) => !/^[A-Za-z]+\(.+\)$/.test(rule));
}

describe("A13: query options for every role", () => {
  for (const role of Object.keys(EXPECTED) as Role[]) {
    it(role, () => {
      const want = EXPECTED[role];
      const opts = buildQueryOptions(request(role), runOptions(false));

      expect(opts.settingSources).toEqual([]);
      expect(opts.permissionMode).toBe("dontAsk");
      expect(opts.persistSession).toBe(false);
      expect(opts).not.toHaveProperty("fallbackModel");
      expect(opts).not.toHaveProperty("thinking");
      expect(opts).not.toHaveProperty("maxThinkingTokens");
      // The client adds the abort controller, so this function stays pure.
      expect(opts).not.toHaveProperty("abortController");
      expect(opts).not.toHaveProperty("timeoutMs");
      expect(opts.model).toBe(want.model);
      expect(opts.effort).toBe(want.effort);
      expect(opts.maxTurns).toBe(want.maxTurns);
      expect(opts.maxBudgetUsd).toBe(want.maxBudgetUsd);
      expect(opts.cwd).toBe(HEAD_WORKTREE);
      expect(opts.systemPrompt).toBe(`system prompt for ${role}`);
      expect(opts.outputFormat).toEqual({
        type: "json_schema",
        schema: toSdkJsonSchema(want.schema),
      });

      const disallowed = opts.disallowedTools as string[];
      expect(disallowed).toEqual(expect.arrayContaining(WRITE_AND_NET_TOOLS));
      if (want.tools === "read-only") {
        expect(opts.tools).toEqual(READ_TOOLS);
        expect(opts.allowedTools).toEqual(SCOPED_READ_RULES);
        for (const tool of READ_TOOLS) expect(disallowed).not.toContain(tool);
      } else {
        expect(opts.tools).toEqual([]);
        expect(opts.allowedTools).toEqual([]);
        expect(disallowed).toEqual(expect.arrayContaining(READ_TOOLS));
      }
      expect(bareRules(opts.allowedTools as string[])).toEqual([]);

      const env = opts.env as Record<string, string | undefined>;
      for (const name of PROVIDER_VARS) expect(env).not.toHaveProperty(name);
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test-not-real");
      expect(env.PATH).toBe("/usr/bin:/bin");
    });
  }

  it("matches the config module", () => {
    for (const role of Object.keys(EXPECTED) as Role[]) {
      const { schema: _schema, ...want } = EXPECTED[role];
      const got = ROLE_DEFAULTS[role];
      expect({ ...got, model: resolveModel(got.model) }).toEqual(want);
    }
  });

  it("rejects a read rule with no path specifier", () => {
    expect(bareRules(["Read", "Grep(./**)", "Glob"])).toEqual(["Read", "Glob"]);
    expect(bareRules(["Read()", "Read(./**)"])).toEqual(["Read()"]);
    for (const role of Object.keys(EXPECTED) as Role[]) {
      const opts = buildQueryOptions(request(role), runOptions(false));
      expect(bareRules(opts.allowedTools as string[]), role).toEqual([]);
    }
  });

  it("keeps ANTHROPIC_API_KEY and the other provider variables with allowApiKey", () => {
    const opts = buildQueryOptions(request("reviewer"), runOptions(true));
    const env = opts.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-not-real");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("auth-test-not-real");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.invalid");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe("1");
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("removes GH_TOKEN and GITHUB_TOKEN from the SDK env, with or without allowApiKey", () => {
    for (const allowApiKey of [true, false]) {
      const options = runOptions(allowApiKey);
      options.env.GH_TOKEN = "x";
      options.env.GITHUB_TOKEN = "x";
      options.env.UNRELATED_VAR = "keep";
      const env = buildQueryOptions(request("reviewer"), options).env as Record<
        string,
        string | undefined
      >;
      expect(env, String(allowApiKey)).not.toHaveProperty("GH_TOKEN");
      expect(env, String(allowApiKey)).not.toHaveProperty("GITHUB_TOKEN");
      expect(env.UNRELATED_VAR).toBe("keep");
      expect(env.PATH).toBe("/usr/bin:/bin");
    }
  });

  it("does not change the caller's env", () => {
    const options = runOptions(false);
    buildQueryOptions(request("reviewer"), options);
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-test-not-real");
    expect(options.env.ANTHROPIC_BASE_URL).toBe("https://proxy.invalid");
    expect(options.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
  });

  it("applies a reviewer override for model and effort", () => {
    const alias = buildQueryOptions(
      request("reviewer", { overrides: { model: "sonnet", effort: "medium" } }),
      runOptions(false),
    );
    expect(alias.model).toBe("claude-sonnet-5-5");
    expect(alias.effort).toBe("medium");
    expect(alias.maxTurns).toBe(40);

    const exact = buildQueryOptions(
      request("reviewer", { overrides: { model: "claude-opus-4-1" } }),
      runOptions(false),
    );
    expect(exact.model).toBe("claude-opus-4-1");
    expect(exact.effort).toBe("low");

    const plain = buildQueryOptions(request("reviewer"), runOptions(false));
    expect(plain.model).toBe("claude-opus-5-5");
  });
});

describe("the tools of a reviewer narrow the read-only set", () => {
  it("grants only the read-only tools that the request names", () => {
    const opts = buildQueryOptions(request("reviewer", { tools: ["Read"] }), runOptions(false));
    expect(opts.tools).toEqual(["Read"]);
    expect(opts.allowedTools).toEqual(["Read(./**)"]);
    const disallowed = opts.disallowedTools as string[];
    expect(disallowed).toEqual(expect.arrayContaining([...WRITE_AND_NET_TOOLS, "Grep", "Glob"]));
    expect(disallowed).not.toContain("Read");
  });

  it("never grants a tool outside the read-only set, and matches names case-insensitively", () => {
    const opts = buildQueryOptions(
      request("reviewer", { tools: ["Bash", "WebFetch", "grep", "Read", "Write"] }),
      runOptions(false),
    );
    expect(opts.tools).toEqual(["Read", "Grep"]);
    expect(opts.allowedTools).toEqual(["Read(./**)", "Grep(./**)"]);
    const disallowed = opts.disallowedTools as string[];
    expect(disallowed).toEqual(expect.arrayContaining([...WRITE_AND_NET_TOOLS, "Glob"]));
    expect(bareRules(opts.allowedTools as string[])).toEqual([]);
  });

  it("grants no tool for an empty list", () => {
    const opts = buildQueryOptions(request("reviewer", { tools: [] }), runOptions(false));
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(READ_TOOLS));
  });

  it("does not widen a role with no tools", () => {
    const opts = buildQueryOptions(
      request("merge", { tools: ["Read", "Grep"] }),
      runOptions(false),
    );
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
  });

  it("keeps the full read-only set when the request names no tools", () => {
    const opts = buildQueryOptions(request("reviewer"), runOptions(false));
    expect(opts.tools).toEqual(READ_TOOLS);
    expect(opts.allowedTools).toEqual(SCOPED_READ_RULES);
  });
});

describe("a query with Bash granted (R7)", () => {
  it("lists Bash in tools and allowedTools, removes it from disallowedTools, and keeps the rest", () => {
    const opts = buildQueryOptions(
      request("reviewer", { tools: ["Read", "Bash"], bash: true }),
      runOptions(false),
    );
    expect(opts.tools).toEqual(["Read", "Bash"]);
    expect(opts.allowedTools).toEqual(["Read(./**)", "Bash"]);
    const disallowed = opts.disallowedTools as string[];
    expect(disallowed).not.toContain("Bash");
    expect(disallowed).toEqual(
      expect.arrayContaining(["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent"]),
    );
    expect(disallowed).toEqual(expect.arrayContaining(["Grep", "Glob"]));
    expect(opts.permissionMode).toBe("dontAsk");
    expect(opts.settingSources).toEqual([]);
    expect(opts.persistSession).toBe(false);
  });

  it("keeps Bash out when the request does not set bash, also when its tools name Bash", () => {
    for (const bash of [undefined, false]) {
      const opts = buildQueryOptions(
        request("reviewer", { tools: ["Read", "Bash"], ...(bash === false ? { bash } : {}) }),
        runOptions(false),
      );
      expect(opts.tools).toEqual(["Read"]);
      expect(opts.allowedTools).toEqual(["Read(./**)"]);
      expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash"]));
    }
  });

  it("does not give Bash to a role with no tools", () => {
    const opts = buildQueryOptions(request("merge", { bash: true }), runOptions(false));
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash"]));
  });
});

describe("the wall-clock timeout of a query", () => {
  const VERIFIER_OUTPUT = {
    in_scope: true,
    claim_holds: true,
    introduced_by_pr: true,
    quotes: ["q"],
    rationale: "r",
    score: 90,
    severity: "blocking",
  };
  const SUCCESS = {
    type: "result",
    subtype: "success",
    duration_ms: 3,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    structured_output: VERIFIER_OUTPUT,
  } as unknown as SDKMessage;

  type Seen = { abortController?: AbortController };

  // A query that sends no message. When "honorAbort" is true it throws on
  // abort, as the SDK does; when false it never ends.
  function hangingQuery(seen: Seen[], honorAbort: boolean): QueryFn {
    return (args) => {
      seen.push(args.options as Seen);
      const signal = args.options.abortController?.signal;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<SDKMessage>>((_, reject) => {
              if (honorAbort) signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        }),
      };
    };
  }

  function quickQuery(seen: Seen[]): QueryFn {
    return (args) => {
      seen.push(args.options as Seen);
      return (async function* (): AsyncGenerator<SDKMessage> {
        await Promise.resolve();
        yield SUCCESS;
      })();
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the query and fails it with the kind timeout when the role's time ends", async () => {
    const seen: Seen[] = [];
    const client = createSdkClient(hangingQuery(seen, true));
    let settled = false;
    const outcome = client.query(request("verifier"), runOptions(false));
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ROLE_DEFAULTS.verifier.timeoutMs - 1);
    expect(settled).toBe(false);
    expect(seen[0]?.abortController).toBeInstanceOf(AbortController);
    expect(seen[0]?.abortController?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({
      ok: false,
      failure: { kind: "timeout", message: expect.stringContaining("300000") },
      raw: null,
    });
    expect(seen[0]?.abortController?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the query also when the SDK does not stop on abort", async () => {
    const client = createSdkClient(hangingQuery([], false));
    const outcome = client.query(request("triage"), runOptions(false));
    await vi.advanceTimersByTimeAsync(ROLE_DEFAULTS.triage.timeoutMs);
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: "timeout" } });
  });

  it("releases the semaphore slot of a query that times out", async () => {
    const seen: Seen[] = [];
    const hang = hangingQuery(seen, true);
    const quick = quickQuery(seen);
    let calls = 0;
    const client = createSdkClient((args) => {
      calls += 1;
      return calls === 1 ? hang(args) : quick(args);
    });
    const semaphore = createSemaphore(1);
    const first = semaphore(() => client.query(request("verifier"), runOptions(false)));
    const second = semaphore(() => client.query(request("verifier"), runOptions(false)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(ROLE_DEFAULTS.verifier.timeoutMs);
    expect(await first).toMatchObject({ ok: false, failure: { kind: "timeout" } });
    expect(await second).toMatchObject({ ok: true, output: VERIFIER_OUTPUT });
    expect(calls).toBe(2);
  });

  it("does not abort a query that ends in time, and leaves no timer", async () => {
    const seen: Seen[] = [];
    const client = createSdkClient(quickQuery(seen));
    const outcome = await client.query(request("verifier"), runOptions(false));
    expect(outcome).toMatchObject({ ok: true, output: VERIFIER_OUTPUT });
    expect(seen[0]?.abortController?.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveModel", () => {
  it("maps each alias to the pinned ID", () => {
    expect(MODEL_IDS).toEqual({
      opus: "claude-opus-5-5",
      sonnet: "claude-sonnet-5-5",
      haiku: "claude-haiku-5-5",
    });
    expect(resolveModel("opus")).toBe("claude-opus-5-5");
    expect(resolveModel("sonnet")).toBe("claude-sonnet-5-5");
    expect(resolveModel("haiku")).toBe("claude-haiku-5-5");
    expect(resolveModel("Opus")).toBe("claude-opus-5-5");
  });

  it("passes an exact ID through", () => {
    expect(resolveModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(resolveModel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1-20250805");
  });

  it("throws on an unknown alias", () => {
    expect(() => resolveModel("gpt")).toThrow(/unknown model/i);
    expect(() => resolveModel("")).toThrow(/unknown model/i);
  });
});

describe("fake SDK client", () => {
  it("records each request and returns the scripted outcome", async () => {
    const outcome: QueryOutcome<unknown> = {
      ok: true,
      output: { ok: true, word: "pong" },
      raw: {
        model: "claude-sonnet-5-5",
        durationMs: 5,
        stopReason: "end_turn",
        subtype: "success",
        usage: {},
        costUsd: 0.001,
      },
    };
    const fake = createFakeSdkClient(async () => outcome);
    const got = await fake.query<{ ok: boolean }>(request("smoke"), runOptions(false));
    expect(got).toEqual(outcome);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.role).toBe("smoke");
    expect(fake.calls[0]?.cwd).toBe(HEAD_WORKTREE);
  });

  it("builds the query options, so a bad request fails as with the real client", async () => {
    const fake = createFakeSdkClient(() => {
      throw new Error("script must not run");
    });
    await expect(
      fake.query(request("reviewer", { overrides: { model: "gpt" } }), runOptions(false)),
    ).rejects.toThrow(/unknown model/i);
  });
});

describe("classifyResult: the query failure rule", () => {
  const success = {
    subtype: "success",
    duration_ms: 900,
    stop_reason: "end_turn",
    total_cost_usd: 0.02,
    modelUsage: { "claude-sonnet-5-5": { costUSD: 0.02 } },
    structured_output: { ok: true, word: "pong" } as unknown,
  };
  const classify = (result: Partial<typeof success> & { errors?: string[] }) =>
    classifyResult({ ...success, ...result }, "claude-sonnet-5-5", SmokeOutputSchema);

  it("passes a success with valid structured output", () => {
    const outcome = classify({});
    expect(outcome).toEqual({
      ok: true,
      output: { ok: true, word: "pong" },
      raw: {
        model: "claude-sonnet-5-5",
        durationMs: 900,
        stopReason: "end_turn",
        subtype: "success",
        usage: success.modelUsage,
        costUsd: 0.02,
      },
    });
  });

  const cases: [string, Partial<typeof success> & { errors?: string[] }, string][] = [
    ["a refusal stop", { stop_reason: "refusal" }, "refusal"],
    ["a max_tokens stop", { stop_reason: "max_tokens" }, "max_tokens"],
    ["the turn limit", { subtype: "error_max_turns", errors: [] }, "limit"],
    ["the budget limit", { subtype: "error_max_budget_usd", errors: [] }, "limit"],
    ["another error subtype", { subtype: "error_during_execution", errors: ["x"] }, "subtype"],
    ["missing structured output", { structured_output: undefined }, "no-structured-output"],
    ["output that fails the schema", { structured_output: { ok: "yes" } }, "no-structured-output"],
  ];
  for (const [label, result, kind] of cases) {
    it(`fails on ${label}`, () => {
      const outcome = classify(result);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure.kind).toBe(kind);
        expect(outcome.raw?.costUsd).toBe(0.02);
      }
    });
  }

  it("gives a refusal precedence over an error subtype", () => {
    const outcome = classify({ stop_reason: "refusal", subtype: "error_during_execution" });
    expect(!outcome.ok && outcome.failure.kind).toBe("refusal");
  });
});

describe("usageTokens (R8)", () => {
  it("sums the four token counts of each model in modelUsage", () => {
    expect(
      usageTokens({
        "claude-opus-5-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
          webSearchRequests: 5,
          costUSD: 1.5,
        },
        "claude-haiku-5-5": { inputTokens: 1, outputTokens: 2 },
      }),
    ).toBe(103);
  });

  it("gives 0 for usage that is absent or not a map of counts", () => {
    expect(usageTokens(undefined)).toBe(0);
    expect(usageTokens(null)).toBe(0);
    expect(usageTokens("x")).toBe(0);
    expect(usageTokens({ m: null, n: { inputTokens: "7", outputTokens: -3 } })).toBe(0);
  });
});
