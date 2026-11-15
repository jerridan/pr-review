// The command line gives the D4c arm commands their own arguments, and
// passes their exit codes through.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommanderError } from "commander";
import { createProgram } from "../src/cli.js";

let stderr = "";

beforeEach(() => {
  stderr = "";
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

async function exitCodeOf(args: string[]): Promise<number> {
  try {
    await createProgram({}).parseAsync(["node", "pr-review", ...args]);
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

describe("the D4c arm commands", () => {
  it.each([
    ["eval-codex-review", "usage: pr-review eval-codex-review"],
    ["eval-injection-variants", "usage: pr-review eval-injection-variants"],
    ["eval-injection-report", "usage: pr-review eval-injection-report"],
  ])("%s gives its own usage and exit code 2 with no options", async (name, usage) => {
    expect(await exitCodeOf([name])).toBe(2);
    expect(stderr).toContain(usage);
  });

  it("passes an unknown option to the command, which rejects it", async () => {
    expect(await exitCodeOf(["eval-injection-variants", "--bogus"])).toBe(2);
    expect(stderr).toContain("--bogus");
    expect(stderr).toContain("usage: pr-review eval-injection-variants");
  });
});
