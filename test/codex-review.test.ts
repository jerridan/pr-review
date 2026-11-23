import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { dirname, join } from "node:path";
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
let template = "";
let shimDir = "";
let out = "";

beforeAll(async () => {
  const fx = await makeFixture();
  made.push(fx.repo);
  const root = tempDir("codex-review", made);
  template = await makeTemplate(fx, root);
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
    expect(readdirSync(out).sort()).toEqual([
      ".tokens.json",
      "case-a.json",
      "case-b.json",
      "case-c.json",
    ]);
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

  it("builds the description from the commit messages for a case with description_from commits", async () => {
    const file = join(cases, "case-a", "case.json");
    const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...meta, description_from: "commits" }));
    try {
      plan({ default: { findings: [] } });
      await run();
      // case-a runs first, and its title is not in the prompt, so no marker matches.
      const prompt = calls()[0]?.at(-1) ?? "";
      expect(prompt).toContain("Head: add average, move format helpers, bump lockfile, add CI");
      expect(prompt).not.toContain("The body of the change.");
    } finally {
      writeFileSync(file, JSON.stringify(meta));
    }
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
    expect(readdirSync(out)).toEqual([]);
  }, 60_000);

  it("stops at a quota error before the next case, and keeps the finished cases", async () => {
    plan({
      "MARK-a": { findings: [] },
      "MARK-b": { exit: 1, stderr: "ERROR: You've hit your usage limit. Try again at 4:33 PM.\n" },
      "MARK-c": { findings: [] },
    });
    expect(await run()).toBe(1);
    expect(calls()).toHaveLength(2);
    expect(readdirSync(out).sort()).toEqual([".tokens.json", "case-a.json"]);
    expect(output.stderr).toMatch(/quota is out/i);
    // A rerun continues with the cases that have no file.
    plan({ default: { findings: [] } });
    expect(await run()).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      ".tokens.json",
      "case-a.json",
      "case-b.json",
      "case-c.json",
    ]);
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

  it("prints one line per case with its tokens, before the summary", async () => {
    plan({
      "MARK-a": { findings: [], stderr: "tokens used\n1,200\n" },
      "MARK-b": { exit: 1, stderr: "boom\ntokens used\n300\n" },
      "MARK-c": { findings: [] },
    });
    await run();
    const lines = output.stdout.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "case case-a: done tokens 1200",
      "case case-b: failed tokens 300",
      "case case-c: done tokens unknown",
    ]);
    expect(lines[3]).toBe("done: 2");
  }, 60_000);

  const MODEL = { model: "gpt-6.1-terra", effort: "high", prompt: "general-review" };
  const SOURCE = "codex-general-review-gpt-6.1-terra-high";

  function tokenMap(): unknown {
    return JSON.parse(readFileSync(join(out, ".tokens.json"), "utf8"));
  }

  it("writes .tokens.json with the tokens, model and effort of each done case, and keeps old entries on a rerun", async () => {
    plan({
      "MARK-a": { findings: [], stderr: "tokens used\n1,200\n" },
      "MARK-b": { exit: 1, stderr: "boom\ntokens used\n300\n" },
      "MARK-c": { findings: [] },
    });
    await run();
    // The failed case has no entry.
    expect(tokenMap()).toEqual({
      "case-a": { tokens: 1200, ...MODEL },
      "case-c": { tokens: null, ...MODEL },
    });
    // The rerun does case-b only, and keeps the other entries.
    plan({ default: { findings: [], stderr: "tokens used\n50\n" } });
    expect(await run("--effort", "low", "--source", SOURCE)).toBe(0);
    expect(tokenMap()).toEqual({
      "case-a": { tokens: 1200, ...MODEL },
      "case-b": { tokens: 50, model: "gpt-6.1-terra", effort: "low", prompt: "general-review" },
      "case-c": { tokens: null, ...MODEL },
    });
    expect(readdirSync(out).filter((n) => n.includes(".tmp"))).toEqual([]);
  }, 60_000);

  it("keeps the earlier entry of a case that fails on a forced rerun, and prints its tokens", async () => {
    plan({ default: { findings: [], stderr: "tokens used\n1,200\n" } });
    await run();
    plan({ default: { exit: 1, stderr: "boom\ntokens used\n77\n" } });
    output.stdout = "";
    expect(await run("--force")).toBe(1);
    expect(output.stdout).toContain("case case-a: failed tokens 77");
    expect(tokenMap()).toEqual({
      "case-a": { tokens: 1200, ...MODEL },
      "case-b": { tokens: 1200, ...MODEL },
      "case-c": { tokens: 1200, ...MODEL },
    });
  }, 60_000);

  it("keeps a case named tokens apart from the tokens file", async () => {
    const root = tempDir("codex-review-tokens-case", made);
    const named = casesFrom(template, join(root, "cases"), [{ name: "tokens", golden: [] }]);
    plan({ default: { findings: [], stderr: "tokens used\n9\n" } });
    expect(await codexReviewCommand(["--cases", named, "--out", out])).toBe(0);
    expect(written("tokens")).toEqual({ source: SOURCE, findings: [] });
    expect(tokenMap()).toEqual({ tokens: { tokens: 9, ...MODEL } });
  }, 60_000);

  it("goes on with a warning when the tokens file cannot be written", async () => {
    // A directory holds the temp name of the tokens file, so its write fails.
    mkdirSync(join(out, `.tokens.json.tmp-${process.pid}`), { recursive: true });
    plan({ default: { findings: [] } });
    expect(await run()).toBe(0);
    expect(output.stderr).toContain(".tokens.json");
    expect(output.stderr).toMatch(/EISDIR|directory/i);
    expect(output.stdout).toMatch(/done: 3/);
    expect(written("case-c")).toEqual({ source: SOURCE, findings: [] });
  }, 60_000);

  it("moves a tokens file that does not parse aside, with a warning, and starts a new map", async () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, ".tokens.json"), "{not json");
    plan({ default: { findings: [] } });
    expect(await run()).toBe(0);
    expect(output.stderr).toContain(".tokens.json");
    const bad = readdirSync(out).filter((n) => n.startsWith(".tokens.json.bad-"));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^\.tokens\.json\.bad-\d+$/);
    expect(readFileSync(join(out, bad[0] ?? ""), "utf8")).toBe("{not json");
    expect(readdirSync(out).sort()).toEqual([
      ".tokens.json",
      bad[0],
      "case-a.json",
      "case-b.json",
      "case-c.json",
    ]);
    expect(tokenMap()).toEqual({
      "case-a": { tokens: null, ...MODEL },
      "case-b": { tokens: null, ...MODEL },
      "case-c": { tokens: null, ...MODEL },
    });
  }, 60_000);

  it("moves a tokens file that fails the schema aside and keeps its content", async () => {
    mkdirSync(out, { recursive: true });
    const old = JSON.stringify({ "case-z": 5 });
    writeFileSync(join(out, ".tokens.json"), old);
    plan({ "MARK-a": { findings: [] }, default: { exit: 1, stderr: "boom" } });
    expect(await run()).toBe(1);
    const bad = readdirSync(out).filter((n) => n.startsWith(".tokens.json.bad-"));
    expect(bad).toHaveLength(1);
    expect(readFileSync(join(out, bad[0] ?? ""), "utf8")).toBe(old);
    expect(readdirSync(out).sort()).toEqual([".tokens.json", bad[0], "case-a.json"]);
    expect(output.stderr).toContain(".tokens.json");
    expect(tokenMap()).toEqual({ "case-a": { tokens: null, ...MODEL } });
  }, 60_000);

  describe("--prompt", () => {
    // The prompt loader reads PR_REVIEW_PROMPTS_DIR when it loads, so load a
    // new copy of the command after the variable is set. The directory is a
    // copy of prompts/ with the test prompt added.
    async function runWithPrompt(...extra: string[]): Promise<number> {
      return runWithFiles({}, ...extra);
    }

    async function runWithFiles(
      files: Record<string, string>,
      ...extra: string[]
    ): Promise<number> {
      const prompts = join(tempDir("codex-review-prompts", made), "prompts");
      cpSync(fileURLToPath(new URL("../prompts/", import.meta.url)), prompts, { recursive: true });
      cpSync(
        fileURLToPath(new URL("./fixtures/prompts/test-reviewer.md", import.meta.url)),
        join(prompts, "test-reviewer.md"),
      );
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(prompts, name)), { recursive: true });
        writeFileSync(join(prompts, name), text);
      }
      vi.stubEnv("PR_REVIEW_PROMPTS_DIR", prompts);
      vi.resetModules();
      try {
        const fresh = await import("../src/eval/codex-review.js");
        return await fresh.codexReviewCommand(["--cases", cases, "--out", out, ...extra]);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    }

    it("gives codex the body of the named prompt in place of the general-review body", async () => {
      plan({ default: { findings: [] } });
      expect(await runWithPrompt("--prompt", "test-reviewer.md")).toBe(0);
      const prompt = calls()[0]?.at(-1) ?? "";
      expect(prompt).toContain("UNIQUE-TEST-REVIEWER-LINE");
      expect(prompt).not.toContain("You review one code change in every category");
      expect(prompt).toContain("MARK-a title\n\nThe body of the change.");
    }, 60_000);

    it("names the default source after the prompt, the model and the effort", async () => {
      plan({ default: { findings: [] } });
      await runWithPrompt("--prompt", "test-reviewer.md", "--effort", "max");
      expect(written("case-a")).toEqual({
        source: "codex-test-reviewer-gpt-6.1-terra-max",
        findings: [],
      });
    }, 60_000);

    it("keeps a --source that is given", async () => {
      plan({ default: { findings: [] } });
      await runWithPrompt("--prompt", "test-reviewer.md", "--source", "mine");
      expect(written("case-a")).toEqual({ source: "mine", findings: [] });
    }, 60_000);

    it("exits 2 for a prompt file that does not exist, and runs no case", async () => {
      expect(await run("--prompt", "no-such-prompt.md")).toBe(2);
      expect(calls()).toEqual([]);
      expect(existsSync(out)).toBe(false);
    });

    it("keeps the general-review body when no prompt is given", async () => {
      plan({ default: { findings: [] } });
      expect(await run()).toBe(0);
      const prompt = calls()[0]?.at(-1) ?? "";
      expect(prompt).toContain("You review one code change in every category");
      expect(prompt).not.toContain("UNIQUE-TEST-REVIEWER-LINE");
    }, 60_000);

    it("names the default source with the effort max when no prompt is given", async () => {
      plan({ default: { findings: [] } });
      expect(await run("--effort", "max")).toBe(0);
      expect(written("case-a")).toMatchObject({ source: "codex-general-review-gpt-6.1-terra-max" });
    }, 60_000);

    it("passes the effort max to codex", async () => {
      plan({ default: { findings: [] } });
      await run("--effort", "max");
      expect(calls()[0]).toContain("model_reasoning_effort=max");
    }, 60_000);

    it.each(["", "  \n\t\n"])(
      "exits 2 for a prompt file with an empty body %j, and runs no case",
      async (body) => {
        const code = await runWithFiles(
          { "empty.md": `---\nname: empty\n---\n${body}` },
          "--prompt",
          "empty.md",
        );
        expect(code).toBe(2);
        expect(calls()).toEqual([]);
        expect(existsSync(out)).toBe(false);
      },
    );

    it.each(["x.md", "./x.md", "dir/x.md"])(
      "names the default source after the base name of the prompt path %s",
      async (path) => {
        plan({ default: { findings: [] } });
        const text = "---\nname: x\n---\nA reviewer body.";
        const code = await runWithFiles({ [path]: text }, "--prompt", path, "--effort", "low");
        expect(code).toBe(0);
        expect(written("case-a")).toMatchObject({ source: "codex-x-gpt-6.1-terra-low" });
      },
      60_000,
    );

    it("stores the prompt value in the token entry", async () => {
      plan({ default: { findings: [] } });
      await runWithPrompt("--prompt", "test-reviewer.md");
      expect(tokenMap()).toMatchObject({ "case-a": { prompt: "test-reviewer.md" } });
    }, 60_000);
  });

  describe("resume", () => {
    it("stops with exit 2 before any call when a file holds another source", async () => {
      plan({ default: { findings: [] } });
      await run("--source", "first");
      const before = calls().length;
      output.stderr = "";
      expect(await run("--source", "second")).toBe(2);
      expect(calls()).toHaveLength(before);
      expect(output.stderr).toContain("case-a");
      expect(output.stderr).toContain("first");
      expect(output.stderr).toContain("second");
      expect(output.stderr).toContain("--force");
      expect(written("case-a")).toEqual({ source: "first", findings: [] });
    }, 60_000);

    it("skips a case whose file holds the same source", async () => {
      plan({ default: { findings: [] } });
      await run("--source", "same");
      expect(await run("--source", "same")).toBe(0);
      expect(calls()).toHaveLength(3);
    }, 60_000);

    it("runs again with --force when a file holds another source", async () => {
      plan({ default: { findings: [] } });
      await run("--source", "first");
      expect(await run("--source", "second", "--force")).toBe(0);
      expect(written("case-a")).toEqual({ source: "second", findings: [] });
    }, 60_000);
  });

  it("exits 2 for a missing option or an unknown effort, and calls no codex", async () => {
    expect(await codexReviewCommand(["--cases", cases])).toBe(2);
    expect(await run("--effort", "extreme")).toBe(2);
    expect(await codexReviewCommand([])).toBe(2);
    expect(calls()).toEqual([]);
  });
});
