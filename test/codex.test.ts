import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { codexQuotaError, runCodex, TERRA_MODEL } from "../src/eval/codex.js";

const Schema = z.object({ ok: z.boolean() });

// The fake codex: a shell shim that logs its argv, prints the stderr text
// from the file "stderr.txt", and writes the answer to the out file.
const SHIM = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
appendFileSync(join(dir, "log.jsonl"), JSON.stringify(argv) + "\\n");
const err = join(dir, "stderr.txt");
if (existsSync(err)) process.stderr.write(readFileSync(err, "utf8"));
if (existsSync(join(dir, "fail"))) process.exit(1);
writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify({ ok: true }));
`;

let dir = "";
let checkout = "";

function argvOf(): string[] {
  const line = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n")[0] ?? "[]";
  return JSON.parse(line) as string[];
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-review-codex-test-"));
  checkout = mkdtempSync(join(tmpdir(), "pr-review-codex-checkout-"));
  writeFileSync(join(dir, "shim.mjs"), SHIM);
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec node '${join(dir, "shim.mjs")}' "$@"\n`, {
    mode: 0o755,
  });
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_CODEX_DIR", dir);
  expect(execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim()).toBe(
    join(dir, "codex"),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(checkout, { recursive: true, force: true });
});

describe("the model and the effort of a codex call", () => {
  it("uses gpt-6.1-sol with high effort when no options are given", async () => {
    await runCodex("P", checkout, Schema, "test");
    const argv = argvOf();
    expect(valueAfter(argv, "-m")).toBe("gpt-6.1-sol");
    expect(argv).toContain("model_reasoning_effort=high");
  });

  it("uses the model and the effort of the options", async () => {
    await runCodex("P", checkout, Schema, "test", { model: TERRA_MODEL, effort: "medium" });
    const argv = argvOf();
    expect(valueAfter(argv, "-m")).toBe("gpt-6.1-terra");
    expect(argv).toContain("model_reasoning_effort=medium");
    expect(argv).not.toContain("model_reasoning_effort=high");
  });

  it("falls back to the default for a field that the options omit", async () => {
    await runCodex("P", checkout, Schema, "test", { effort: "xhigh" });
    const argv = argvOf();
    expect(valueAfter(argv, "-m")).toBe("gpt-6.1-sol");
    expect(argv).toContain("model_reasoning_effort=xhigh");
  });
});

describe("the token count of a codex call", () => {
  it("reads the count that codex prints after 'tokens used'", async () => {
    writeFileSync(join(dir, "stderr.txt"), "codex\n{}\ntokens used\n21,755\n");
    const outcome = await runCodex("P", checkout, Schema, "test");
    expect(outcome.ok).toBe(true);
    expect(outcome.tokens).toBe(21755);
  });

  it("reads the count also from a failed call", async () => {
    writeFileSync(join(dir, "stderr.txt"), "tokens used\n7,571\n");
    writeFileSync(join(dir, "fail"), "");
    const outcome = await runCodex("P", checkout, Schema, "test");
    expect(outcome.ok).toBe(false);
    expect(outcome.tokens).toBe(7571);
  });

  it("gives null when stderr holds no count", async () => {
    writeFileSync(join(dir, "stderr.txt"), "codex\n{}\n");
    const outcome = await runCodex("P", checkout, Schema, "test");
    expect(outcome.tokens).toBeNull();
  });

  it("gives null on a failed call with no count", async () => {
    writeFileSync(join(dir, "fail"), "");
    const outcome = await runCodex("P", checkout, Schema, "test");
    expect(outcome.ok).toBe(false);
    expect(outcome.tokens).toBeNull();
  });
});

describe("the quota stop of codex", () => {
  it("is true for the usage limit error, with a straight or a curly apostrophe", () => {
    expect(codexQuotaError("ERROR: You've hit your usage limit. Try again at 4:33 PM.")).toBe(true);
    expect(codexQuotaError("ERROR: You’ve hit your usage limit. Upgrade to Pro")).toBe(true);
    expect(codexQuotaError("ERROR: You have hit your usage limit.")).toBe(true);
  });

  it("is false for another error and for empty stderr", () => {
    expect(codexQuotaError("ERROR: the model is not available")).toBe(false);
    expect(codexQuotaError("")).toBe(false);
  });
});
