import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_EFFORT, CODEX_MODEL, runCodexJudge } from "../src/eval/label/codex.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// One step of the fake codex: the answer of one call.
type Step = {
  accept?: boolean;
  section?: string;
  reason?: string;
  stderr?: string;
  exit?: number;
  missing?: boolean;
  raw?: string;
  readStdin?: boolean;
};

// The fake codex: a shell shim first on PATH that runs a node script. The
// script logs its argv, takes the next step of the plan for the marker in
// the prompt, and writes the out file of that step.
const SHIM_SCRIPT = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
const schema = argv[argv.indexOf("--output-schema") + 1];
const out = argv[argv.indexOf("-o") + 1];
appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ argv, schemaExists: existsSync(schema) }) + "\\n");
const prompt = argv.at(-1) ?? "";
const marker = (prompt.match(/MARK-[A-Za-z0-9]+/) ?? ["default"])[0];
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const statePath = join(dir, "state-" + marker);
const n = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
writeFileSync(statePath, String(n + 1));
const list = plan[marker] ?? plan.default ?? [{ accept: true }];
const step = list[Math.min(n, list.length - 1)];
if (step.readStdin) readFileSync(0);
if (step.stderr) process.stderr.write(step.stderr);
if (step.exit) process.exit(step.exit);
if (step.missing) process.exit(0);
if (step.raw !== undefined) writeFileSync(out, step.raw);
else writeFileSync(out, JSON.stringify({ accept: step.accept ?? true, policy_section: step.section ?? "Labels", reason: step.reason ?? "ok" }));
`;

type LogLine = { argv: string[]; schemaExists: boolean };

let dir = "";
let checkout = "";

function plan(steps: Record<string, Step[]>): void {
  writeFileSync(join(dir, "plan.json"), JSON.stringify(steps));
}

function log(): LogLine[] {
  const path = join(dir, "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogLine);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-review-label-codex-test-"));
  checkout = mkdtempSync(join(tmpdir(), "pr-review-label-checkout-"));
  writeFileSync(join(dir, "shim.mjs"), SHIM_SCRIPT);
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

describe("the codex runner", () => {
  it("runs codex from PATH with the exact argv, the prompt last", async () => {
    plan({ default: [{ accept: true, section: "Tests", reason: "fits" }] });
    const outcome = await runCodexJudge("PROMPT MARK-one", checkout);
    expect(outcome).toMatchObject({
      ok: true,
      output: { accept: true, policy_section: "Tests", reason: "fits" },
    });
    const [only] = log();
    if (!only) throw new Error("codex did not run");
    const schemaFile = only.argv[13] ?? "";
    const outFile = only.argv[15] ?? "";
    expect(only.argv).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-C",
      checkout,
      "-s",
      "read-only",
      "-m",
      "gpt-6.1-sol",
      "-c",
      "model_reasoning_effort=high",
      "--output-schema",
      schemaFile,
      "-o",
      outFile,
      "PROMPT MARK-one",
    ]);
    expect(dirname(schemaFile)).toBe(dirname(outFile));
    expect(only.schemaExists).toBe(true);
  });

  it("exports the model id and the effort that the argv uses", () => {
    expect(CODEX_MODEL).toBe("gpt-6.1-sol");
    expect(CODEX_EFFORT).toBe("high");
  });

  it("removes its temp directory after the call", async () => {
    plan({ default: [{ accept: false, reason: "no" }] });
    await runCodexJudge("PROMPT", checkout);
    const [only] = log();
    const schemaFile = only?.argv[13] ?? "";
    expect(schemaFile).not.toBe("");
    expect(existsSync(dirname(schemaFile))).toBe(false);
  });

  it("removes its temp directory also after a failed call", async () => {
    plan({ default: [{ exit: 1 }] });
    await runCodexJudge("PROMPT", checkout);
    const schemaFile = log()[0]?.argv[13] ?? "";
    expect(schemaFile).not.toBe("");
    expect(existsSync(dirname(schemaFile))).toBe(false);
  });

  it("returns a failed call, and does not throw, when codex exits non-zero", async () => {
    plan({ default: [{ exit: 3, stderr: "boom" }] });
    const outcome = await runCodexJudge("PROMPT", checkout);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain("boom");
  });

  it("closes the stdin of codex, so a codex that reads stdin to its end does not wait", async () => {
    plan({ default: [{ readStdin: true, accept: true }] });
    const outcome = await runCodexJudge("PROMPT", checkout);
    expect(outcome.ok).toBe(true);
  }, 10_000);

  it("returns a failed call when codex writes no out file", async () => {
    plan({ default: [{ missing: true }] });
    expect((await runCodexJudge("PROMPT", checkout)).ok).toBe(false);
  });

  it("returns a failed call when the out file fails the judge schema", async () => {
    plan({ default: [{ raw: JSON.stringify({ accept: "maybe", reason: "r" }) }] });
    expect((await runCodexJudge("PROMPT", checkout)).ok).toBe(false);
  });

  it("returns a failed call when the out file is not JSON", async () => {
    plan({ default: [{ raw: "not json" }] });
    expect((await runCodexJudge("PROMPT", checkout)).ok).toBe(false);
  });

  it("cuts the recorded stderr to its last 2000 characters, so the error at the end survives", async () => {
    plan({ default: [{ exit: 1, stderr: "e".repeat(5000) + "\nERROR: usage limit" }] });
    const outcome = await runCodexJudge("PROMPT", checkout);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr.length).toBeLessThanOrEqual(2000);
    expect(outcome.stderr).toContain("ERROR: usage limit");
  });
});

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("the GPT path stays apart", () => {
  it("has no import of the codex runner outside src/eval/label/ and its tests", () => {
    const outside = [...listFiles(join(ROOT, "src")), ...listFiles(join(ROOT, "test"))]
      .map((file) => relative(ROOT, file))
      .filter((file) => !file.startsWith("src/eval/label/") && !/^test\/label-/.test(file))
      .filter((file) => /label\/codex(\.js)?["']/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(outside).toEqual([]);
  });

  it("names no .codex path in src", () => {
    const found = listFiles(join(ROOT, "src"))
      .filter((file) => /\.codex\b|auth\.json/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(found).toEqual([]);
  });
});
