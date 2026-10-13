import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { loadPrompt } from "../src/prompts/load.js";
import type { QueryOutcome } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const okOutcome: QueryOutcome<unknown> = {
  ok: true,
  output: { ok: true, word: "pong" },
  raw: {
    model: "claude-sonnet-5-5",
    durationMs: 1200,
    stopReason: "end_turn",
    subtype: "success",
    usage: {},
    costUsd: 0.0123,
  },
};

async function parse(args: string[], client = createFakeSdkClient(() => okOutcome)) {
  return createProgram({ client }).parseAsync(["node", "pr-review", ...args]);
}

async function exitCodeOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

describe("--help", () => {
  it("works on run and lists every run option", async () => {
    expect(await exitCodeOf(parse(["run", "--help"]))).toBe(0);
    expect(stdout).toContain("Usage: pr-review run");
    for (const flag of [
      "--base",
      "--head",
      "--repo",
      "--format",
      "--out",
      "--tier",
      "--allow-api-key",
    ]) {
      expect(stdout).toContain(flag);
    }
  });

  it("works on smoke", async () => {
    expect(await exitCodeOf(parse(["smoke", "--help"]))).toBe(0);
    expect(stdout).toContain("Usage: pr-review smoke");
  });

  it("lists both commands at the top level", async () => {
    expect(await exitCodeOf(parse(["--help"]))).toBe(0);
    expect(stdout).toContain("run");
    expect(stdout).toContain("smoke");
  });
});

describe("usage errors exit 2", () => {
  it("on a missing required option", async () => {
    expect(await exitCodeOf(parse(["run", "--head", "abc"]))).toBe(2);
    expect(stderr).toContain("--base");
  });

  it("on a bad --format or --tier value", async () => {
    expect(await exitCodeOf(parse(["run", "--base", "a", "--head", "b", "--format", "xml"]))).toBe(
      2,
    );
    expect(await exitCodeOf(parse(["run", "--base", "a", "--head", "b", "--tier", "huge"]))).toBe(
      2,
    );
  });

  it("on an unknown command or option", async () => {
    expect(await exitCodeOf(parse(["nope"]))).toBe(2);
    expect(await exitCodeOf(parse(["smoke", "--nope"]))).toBe(2);
  });
});

describe("run errors", () => {
  it("exits 1 and prints an error when the repo is not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-not-a-repo-"));
    try {
      const fake = createFakeSdkClient(() => okOutcome);
      const args = ["run", "--repo", dir, "--base", "a", "--head", "b", "--out", join(dir, "out")];
      expect(await exitCodeOf(parse(args, fake))).toBe(1);
      expect(stderr).toMatch(/pr-review run:/);
      expect(fake.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("smoke", () => {
  it("makes one smoke query and prints the model, the cost and validated", async () => {
    const fake = createFakeSdkClient(() => okOutcome);
    expect(await exitCodeOf(parse(["smoke"], fake))).toBe(0);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    const prompt = loadPrompt("smoke.md");
    expect(call?.role).toBe("smoke");
    expect(call?.systemPrompt).toBe(prompt.body);
    expect(call?.userMessage).toBe(prompt.frontmatter.user_message);
    expect(call?.overrides).toBeUndefined();
    expect(stdout).toContain("model: claude-sonnet-5-5");
    expect(stdout).toContain("cost: $0.0123");
    expect(stdout).toContain("validated: yes");
  });

  it("prints validated no and exits 1 when the query fails", async () => {
    const fake = createFakeSdkClient(() => ({
      ok: false,
      failure: { kind: "refusal", message: "stop reason refusal" },
      raw: { ...okOutcome.raw, stopReason: "refusal" } as NonNullable<typeof okOutcome.raw>,
    }));
    expect(await exitCodeOf(parse(["smoke"], fake))).toBe(1);
    expect(stdout).toContain("model: claude-sonnet-5-5");
    expect(stdout).toContain("validated: no");
    expect(stdout).toContain("refusal");
  });

  it("prints an unknown cost when the SDK throws", async () => {
    const fake = createFakeSdkClient(() => ({
      ok: false,
      failure: { kind: "thrown", message: "spawn failed" },
      raw: null,
    }));
    expect(await exitCodeOf(parse(["smoke"], fake))).toBe(1);
    expect(stdout).toContain("model: claude-sonnet-5-5");
    expect(stdout).toContain("cost: unknown");
    expect(stdout).toContain("validated: no");
  });
});
