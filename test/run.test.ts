import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { createProgram } from "../src/cli.js";
import type * as PromptLoad from "../src/prompts/load.js";
import type * as ReviewerLoader from "../src/reviewers/loader.js";
import type { ReviewerDefinition } from "../src/reviewers/loader.js";
import { describeSelected, runReview } from "../src/run.js";
import type { Finding } from "../src/schemas/finding.js";
import type { RunRecord } from "../src/schemas/record.js";
import type { TriageBrief } from "../src/schemas/triage.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

// Test switches for the module mocks below. They are off unless a test
// sets them.
const mocks = vi.hoisted(() => ({
  failVerifierPrompt: false,
  reviewerPasses: undefined as number | undefined,
}));

vi.mock("../src/prompts/load.js", async (importOriginal) => {
  const original = await importOriginal<typeof PromptLoad>();
  return {
    ...original,
    loadPrompt: (relativePath: string) => {
      if (mocks.failVerifierPrompt && relativePath === "verifier.md") {
        throw new Error("PROMPT-LOAD-FAILED");
      }
      return original.loadPrompt(relativePath);
    },
  };
});

vi.mock("../src/reviewers/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof ReviewerLoader>();
  return {
    ...original,
    loadBuiltinReviewers: () =>
      original
        .loadBuiltinReviewers()
        .map((def) =>
          mocks.reviewerPasses === undefined
            ? def
            : { ...def, frontmatter: { ...def.frontmatter, passes: mocks.reviewerPasses } },
        ),
  };
});

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

type Fixture = { repo: string; base: string; head: string; file: string; line: number };

async function makeFixture(...options: string[]): Promise<Fixture> {
  const { stdout } = await run("bash", [SCRIPT, ...options]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  const [file, line] = value("PLANTED").split(":");
  return {
    repo: value("FIXTURE"),
    base: value("BASE"),
    head: value("HEAD"),
    file: file ?? "",
    line: Number(line),
  };
}

const META: QueryMeta = {
  model: "m",
  durationMs: 7,
  stopReason: "end_turn",
  subtype: "success",
  usage: { m: { costUSD: 0.01 } },
  costUsd: 0.01,
};

const BRIEF: TriageBrief = {
  tier: "full",
  reason: "New logic.",
  confidence: "high",
  categories: ["bug"],
  hotspots: ["src/stats.ts"],
  file_notes: [],
  summary: "Adds average.",
};

function plantedFinding(fx: Fixture): Finding {
  return {
    file: fx.file,
    start_line: fx.line,
    end_line: fx.line,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: "The loop reads one item past the end.",
    evidence: "for (let i = 0; i <= values.length; i++) {",
    explanation: "The bound must be i < values.length.",
    needs_context: false,
  };
}

const PASS: VerifierResult = {
  in_scope: true,
  claim_holds: true,
  introduced_by_pr: true,
  quotes: ["i <= values.length"],
  rationale: "Reads past the end.",
  score: 92,
  severity: "blocking",
};

function script(fx: Fixture) {
  return (req: QueryRequest): QueryOutcome<unknown> => {
    const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
    if (req.role === "triage") return out(BRIEF);
    if (req.role === "reviewer") return out({ findings: [plantedFinding(fx)] });
    if (req.role === "verifier" || req.role === "verifier-escalation") return out(PASS);
    throw new Error(`unexpected role ${req.role}`);
  };
}

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

async function exitCodeOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function worktrees(repo: string): Promise<string> {
  const { stdout: list } = await run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  return list;
}

let fx: Fixture;
let outRoot: string;
beforeAll(async () => {
  fx = await makeFixture();
  outRoot = mkdtempSync(join(tmpdir(), "pr-review-run-out-"));
}, 30_000);
afterAll(() => {
  if (fx) rmSync(fx.repo, { recursive: true, force: true });
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
});

describe("run exit codes (A1)", () => {
  it("exits 0 when the run writes a record", async () => {
    const out = join(outRoot, "ok");
    const fake = createFakeSdkClient(script(fx));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync([
        "node",
        "pr-review",
        "run",
        "--repo",
        fx.repo,
        "--base",
        fx.base,
        "--head",
        fx.head,
        "--out",
        out,
      ]),
    );
    expect(code).toBe(0);
    expect(readdirSync(out)).toHaveLength(1);
  });

  it("exits 0 for an incomplete verdict", async () => {
    const out = join(outRoot, "incomplete");
    const fake = createFakeSdkClient((req) =>
      req.role === "reviewer"
        ? { ok: false, failure: { kind: "refusal", message: "refused" }, raw: META }
        : script(fx)(req),
    );
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync([
        "node",
        "pr-review",
        "run",
        "--repo",
        fx.repo,
        "--base",
        fx.base,
        "--head",
        fx.head,
        "--out",
        out,
        "--format",
        "json",
      ]),
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).verdict).toBe("incomplete");
  });

  it("exits 2 on a usage error", async () => {
    const fake = createFakeSdkClient(script(fx));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync([
        "node",
        "pr-review",
        "run",
        "--repo",
        fx.repo,
        "--base",
        fx.base,
      ]),
    );
    expect(code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("exits 1 when the run cannot write a record", async () => {
    const blocker = join(outRoot, "a-file");
    writeFileSync(blocker, "not a directory");
    const fake = createFakeSdkClient(script(fx));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync([
        "node",
        "pr-review",
        "run",
        "--repo",
        fx.repo,
        "--base",
        fx.base,
        "--head",
        fx.head,
        "--out",
        join(blocker, "records"),
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/pr-review run:/);
  });

  it("exits 1 when a SHA does not exist", async () => {
    const fake = createFakeSdkClient(script(fx));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync([
        "node",
        "pr-review",
        "run",
        "--repo",
        fx.repo,
        "--base",
        "0".repeat(40),
        "--head",
        fx.head,
        "--out",
        join(outRoot, "bad-sha"),
      ]),
    );
    expect(code).toBe(1);
    expect(existsSync(join(outRoot, "bad-sha"))).toBe(false);
  });
});

describe("the head worktree", () => {
  it("is the cwd of every query and is gone after a run", async () => {
    const fake = createFakeSdkClient(script(fx));
    await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "cwd"),
      allowApiKey: false,
      client: fake,
    });
    const cwds = new Set(fake.calls.map((c) => c.cwd));
    expect(cwds.size).toBe(1);
    const [cwd] = [...cwds] as [string];
    expect(cwd).not.toBe(fx.repo);
    expect(existsSync(cwd)).toBe(false);
    expect(await worktrees(fx.repo)).not.toContain(cwd);
  });

  it("is removed after a run that fails while it exists", async () => {
    let seen = "";
    const fake = createFakeSdkClient((req) => {
      seen = req.cwd;
      if (req.role === "reviewer") {
        // An output that breaks the find stage makes the run fail.
        return { ok: true, output: { findings: null }, raw: META };
      }
      return script(fx)(req);
    });
    await expect(
      runReview({
        repo: fx.repo,
        base: fx.base,
        head: fx.head,
        outDir: join(outRoot, "fail"),
        allowApiKey: false,
        client: fake,
      }),
    ).rejects.toThrow();
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
    expect(await worktrees(fx.repo)).not.toContain(seen);
    expect(existsSync(join(outRoot, "fail"))).toBe(false);
  });

  it("is removed after a run that fails to write its record", async () => {
    const blocker = join(outRoot, "blocker-2");
    writeFileSync(blocker, "x");
    const fake = createFakeSdkClient(script(fx));
    await expect(
      runReview({
        repo: fx.repo,
        base: fx.base,
        head: fx.head,
        outDir: join(blocker, "r"),
        allowApiKey: false,
        client: fake,
      }),
    ).rejects.toThrow();
    const cwd = fake.calls[0]?.cwd ?? "";
    expect(cwd).not.toBe("");
    expect(existsSync(cwd)).toBe(false);
  });
});

describe("run without --repo", () => {
  it("reviews the repo of the current directory and writes to ./pr-review-records", async () => {
    const before = process.cwd();
    process.chdir(fx.repo);
    try {
      const fake = createFakeSdkClient(script(fx));
      const code = await exitCodeOf(
        createProgram({ client: fake }).parseAsync([
          "node",
          "pr-review",
          "run",
          "--base",
          fx.base,
          "--head",
          fx.head,
          "--format",
          "json",
        ]),
      );
      expect(code).toBe(0);
      const doc = JSON.parse(stdout) as { record_path: string; findings: unknown[] };
      expect(
        realpathSync(doc.record_path).startsWith(realpathSync(join(fx.repo, "pr-review-records"))),
      ).toBe(true);
      const record = JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord;
      expect(realpathSync(record.identity.repo)).toBe(realpathSync(fx.repo));
      expect(record.identity.head).toBe(fx.head);
      expect(record.identity.changed_files.map((f) => f.path)).toContain("src/stats.ts");
      expect(doc.findings).toHaveLength(1);
    } finally {
      process.chdir(before);
    }
  });
});

describe("refusals and the verdict", () => {
  function refusingScript(role: "verifier" | "verifier-escalation", firstScore = 70) {
    return (req: QueryRequest): QueryOutcome<unknown> => {
      if (req.role === role) {
        return {
          ok: false,
          failure: { kind: "refusal", message: "refused" },
          raw: { ...META, stopReason: "refusal" },
        };
      }
      if (req.role === "verifier")
        return { ok: true, output: { ...PASS, score: firstScore }, raw: META };
      return script(fx)(req);
    };
  }

  it("drops the finding and makes the verdict incomplete when an escalation call is refused", async () => {
    const fake = createFakeSdkClient(refusingScript("verifier-escalation", 84));
    const { record } = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "refused-escalation"),
      allowApiKey: false,
      client: fake,
    });
    expect(record.stages.verifications[0]?.escalated).toMatchObject({ kind: "refusal" });
    expect(record.stages.verifications[0]?.passed).toBe(false);
    expect(record.posted.findings).toHaveLength(0);
    expect(record.posted.verdict).toBe("incomplete");
    expect(record.posted.coverage.findings_dropped_by_failed_verifier).toBe(1);
  });

  it("makes the verdict incomplete when a first verifier call is refused", async () => {
    const fake = createFakeSdkClient(refusingScript("verifier"));
    const { record } = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "refused-verifier"),
      allowApiKey: false,
      client: fake,
    });
    expect(record.posted.verdict).toBe("incomplete");
    expect(record.posted.coverage.findings_dropped_by_failed_verifier).toBe(1);
  });

  it("makes the verdict incomplete when a reviewer call is refused", async () => {
    const fake = createFakeSdkClient((req) =>
      req.role === "reviewer"
        ? { ok: false, failure: { kind: "refusal", message: "refused" }, raw: META }
        : script(fx)(req),
    );
    const { record } = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "refused-reviewer"),
      allowApiKey: false,
      client: fake,
    });
    expect(record.posted.verdict).toBe("incomplete");
  });
});

describe("a verifier result that the quote check rejects", () => {
  it("is not posted, is in the errors, counts as dropped and makes the verdict incomplete", async () => {
    const fake = createFakeSdkClient((req) =>
      req.role === "verifier" || req.role === "verifier-escalation"
        ? { ok: true, output: { ...PASS, quotes: ["this text is not in the file"] }, raw: META }
        : script(fx)(req),
    );
    const { record } = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "rejected-quote"),
      allowApiKey: false,
      client: fake,
    });
    expect(record.stages.verifications[0]?.rejected).toMatch(/quote/i);
    expect(record.posted.findings).toEqual([]);
    expect(record.posted.verdict).toBe("incomplete");
    expect(record.posted.coverage.findings_dropped_by_failed_verifier).toBe(1);
    expect(record.cost.errors).toEqual([
      {
        stage: "verify",
        message: expect.stringMatching(new RegExp(`^${fx.file}:${fx.line} rejected: .*quote`, "i")),
      },
    ]);
  });
});

describe("the selected reviewers in the record", () => {
  function def(name: string, model: string, effort: "low" | "high"): ReviewerDefinition {
    return {
      source: "builtin",
      path: `/x/${name}.md`,
      systemPrompt: "s",
      frontmatter: {
        name,
        description: "d",
        model,
        effort,
        tools: [],
        triggers: { paths: [], categories: [], min_tier: "fast" },
        passes: 1,
        threshold: 80,
        trusted: true,
      },
    };
  }

  it("holds the model and effort that each reviewer uses, after its frontmatter override", () => {
    expect(
      describeSelected(
        [
          { def: def("a", "sonnet", "high"), trigger: "t1" },
          { def: def("b", "claude-opus-4-1", "low"), trigger: "t2" },
        ],
        DEFAULT_REPO_CONFIG,
      ),
    ).toEqual([
      { name: "a", trigger: "t1", model: "claude-sonnet-5-5", effort: "high", tools_ignored: [] },
      { name: "b", trigger: "t2", model: "claude-opus-4-1", effort: "low", tools_ignored: [] },
    ]);
  });

  it("names each tool of the reviewer that is not in the read-only set", () => {
    const wide = def("w", "opus", "low");
    wide.frontmatter.tools = ["Read", "Bash", "WebFetch", "grep"];
    expect(describeSelected([{ def: wide, trigger: "t" }], DEFAULT_REPO_CONFIG)).toEqual([
      {
        name: "w",
        trigger: "t",
        model: "claude-opus-5-5",
        effort: "low",
        tools_ignored: ["Bash", "WebFetch"],
      },
    ]);
  });

  it("holds the model and effort after the repo config: the reviewer key, then models.reviewer", () => {
    const config = {
      ...DEFAULT_REPO_CONFIG,
      models: { reviewer: { model: "haiku", effort: "medium" as const } },
      reviewers: { b: { enabled: true, model: "sonnet" } },
    };
    expect(
      describeSelected(
        [
          { def: def("a", "opus", "high"), trigger: "t1" },
          { def: def("b", "opus", "low"), trigger: "t2" },
        ],
        config,
      ),
    ).toEqual([
      { name: "a", trigger: "t1", model: "claude-haiku-5-5", effort: "medium", tools_ignored: [] },
      { name: "b", trigger: "t2", model: "claude-sonnet-5-5", effort: "medium", tools_ignored: [] },
    ]);
  });
});

describe("a verifier prompt that does not load", () => {
  afterEach(() => {
    mocks.failVerifierPrompt = false;
    mocks.reviewerPasses = undefined;
  });

  it("fails the verification, writes the record and removes the worktree while a reviewer pass is pending", async () => {
    mocks.failVerifierPrompt = true;
    mocks.reviewerPasses = 2;
    let reviewerCalls = 0;
    const fake = createFakeSdkClient(async (req) => {
      if (req.role === "reviewer") {
        reviewerCalls += 1;
        if (reviewerCalls === 1) {
          return { ok: true, output: { findings: [plantedFinding(fx)] }, raw: META };
        }
        // The second pass is still pending when the first finding goes
        // to its verifier.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true, output: { findings: [] }, raw: META };
      }
      return script(fx)(req);
    });
    const { record, recordPath } = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "verifier-prompt-fails"),
      allowApiKey: false,
      client: fake,
    });
    expect(reviewerCalls).toBe(2);
    expect(existsSync(recordPath)).toBe(true);
    expect(record.stages.verifications).toEqual([
      {
        finding: plantedFinding(fx),
        first: { kind: "thrown", message: expect.stringContaining("PROMPT-LOAD-FAILED") },
        final: null,
        passed: false,
      },
    ]);
    expect(fake.calls.filter((c) => c.role === "verifier")).toEqual([]);
    expect(record.posted.findings).toEqual([]);
    expect(record.posted.verdict).toBe("incomplete");
    expect(record.posted.coverage.findings_dropped_by_failed_verifier).toBe(1);
    const cwd = fake.calls[0]?.cwd ?? "";
    expect(cwd).not.toBe("");
    expect(existsSync(cwd)).toBe(false);
    expect(await worktrees(fx.repo)).not.toContain(cwd);
  });
});

describe("a finding path with a ./ prefix", () => {
  it("is normalized once, so the verifier gets the diff of the file and the record the clean path", async () => {
    const fake = createFakeSdkClient((req) =>
      req.role === "reviewer"
        ? {
            ok: true,
            output: { findings: [{ ...plantedFinding(fx), file: `./${fx.file}` }] },
            raw: META,
          }
        : script(fx)(req),
    );
    const { record } = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "dot-slash"),
      allowApiKey: false,
      client: fake,
    });
    const verifier = fake.calls.find((c) => c.role === "verifier");
    expect(verifier?.userMessage).toContain(`+++ b/${fx.file}`);
    expect(record.stages.reviewers[0]?.findings.map((f) => f.file)).toEqual([fx.file]);
    expect(record.stages.verifications[0]?.finding.file).toBe(fx.file);
    expect(record.posted.findings.map((f) => f.file)).toEqual([fx.file]);
  });
});

describe("the repo config in a run (R3)", () => {
  const fixtures: Fixture[] = [];
  afterAll(() => {
    for (const f of fixtures) rmSync(f.repo, { recursive: true, force: true });
  });

  async function fixtureWithConfig(configYaml: string): Promise<Fixture> {
    const source = mkdtempSync(join(tmpdir(), "pr-review-run-config-"));
    try {
      mkdirSync(join(source, "dir"));
      writeFileSync(join(source, "dir", "config.yaml"), configYaml);
      const made = await makeFixture("--pr-review-dir", join(source, "dir"));
      fixtures.push(made);
      return made;
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  }

  it("applies role models, the reviewer threshold, the band, globs and concurrency", async () => {
    const cfx = await fixtureWithConfig(
      [
        "thresholds:",
        "  middle_band: [10, 20]",
        "reviewers:",
        "  diff-bugs:",
        "    threshold: 95",
        "models:",
        "  triage:",
        "    model: haiku",
        "  reviewer:",
        "    model: sonnet",
        "  verifier:",
        "    effort: max",
        "  verifier-escalation:",
        "    model: sonnet",
        "  merge:",
        "    effort: low",
        "generated_globs: ['.github/**']",
        "concurrency: 1",
        "",
      ].join("\n"),
    );
    let active = 0;
    let most = 0;
    const base = script(cfx);
    const fake = createFakeSdkClient(async (req) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return base(req);
    });
    const { record } = await runReview({
      repo: cfx.repo,
      base: cfx.base,
      head: cfx.head,
      outDir: join(outRoot, "config-run"),
      allowApiKey: false,
      client: fake,
    });

    const byRole = (role: string) => fake.calls.filter((c) => c.role === role);
    expect(byRole("triage").map((c) => c.overrides)).toEqual([{ model: "claude-haiku-5-5" }]);
    expect(byRole("reviewer").map((c) => c.overrides)).toEqual([
      { model: "claude-sonnet-5-5", effort: "low" },
    ]);
    expect(byRole("verifier").map((c) => c.overrides)).toEqual([{ effort: "max" }]);
    // The score 92 is outside the band 10 to 20, so no escalation runs, and
    // it is below the reviewer threshold 95, so the finding fails.
    expect(byRole("verifier-escalation")).toEqual([]);
    expect(record.stages.verifications.map((v) => v.passed)).toEqual([false]);
    expect(record.posted.findings).toEqual([]);
    expect(most).toBe(1);

    expect(record.identity.models).toEqual({
      triage: { model: "claude-haiku-5-5", effort: "medium" },
      reviewer: { model: "claude-sonnet-5-5", effort: "low" },
      verifier: { model: "claude-sonnet-5-5", effort: "max" },
      "verifier-escalation": { model: "claude-sonnet-5-5", effort: "high" },
      merge: { model: "claude-sonnet-5-5", effort: "low" },
      smoke: { model: "claude-sonnet-5-5", effort: "low" },
    });
    expect(record.identity.selected_reviewers).toEqual([
      expect.objectContaining({ name: "diff-bugs", model: "claude-sonnet-5-5", effort: "low" }),
    ]);
    expect(record.identity.excluded_files).toContainEqual({
      path: ".github/workflows/ci.yml",
      reason: "generated",
    });
    expect(record.identity.sensitive_files).toEqual([]);
    expect(record.identity.config.values.concurrency).toBe(1);
  }, 30_000);

  it("escalates a score inside the configured band, with the escalation model", async () => {
    const cfx = await fixtureWithConfig(
      "thresholds:\n  middle_band: [90, 95]\nmodels:\n  verifier-escalation:\n    model: haiku\n",
    );
    const fake = createFakeSdkClient(script(cfx));
    const { record } = await runReview({
      repo: cfx.repo,
      base: cfx.base,
      head: cfx.head,
      outDir: join(outRoot, "config-band"),
      allowApiKey: false,
      client: fake,
    });
    const escalations = fake.calls.filter((c) => c.role === "verifier-escalation");
    expect(escalations.map((c) => c.overrides)).toEqual([{ model: "claude-haiku-5-5" }]);
    expect(fake.calls.filter((c) => c.role === "verifier").map((c) => c.overrides)).toEqual([
      undefined,
    ]);
    expect(record.posted.findings).toHaveLength(1);
    const entry = record.cost.queries.find((q) => q.role === "verifier-escalation");
    expect(entry?.model).toBe("m");
  }, 30_000);

  it("selects a custom reviewer from the base commit and sends its body and its model", async () => {
    const source = mkdtempSync(join(tmpdir(), "pr-review-run-custom-"));
    let cfx: Fixture;
    try {
      mkdirSync(join(source, "dir", "reviewers"), { recursive: true });
      writeFileSync(
        join(source, "dir", "reviewers", "naming.md"),
        [
          "---",
          "name: naming",
          "description: Checks names.",
          "model: haiku",
          "effort: medium",
          "tools: [Read, Bash]",
          "triggers:",
          "  paths: ['src/**']",
          "  categories: []",
          "  min_tier: fast",
          "passes: 1",
          "threshold: 85",
          "---",
          "CUSTOM-BODY: you review names.",
          "",
        ].join("\n"),
      );
      cfx = await makeFixture("--pr-review-dir", join(source, "dir"));
      fixtures.push(cfx);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
    const fake = createFakeSdkClient(script(cfx));
    const { record } = await runReview({
      repo: cfx.repo,
      base: cfx.base,
      head: cfx.head,
      tierOverride: "fast",
      outDir: join(outRoot, "config-custom"),
      allowApiKey: false,
      client: fake,
    });
    const custom = fake.calls.filter((c) => c.reviewerName === "naming");
    expect(custom).toHaveLength(1);
    expect(custom[0]?.systemPrompt).toContain("CUSTOM-BODY");
    expect(custom[0]?.overrides).toEqual({ model: "claude-haiku-5-5", effort: "medium" });
    expect(record.identity.selected_reviewers.map((r) => r.name).sort()).toEqual([
      "diff-bugs",
      "naming",
    ]);
    expect(record.identity.selected_reviewers.find((r) => r.name === "naming")).toMatchObject({
      trigger: expect.stringContaining("path src/stats.ts"),
      tools_ignored: ["Bash"],
    });
    expect(record.posted.coverage.reviewers_ran).toContain("naming");
    expect(record.identity.config.files).toEqual([".pr-review/reviewers/naming.md"]);
    // The custom reviewer's threshold 85 holds: the score 92 passes.
    expect(record.posted.findings.length).toBeGreaterThan(0);
  }, 30_000);

  it("injects the base CLAUDE.md into each reviewer prompt, and a skip run injects nothing", async () => {
    const source = mkdtempSync(join(tmpdir(), "pr-review-run-claude-"));
    let cfx: Fixture;
    try {
      writeFileSync(join(source, "claude.md"), "CLAUDE-RUN-RULE: keep it small.\n");
      cfx = await makeFixture("--claude-md", join(source, "claude.md"));
      fixtures.push(cfx);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
    const fake = createFakeSdkClient(script(cfx));
    const { record } = await runReview({
      repo: cfx.repo,
      base: cfx.base,
      head: cfx.head,
      outDir: join(outRoot, "claude-run"),
      allowApiKey: false,
      client: fake,
    });
    const reviewers = fake.calls.filter((c) => c.role === "reviewer");
    expect(reviewers.length).toBeGreaterThan(0);
    for (const call of reviewers) {
      expect(call.systemPrompt.trimEnd().endsWith("CLAUDE-RUN-RULE: keep it small.")).toBe(true);
    }
    for (const call of fake.calls.filter((c) => c.role !== "reviewer")) {
      expect(call.systemPrompt).not.toContain("CLAUDE-RUN-RULE");
    }
    expect(record.identity.injected).toEqual([{ path: "CLAUDE.md", truncated: false }]);
    // The config hash does not include CLAUDE.md.
    expect(record.identity.config_hash).toBeNull();

    const skipped = await runReview({
      repo: cfx.repo,
      base: cfx.base,
      head: cfx.head,
      tierOverride: "skip",
      outDir: join(outRoot, "claude-skip"),
      allowApiKey: false,
      client: createFakeSdkClient(script(cfx)),
    });
    expect(skipped.record.identity.injected).toEqual([]);
  }, 30_000);

  it("runs with the defaults when the base commit has no .pr-review/", async () => {
    const fake = createFakeSdkClient(script(fx));
    const { record } = await runReview({
      repo: fx.repo,
      base: fx.base,
      head: fx.head,
      outDir: join(outRoot, "config-none"),
      allowApiKey: false,
      client: fake,
    });
    expect(record.identity.config).toEqual({
      files: [],
      values: DEFAULT_REPO_CONFIG,
      custom_reviewers: [],
    });
    expect(record.identity.config_hash).toBeNull();
    expect(record.posted.coverage.reviewers_skipped).toEqual([]);
    expect(
      fake.calls.filter((c) => c.role !== "reviewer").every((c) => c.overrides === undefined),
    ).toBe(true);
  }, 30_000);
});
