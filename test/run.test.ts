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
import type * as History from "../src/gather/history.js";
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
import { buildQueryOptions } from "../src/sdk/options.js";
import { UNTRUSTED_SYSTEM_LINE } from "../src/untrusted.js";

// Test switches for the module mocks below. They are off unless a test
// sets them.
const mocks = vi.hoisted(() => ({
  failVerifierPrompt: false,
  failHistory: false,
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

vi.mock("../src/gather/history.js", async (importOriginal) => {
  const original = await importOriginal<typeof History>();
  return {
    ...original,
    gatherHistory: (...args: Parameters<typeof original.gatherHistory>) =>
      mocks.failHistory
        ? Promise.reject(new Error("git blame failed"))
        : original.gatherHistory(...args),
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

// Only diff-bugs reports the planted finding. The other built-in
// reviewers report nothing, so one finding goes through the run.
function script(fx: Fixture) {
  return (req: QueryRequest): QueryOutcome<unknown> => {
    const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
    if (req.role === "triage") return out(BRIEF);
    if (req.role === "reviewer") {
      return out({ findings: req.reviewerName === "diff-bugs" ? [plantedFinding(fx)] : [] });
    }
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
      if (req.role === "reviewer" && req.reviewerName === "diff-bugs") {
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
      req.role === "reviewer" && req.reviewerName === "diff-bugs"
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
    const diffBugs = record.stages.reviewers.filter((r) => r.name === "diff-bugs");
    expect(diffBugs.length).toBeGreaterThan(0);
    for (const run of diffBugs) expect(run.findings.map((f) => f.file)).toEqual([fx.file]);
    expect(record.stages.verifications).toHaveLength(1);
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
    // Every built-in reviewer has effort low in its frontmatter, and
    // models.reviewer sets the model of each one.
    expect(byRole("reviewer").length).toBeGreaterThan(1);
    for (const call of byRole("reviewer")) {
      expect(call.overrides, call.reviewerName).toEqual({
        model: "claude-sonnet-5-5",
        effort: "low",
      });
    }
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
    expect(record.identity.selected_reviewers.map((r) => r.name)).toContain("diff-bugs");
    for (const entry of record.identity.selected_reviewers) {
      expect(entry, entry.name).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
    }
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
      "conventions",
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

describe("the seven built-in reviewers in a run (R1, R6)", () => {
  const SEVEN = [
    "conventions",
    "description-drift",
    "diff-bugs",
    "docs-and-comments",
    "history",
    "security",
    "tests",
  ];
  const fixtures: Fixture[] = [];
  afterAll(() => {
    for (const f of fixtures) rmSync(f.repo, { recursive: true, force: true });
  });

  // The run script, with a merge answer: every reviewer returns the same
  // finding, so the verified findings form one merge group.
  function scriptWithMerge(f: Fixture) {
    const base = script(f);
    return (req: QueryRequest): QueryOutcome<unknown> => {
      if (req.role === "reviewer") {
        return { ok: true, output: { findings: [plantedFinding(f)] }, raw: META };
      }
      if (req.role !== "merge") return base(req);
      return {
        ok: true,
        output: {
          merged: [
            {
              member_index: 0,
              claim: "The loop reads one item past the end.",
              explanation: "The bound must be i < values.length.",
              severity: "blocking",
            },
          ],
        },
        raw: META,
      };
    };
  }

  async function fixtureWith(configYaml: string | null): Promise<Fixture> {
    if (configYaml === null) {
      const made = await makeFixture();
      fixtures.push(made);
      return made;
    }
    const source = mkdtempSync(join(tmpdir(), "pr-review-run-seven-"));
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

  async function review(f: Fixture, out: string, tier?: "full" | "fast") {
    const fake = createFakeSdkClient(scriptWithMerge(f));
    const { record } = await runReview({
      repo: f.repo,
      base: f.base,
      head: f.head,
      ...(tier ? { tierOverride: tier } : {}),
      outDir: join(outRoot, out),
      allowApiKey: false,
      client: fake,
    });
    return { record, fake };
  }

  const passesOf = (record: RunRecord, name: string) =>
    record.stages.reviewers.filter((r) => r.name === name).map((r) => r.pass);

  it("selects all seven at tier full, with two passes for diff-bugs and security", async () => {
    const f = await fixtureWith(null);
    const { record } = await review(f, "seven-full", "full");
    expect(record.identity.selected_reviewers.map((r) => r.name).sort()).toEqual(SEVEN);
    expect([...record.posted.coverage.reviewers_ran].sort()).toEqual(SEVEN);
    expect(record.posted.coverage.reviewers_skipped).toEqual([]);
    expect(passesOf(record, "diff-bugs").sort()).toEqual([1, 2]);
    expect(passesOf(record, "security").sort()).toEqual([1, 2]);
    expect(passesOf(record, "tests")).toEqual([1]);
    expect(record.stages.reviewers).toHaveLength(9);
    // One verification per reviewer: the passes of one reviewer give one.
    expect(record.stages.verifications).toHaveLength(7);
    expect(record.posted.findings).toHaveLength(1);
  }, 30_000);

  it("selects six and lists description-drift as skipped when the description is empty", async () => {
    const f = await fixtureWith(null);
    // A head whose only commit after the merge base has an empty message.
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = async (...args: string[]) =>
      (await run("git", ["-C", f.repo, ...args], { env })).stdout.trim();
    const mergeBase = await git("merge-base", f.base, f.head);
    await git("checkout", "--quiet", "-b", "no-description", mergeBase);
    writeFileSync(
      join(f.repo, "src/stats.ts"),
      `${readFileSync(join(f.repo, "src/stats.ts"), "utf8")}\nexport const answer = 42;\n`,
    );
    await git("commit", "--quiet", "--no-gpg-sign", "--allow-empty-message", "-am", "");
    const head = await git("rev-parse", "HEAD");

    const { record } = await review({ ...f, head }, "seven-no-description", "full");
    expect(record.identity.description).toBe("");
    expect(record.identity.selected_reviewers.map((r) => r.name).sort()).toEqual(
      SEVEN.filter((n) => n !== "description-drift"),
    );
    expect(record.posted.coverage.reviewers_skipped).toEqual([
      { name: "description-drift", reason: "no description" },
    ]);
    expect(record.posted.coverage.reviewers_ran).not.toContain("description-drift");
  }, 30_000);

  it("does not list description-drift as skipped at the fast tier, which does not select it", async () => {
    const f = await fixtureWith(null);
    const { record } = await review(f, "seven-fast", "fast");
    expect(record.identity.selected_reviewers.map((r) => r.name)).toEqual([
      "conventions",
      "diff-bugs",
    ]);
    expect(record.posted.coverage.reviewers_skipped).toEqual([]);
  }, 30_000);

  it("verifies one copy of a finding that two passes return, and records both passes", async () => {
    const others = SEVEN.filter((n) => n !== "diff-bugs")
      .map((n) => `  ${n}:\n    enabled: false\n`)
      .join("");
    const f = await fixtureWith(`reviewers:\n${others}`);
    const { record, fake } = await review(f, "seven-dedupe", "full");
    expect(record.stages.reviewers.map((r) => [r.name, r.pass, r.findings.length])).toEqual([
      ["diff-bugs", 1, 1],
      ["diff-bugs", 2, 1],
    ]);
    expect(record.stages.verifications).toHaveLength(1);
    expect(fake.calls.filter((c) => c.role === "verifier")).toHaveLength(1);
    expect(record.posted.findings).toHaveLength(1);
  }, 30_000);

  it("runs one pass per reviewer at the fast tier, even when the config sets more", async () => {
    const f = await fixtureWith(
      "reviewers:\n  diff-bugs:\n    passes: 3\n  conventions:\n    passes: 2\n",
    );
    const fast = await review(f, "seven-passes-fast", "fast");
    expect(passesOf(fast.record, "diff-bugs")).toEqual([1]);
    expect(passesOf(fast.record, "conventions")).toEqual([1]);
    const full = await review(f, "seven-passes-full", "full");
    expect(passesOf(full.record, "diff-bugs").sort()).toEqual([1, 2, 3]);
    expect(passesOf(full.record, "conventions").sort()).toEqual([1, 2]);
  }, 30_000);
});

// A custom reviewer file for .pr-review/reviewers/. Its body does not hold
// the untrusted-data line or the other prompt rules.
function customReviewer(trusted: boolean | null): string {
  return [
    "---",
    "name: shell-check",
    "description: Checks shell use.",
    "model: sonnet",
    "effort: medium",
    "tools: [Read, Bash]",
    "triggers:",
    "  paths: []",
    "  categories: []",
    "  min_tier: fast",
    "passes: 1",
    "threshold: 80",
    ...(trusted === null ? [] : [`trusted: ${trusted}`]),
    "---",
    "SHELL-BODY: you check the shell use of the change.",
    "",
  ].join("\n");
}

async function fixtureWithFiles(files: Record<string, string>): Promise<Fixture> {
  const source = mkdtempSync(join(tmpdir(), "pr-review-run-files-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(source, "dir", path, ".."), { recursive: true });
      writeFileSync(join(source, "dir", path), text);
    }
    return await makeFixture("--pr-review-dir", join(source, "dir"));
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

describe("custom reviewers and the Bash policy (R7)", () => {
  const fixtures: Fixture[] = [];
  let trusted: Fixture;
  let untrusted: Fixture;
  beforeAll(async () => {
    trusted = await fixtureWithFiles({ "reviewers/shell-check.md": customReviewer(true) });
    untrusted = await fixtureWithFiles({ "reviewers/shell-check.md": customReviewer(null) });
    fixtures.push(trusted, untrusted);
  }, 30_000);
  afterAll(() => {
    for (const f of fixtures) rmSync(f.repo, { recursive: true, force: true });
  });

  async function review(f: Fixture, authorWriteAccess: boolean | undefined, out: string) {
    const fake = createFakeSdkClient(script(f));
    const { record } = await runReview({
      repo: f.repo,
      base: f.base,
      head: f.head,
      tierOverride: "fast",
      outDir: join(outRoot, out),
      allowApiKey: false,
      client: fake,
      ...(authorWriteAccess === undefined ? {} : { authorWriteAccess }),
    });
    return { record, fake };
  }

  const cases: {
    label: string;
    fixture: () => Fixture;
    write: boolean | undefined;
    reason: string | null;
  }[] = [
    { label: "trusted, with write access", fixture: () => trusted, write: true, reason: null },
    {
      label: "not trusted, with write access",
      fixture: () => untrusted,
      write: true,
      reason: "not trusted",
    },
    {
      label: "trusted, no write access",
      fixture: () => trusted,
      write: false,
      reason: "author has no write access",
    },
    {
      label: "not trusted, write access absent (false)",
      fixture: () => untrusted,
      write: undefined,
      reason: "not trusted and author has no write access",
    },
  ];
  for (const c of cases) {
    it(`${c.reason === null ? "grants" : "does not grant"} Bash: ${c.label}`, async () => {
      const granted = c.reason === null;
      const { record, fake } = await review(c.fixture(), c.write, `bash-${c.label}`);
      const custom = fake.calls.filter((call) => call.reviewerName === "shell-check");
      expect(custom).toHaveLength(1);
      const call = custom[0] as QueryRequest;
      expect(call.bash === true).toBe(granted);
      const opts = buildQueryOptions(call, { allowApiKey: false, env: {} });
      expect((opts.tools as string[]).includes("Bash")).toBe(granted);
      expect((opts.allowedTools as string[]).includes("Bash")).toBe(granted);
      expect((opts.disallowedTools as string[]).includes("Bash")).toBe(!granted);
      expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit"]));
      expect(opts.permissionMode).toBe("dontAsk");
      // A built-in reviewer never gets Bash.
      for (const other of fake.calls.filter((x) => x.role === "reviewer" && x !== call)) {
        expect(other.bash).not.toBe(true);
      }
      expect(record.identity.config.custom_reviewers).toEqual([
        { name: "shell-check", bash_granted: granted, reason: c.reason },
      ]);
      expect(record.posted.coverage.reviewers_without_bash).toEqual(
        granted ? [] : [{ name: "shell-check", reason: c.reason }],
      );
      expect(
        record.identity.selected_reviewers.find((r) => r.name === "shell-check")?.tools_ignored,
      ).toEqual(granted ? [] : ["Bash"]);
      expect(record.posted.coverage.reviewers_ran).toContain("shell-check");
    }, 30_000);
  }

  it("runs a custom reviewer through the fake, with its body first and the prompt rules after it", async () => {
    const { fake } = await review(untrusted, false, "custom-prompt");
    const call = fake.calls.find((c) => c.reviewerName === "shell-check");
    const prompt = call?.systemPrompt ?? "";
    expect(prompt.startsWith("SHELL-BODY: you check the shell use of the change.")).toBe(true);
    expect(prompt).toContain(UNTRUSTED_SYSTEM_LINE);
    expect(prompt).toMatch(/subagent/i);
    expect(prompt).toContain(
      "the path from the repo root, without the a/ or b/ prefix of the diff and without a leading /",
    );
    expect(prompt).toMatch(/confidence/i);
    expect(prompt).toMatch(/every issue/i);
    expect(call?.overrides).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
  }, 30_000);

  it("puts the custom rules block before the repo rules block", async () => {
    const source = mkdtempSync(join(tmpdir(), "pr-review-run-custom-rules-"));
    let f: Fixture;
    try {
      mkdirSync(join(source, "dir", "reviewers"), { recursive: true });
      writeFileSync(join(source, "dir", "reviewers", "shell-check.md"), customReviewer(false));
      writeFileSync(join(source, "dir", "rules.md"), "REPO-RULE-TEXT\n");
      f = await makeFixture("--pr-review-dir", join(source, "dir"));
      fixtures.push(f);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
    const { fake } = await review(f, false, "custom-and-repo-rules");
    const prompt = fake.calls.find((c) => c.reviewerName === "shell-check")?.systemPrompt ?? "";
    expect(prompt.indexOf(UNTRUSTED_SYSTEM_LINE)).toBeGreaterThan(0);
    expect(prompt.indexOf(UNTRUSTED_SYSTEM_LINE)).toBeLessThan(prompt.indexOf("REPO-RULE-TEXT"));
    expect(prompt.trimEnd().endsWith("REPO-RULE-TEXT")).toBe(true);
    // A built-in body keeps its rules inline and gets no custom block.
    const builtin = fake.calls.find((c) => c.reviewerName === "diff-bugs")?.systemPrompt ?? "";
    expect(builtin.split(UNTRUSTED_SYSTEM_LINE)).toHaveLength(2);
  }, 30_000);
});

describe("the token ceiling (R8)", () => {
  const fixtures: Fixture[] = [];
  afterAll(() => {
    for (const f of fixtures) rmSync(f.repo, { recursive: true, force: true });
  });

  const ONLY_DIFF_BUGS = [
    "conventions",
    "description-drift",
    "docs-and-comments",
    "history",
    "security",
    "tests",
  ]
    .map((n) => `  ${n}:\n    enabled: false\n`)
    .join("");

  // 300 + 200 + 50 + 50 = 600 tokens for each reviewer query.
  const USAGE = {
    "claude-opus-5-5": {
      inputTokens: 300,
      outputTokens: 200,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 50,
      webSearchRequests: 9999,
      costUSD: 0.5,
    },
  };

  async function review(concurrency: number, ceiling: number, out: string) {
    const f = await fixtureWithFiles({
      "config.yaml": `reviewers:\n${ONLY_DIFF_BUGS}concurrency: ${concurrency}\ntoken_ceiling: ${ceiling}\n`,
    });
    fixtures.push(f);
    const base = script(f);
    const fake = createFakeSdkClient(async (req) => {
      const outcome = base(req);
      if (req.role !== "reviewer" || !outcome.ok) return outcome;
      // Both passes are in flight before the first one ends.
      await new Promise((r) => setTimeout(r, 10));
      return { ...outcome, raw: { ...META, usage: USAGE } };
    });
    const { record } = await runReview({
      repo: f.repo,
      base: f.base,
      head: f.head,
      tierOverride: "full",
      outDir: join(outRoot, out),
      allowApiKey: false,
      client: fake,
    });
    return { record, fake };
  }

  it("starts no new reviewer pass once the sum reaches the ceiling, lists it and makes the verdict incomplete", async () => {
    const { record, fake } = await review(1, 500, "ceiling-hit");
    expect(fake.calls.filter((c) => c.role === "reviewer")).toHaveLength(1);
    expect(record.stages.reviewers.map((r) => [r.name, r.pass])).toEqual([["diff-bugs", 1]]);
    expect(record.posted.coverage.reviewers_skipped).toContainEqual({
      name: "diff-bugs",
      reason: "token ceiling",
      pass: 2,
    });
    expect(record.posted.verdict).toBe("incomplete");
    // The finding of the first pass is still verified.
    expect(record.stages.verifications).toHaveLength(1);
    expect(record.stages.verifications[0]?.passed).toBe(true);
    expect(record.posted.findings).toHaveLength(1);
  }, 30_000);

  it("changes nothing when the ceiling is reached after every pass started", async () => {
    const { record, fake } = await review(5, 500, "ceiling-late");
    expect(fake.calls.filter((c) => c.role === "reviewer")).toHaveLength(2);
    expect(record.posted.coverage.reviewers_skipped.map((s) => s.reason)).not.toContain(
      "token ceiling",
    );
    expect(record.posted.verdict).toBe("would request changes");
  }, 30_000);

  it("changes nothing when the sum stays below the ceiling", async () => {
    const { record } = await review(1, 100000, "ceiling-high");
    expect(record.stages.reviewers.map((r) => r.pass).sort()).toEqual([1, 2]);
    expect(record.posted.verdict).toBe("would request changes");
  }, 30_000);
});

describe("the history block and the history reviewer config", () => {
  const fixtures: Fixture[] = [];
  let enabled: Fixture;
  let disabled: Fixture;
  beforeAll(async () => {
    enabled = await fixtureWithFiles({ "config.yaml": "thresholds:\n  default: 80\n" });
    disabled = await fixtureWithFiles({
      "config.yaml": "reviewers:\n  history:\n    enabled: false\n",
    });
    fixtures.push(enabled, disabled);
  }, 30_000);
  afterAll(() => {
    mocks.failHistory = false;
    for (const f of fixtures) rmSync(f.repo, { recursive: true, force: true });
  });
  afterEach(() => {
    mocks.failHistory = false;
  });

  async function review(f: Fixture, out: string) {
    const { record } = await runReview({
      repo: f.repo,
      base: f.base,
      head: f.head,
      tierOverride: "fast",
      outDir: join(outRoot, out),
      allowApiKey: false,
      client: createFakeSdkClient(script(f)),
    });
    return record;
  }

  it("builds the history block when the history reviewer is enabled", async () => {
    const record = await review(enabled, "history-on");
    expect(record.identity.history.built).toBe(true);
  });

  it("builds no history block when reviewers.history.enabled is false", async () => {
    const record = await review(disabled, "history-off");
    expect(record.identity.history).toEqual({ built: false, truncated: false });
  });

  it("completes the run, with no history block, when the history gather fails", async () => {
    mocks.failHistory = true;
    const record = await review(enabled, "history-fails");
    expect(record.identity.history).toEqual({ built: false, truncated: false });
    expect(record.identity.selected_reviewers.map((r) => r.name)).toContain("diff-bugs");
  });
});
