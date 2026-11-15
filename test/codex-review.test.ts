import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { codexReviewCommand } from "../src/eval/codex-review.js";
import {
  captureOutput,
  casesFrom,
  cleanup,
  makeFixture,
  makeTemplate,
  output,
  tempDir,
} from "./fixtures/eval-fixture.js";

// One step of the fake codex: the answer of one call.
type Step = {
  findings?: unknown[];
  stderr?: string;
  exit?: number;
  missing?: boolean;
};

// The fake codex: a shell shim that runs a node script. The script logs
// its argv, finds its step by the marker "MARK-x" in the prompt, and
// writes the out file of that step.
const SHIM = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
appendFileSync(join(dir, "log.jsonl"), JSON.stringify(argv) + "\\n");
const prompt = argv.at(-1) ?? "";
const marker = (prompt.match(/MARK-[a-z]+/) ?? ["default"])[0];
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const step = plan[marker] ?? plan.default ?? {};
if (step.stderr) process.stderr.write(step.stderr);
if (step.exit) process.exit(step.exit);
if (step.missing) process.exit(0);
writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify({ findings: step.findings ?? [] }));
`;

const made: string[] = [];
let cases = "";
let shimDir = "";
let out = "";

beforeAll(async () => {
  const fx = await makeFixture();
  made.push(fx.repo);
  const root = tempDir("codex-review", made);
  const template = await makeTemplate(fx, root);
  cases = casesFrom(template, join(root, "cases"), [
    { name: "case-a", golden: [] },
    { name: "case-b", golden: [] },
    { name: "case-c", golden: [] },
  ]);
  // The title holds the marker that picks the step of the fake codex.
  for (const name of ["case-a", "case-b", "case-c"]) {
    const file = join(cases, name, "case.json");
    const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    meta.title = `MARK-${name.slice(-1)} title`;
    meta.body = "The body of the change.";
    writeFileSync(file, JSON.stringify(meta));
  }
}, 60_000);

afterAll(() => cleanup(made));
captureOutput();

beforeEach(() => {
  shimDir = mkdtempSync(join(tmpdir(), "pr-review-codex-review-"));
  out = join(tempDir("codex-review-out", made), "out");
  writeFileSync(join(shimDir, "shim.mjs"), SHIM);
  writeFileSync(
    join(shimDir, "codex"),
    `#!/bin/sh\nexec node '${join(shimDir, "shim.mjs")}' "$@"\n`,
    {
      mode: 0o755,
    },
  );
  vi.stubEnv("PATH", `${shimDir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_CODEX_DIR", shimDir);
  expect(execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim()).toBe(
    join(shimDir, "codex"),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(shimDir, { recursive: true, force: true });
});

function plan(steps: Record<string, Step>): void {
  writeFileSync(join(shimDir, "plan.json"), JSON.stringify(steps));
}

function calls(): string[][] {
  const file = join(shimDir, "log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

const FINDING = {
  file: "src/stats.ts",
  start_line: 14,
  end_line: 14,
  category: "bug",
  severity_estimate: "blocking",
  confidence: "high",
  claim: "The loop reads one item past the end.",
  evidence: "for (let i = 0; i <= values.length; i++) {",
  suggested_fix: "",
  explanation: "The bound must be i < values.length.",
  needs_context: false,
};

function written(name: string): unknown {
  return JSON.parse(readFileSync(join(out, `${name}.json`), "utf8"));
}

function run(...extra: string[]): Promise<number> {
  return codexReviewCommand(["--cases", cases, "--out", out, ...extra]);
}

describe("pr-review eval-codex-review", () => {
  it("writes one candidates file per case, with the source and the findings", async () => {
    plan({ default: { findings: [FINDING] } });
    expect(await run()).toBe(0);
    const { suggested_fix: _unused, ...withoutFix } = FINDING;
    for (const name of ["case-a", "case-b", "case-c"]) {
      expect(written(name)).toEqual({
        source: "codex-general-review-gpt-6.1-terra-high",
        findings: [withoutFix],
      });
    }
    expect(readdirSync(out).sort()).toEqual(["case-a.json", "case-b.json", "case-c.json"]);
  }, 60_000);

  it("keeps a suggested fix that is not empty", async () => {
    plan({ default: { findings: [{ ...FINDING, suggested_fix: "Use i < values.length." }] } });
    expect(await run()).toBe(0);
    expect(written("case-a")).toMatchObject({
      findings: [{ suggested_fix: "Use i < values.length." }],
    });
  }, 60_000);

  it("calls codex with the terra model and high effort, and with the options when given", async () => {
    plan({ default: { findings: [] } });
    await run("--model", "gpt-x", "--effort", "medium", "--source", "my-source");
    const [first] = calls();
    expect(first?.[first.indexOf("-m") + 1]).toBe("gpt-x");
    expect(first).toContain("model_reasoning_effort=medium");
    expect(written("case-a")).toEqual({ source: "my-source", findings: [] });
    plan({ default: { findings: [] } });
    rmSync(out, { recursive: true, force: true });
    await run();
    const last = calls().at(-1);
    expect(last?.[last.indexOf("-m") + 1]).toBe("gpt-6.1-terra");
    expect(last).toContain("model_reasoning_effort=high");
  }, 60_000);

  it("gives codex the general-review prompt, the description and the diff, with no brief", async () => {
    plan({ default: { findings: [] } });
    await run();
    const prompt = calls()[0]?.at(-1) ?? "";
    expect(prompt).toContain("You review one code change in every category");
    expect(prompt).toContain("MARK-a title\n\nThe body of the change.");
    expect(prompt).toContain("average");
    expect(prompt).toContain("No triage brief is available for this change.");
  }, 60_000);

  it("skips a finished case on a rerun, and runs it again with --force", async () => {
    plan({ default: { findings: [] } });
    await run();
    expect(calls()).toHaveLength(3);
    output.stdout = "";
    expect(await run()).toBe(0);
    expect(calls()).toHaveLength(3);
    expect(output.stdout).toMatch(/skipped: 3/);
    expect(await run("--force")).toBe(0);
    expect(calls()).toHaveLength(6);
  }, 60_000);

  it("writes no file for a failed case, goes on, and exits non-zero", async () => {
    plan({ "MARK-a": { exit: 1, stderr: "boom" }, default: { findings: [] } });
    expect(await run()).toBe(1);
    expect(existsSync(join(out, "case-a.json"))).toBe(false);
    expect(existsSync(join(out, "case-b.json"))).toBe(true);
    expect(output.stderr).toContain("case-a");
    expect(output.stderr).toContain("codex exited with code 1");
    expect(output.stdout).toMatch(/done: 2/);
    expect(output.stdout).toMatch(/failed: 1/);
    // A rerun does the failed case only.
    plan({ default: { findings: [] } });
    const before = calls().length;
    expect(await run()).toBe(0);
    expect(calls()).toHaveLength(before + 1);
  }, 60_000);

  it("fails the case when a finding fails the finding schema", async () => {
    plan({ default: { findings: [{ ...FINDING, category: "style" }] } });
    expect(await run()).toBe(1);
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
  }, 60_000);

  it("stops at a quota error before the next case, and keeps the finished cases", async () => {
    plan({
      "MARK-a": { findings: [] },
      "MARK-b": { exit: 1, stderr: "ERROR: You've hit your usage limit. Try again at 4:33 PM.\n" },
      "MARK-c": { findings: [] },
    });
    expect(await run()).toBe(1);
    expect(calls()).toHaveLength(2);
    expect(readdirSync(out)).toEqual(["case-a.json"]);
    expect(output.stderr).toMatch(/quota is out/i);
    // A rerun continues with the cases that have no file.
    plan({ default: { findings: [] } });
    expect(await run()).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["case-a.json", "case-b.json", "case-c.json"]);
  }, 60_000);

  it("prints the sum of the tokens", async () => {
    plan({
      "MARK-a": { findings: [], stderr: "tokens used\n1,200\n" },
      "MARK-b": { findings: [], stderr: "tokens used\n300\n" },
      "MARK-c": { findings: [] },
    });
    await run();
    expect(output.stdout).toMatch(/tokens: 1500/);
  }, 60_000);

  it("exits 2 for a missing option or an unknown effort, and calls no codex", async () => {
    expect(await codexReviewCommand(["--cases", cases])).toBe(2);
    expect(await run("--effort", "extreme")).toBe(2);
    expect(await codexReviewCommand([])).toBe(2);
    expect(calls()).toEqual([]);
  });
});
