import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { GitHubError } from "../src/github/client.js";
import { createFakeGitHubClient, type FakePullRequestSeed } from "../src/github/fake.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

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
  durationMs: 3,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.05,
};

function script(fx: Fixture) {
  return (req: QueryRequest): QueryOutcome<unknown> => {
    const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
    if (req.role === "triage") {
      return out({
        tier: "fast",
        reason: "r",
        confidence: "high",
        categories: [],
        hotspots: [],
        file_notes: [],
        summary: "s",
      });
    }
    if (req.role === "reviewer") {
      return out({
        findings: [
          {
            file: fx.file,
            start_line: fx.line,
            end_line: fx.line,
            category: "bug",
            severity_estimate: "blocking",
            confidence: "high",
            claim: "CLAIM-off-by-one",
            evidence: "for (let i = 0; i <= values.length; i++) {",
            explanation: "e",
            needs_context: false,
          },
        ],
      });
    }
    // Every reviewer returns the same finding, so the verified copies form
    // one merge group, and merge keeps one of them.
    if (req.role === "merge") {
      return out({
        merged: [
          { member_index: 0, claim: "CLAIM-off-by-one", explanation: "e", severity: "blocking" },
        ],
      });
    }
    return out({
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: ["i <= values.length"],
      rationale: "r",
      score: 95,
      severity: "blocking",
    });
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

let fx: Fixture;
let outRoot: string;
beforeAll(async () => {
  fx = await makeFixture();
  outRoot = mkdtempSync(join(tmpdir(), "pr-review-cli-run-"));
}, 30_000);
afterAll(() => {
  if (fx) rmSync(fx.repo, { recursive: true, force: true });
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
});

function args(out: string, ...extra: string[]): string[] {
  return argsFor(fx, out, ...extra);
}

function argsFor(fixture: Fixture, out: string, ...extra: string[]): string[] {
  return [
    "node",
    "pr-review",
    "run",
    "--repo",
    fixture.repo,
    "--base",
    fixture.base,
    "--head",
    fixture.head,
    "--out",
    out,
    ...extra,
  ];
}

/** Build a fixture whose base commit holds a .pr-review/config.yaml with this text. */
async function fixtureWithConfig(configYaml: string): Promise<Fixture> {
  const source = mkdtempSync(join(tmpdir(), "pr-review-cli-config-"));
  try {
    mkdirSync(join(source, "dir"));
    writeFileSync(join(source, "dir", "config.yaml"), configYaml);
    return await makeFixture("--pr-review-dir", join(source, "dir"));
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

/** A fake pull request whose base and head are the commits of "fixture". */
function prFor(fixture: Fixture, seed: FakePullRequestSeed = {}) {
  return createFakeGitHubClient({
    number: 7,
    title: "Add average",
    body: "Adds an average function.",
    author: "alice",
    labels: ["bug"],
    base_sha: fixture.base,
    head_sha: fixture.head,
    head_repo: "acme/widgets",
    url: "https://github.com/acme/widgets/pull/7",
    viewer_login: "me",
    permission: "write",
    ...seed,
  });
}

/** The arguments of a --pr run, with no --base and no --head. */
function prArgs(fixture: Fixture, out: string, ...extra: string[]): string[] {
  return ["node", "pr-review", "run", "--repo", fixture.repo, "--out", out, "--pr", "7", ...extra];
}

describe("pr-review run through the CLI", () => {
  it("prints the table by default, with the record path", async () => {
    const fake = createFakeSdkClient(script(fx));
    expect(
      await exitCodeOf(createProgram({ client: fake }).parseAsync(args(join(outRoot, "table")))),
    ).toBe(0);
    expect(stdout).toContain("would request changes");
    expect(stdout).toContain("CLAIM-off-by-one");
    expect(stdout).toContain(`${fx.file}:${fx.line}`);
    const path = /Record: (.+\.json)/.exec(stdout)?.[1] ?? "";
    expect(RecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8"))).success).toBe(true);
  });

  it("prints one JSON document with --format json", async () => {
    const fake = createFakeSdkClient(script(fx));
    expect(
      await exitCodeOf(
        createProgram({ client: fake }).parseAsync(args(join(outRoot, "json"), "--format", "json")),
      ),
    ).toBe(0);
    const doc = JSON.parse(stdout);
    expect(Object.keys(doc).sort()).toEqual([
      "coverage",
      "excluded_files",
      "findings",
      "queries_without_cost",
      "record_path",
      "tier",
      "total_cost_usd",
      "verdict",
    ]);
    expect(doc.queries_without_cost).toBe(0);
    expect(typeof doc.total_cost_usd).toBe("number");
    expect(doc.tier).toBe("full");
    expect(doc.verdict).toBe("would request changes");
    // Seven reviewers report the same finding, and merge keeps one.
    expect(doc.coverage.reviewers_ran).toHaveLength(7);
    expect(doc.findings).toHaveLength(1);
    expect(doc.findings[0]).toMatchObject({
      file: fx.file,
      start_line: fx.line,
      severity: "blocking",
      score: 95,
    });
  });

  it("passes --allow-api-key through to the query options", async () => {
    const seen: boolean[] = [];
    const fake = createFakeSdkClient(script(fx));
    const original = fake.query.bind(fake);
    fake.query = async (req, options) => {
      seen.push(options.allowApiKey);
      return original(req, options);
    };
    await exitCodeOf(
      createProgram({ client: fake }).parseAsync(args(join(outRoot, "key"), "--allow-api-key")),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v)).toBe(true);
  });

  it("uses --tier fast over the sensitive floor", async () => {
    const fake = createFakeSdkClient(script(fx));
    await exitCodeOf(
      createProgram({ client: fake }).parseAsync(
        args(join(outRoot, "fast"), "--format", "json", "--tier", "fast"),
      ),
    );
    const doc = JSON.parse(stdout);
    expect(doc.tier).toBe("fast");
    const record = JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord;
    expect(record.identity.tier_reason).toMatch(/--tier fast/);
  });
});

describe("a skip run (A3)", () => {
  it("runs no query, writes a skipped record with the reason, prints the reason and exits 0", async () => {
    const fake = createFakeSdkClient(script(fx));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync(
        args(join(outRoot, "skip"), "--tier", "skip", "--format", "json"),
      ),
    );
    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    const doc = JSON.parse(stdout);
    expect(doc).toMatchObject({ tier: "skip", verdict: "skipped", findings: [] });
    const record = JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord;
    expect(RecordSchema.safeParse(record).success).toBe(true);
    expect(record.posted.verdict).toBe("skipped");
    expect(record.identity.tier).toBe("skip");
    expect(record.identity.tier_reason).toBe("Tier set by --tier skip.");
    expect(record.identity.triage).toBeNull();
    expect(record.identity.selected_reviewers).toEqual([]);
    expect(record.stages.reviewers).toEqual([]);
    expect(record.cost.queries).toEqual([]);
    expect(stderr).toContain("Tier set by --tier skip.");
  });

  it("prints the reason in the table too", async () => {
    const fake = createFakeSdkClient(script(fx));
    expect(
      await exitCodeOf(
        createProgram({ client: fake }).parseAsync(
          args(join(outRoot, "skip-table"), "--tier", "skip"),
        ),
      ),
    ).toBe(0);
    expect(stdout).toContain("skipped");
    expect(stdout).toContain("Tier set by --tier skip.");
  });
});

describe("the repo config on the base commit (R3)", () => {
  const fixtures: Fixture[] = [];
  afterAll(() => {
    for (const f of fixtures) rmSync(f.repo, { recursive: true, force: true });
  });

  it("exits 1 on an invalid config, writes no record, and names the file and the field", async () => {
    const bad = await fixtureWithConfig("thresholds:\n  default: 150\n");
    fixtures.push(bad);
    const fake = createFakeSdkClient(script(bad));
    const out = join(outRoot, "bad-config");
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync(argsFor(bad, out, "--format", "json")),
    );
    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toContain(".pr-review/config.yaml");
    expect(stderr).toContain("thresholds.default");
  }, 30_000);

  it("lists a reviewer that the config disables under reviewers_skipped, not reviewers_ran", async () => {
    const off = await fixtureWithConfig("reviewers:\n  diff-bugs:\n    enabled: false\n");
    fixtures.push(off);
    const fake = createFakeSdkClient(script(off));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync(
        argsFor(off, join(outRoot, "disabled"), "--format", "json"),
      ),
    );
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.coverage.reviewers_skipped).toEqual([
      { name: "diff-bugs", reason: "disabled by config" },
    ]);
    expect(doc.coverage.reviewers_ran).not.toContain("diff-bugs");
    const record = JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord;
    expect(RecordSchema.safeParse(record).error).toBeUndefined();
    expect(record.posted.coverage.reviewers_skipped).toEqual([
      { name: "diff-bugs", reason: "disabled by config" },
    ]);
    expect(record.posted.coverage.reviewers_ran).not.toContain("diff-bugs");
    expect(record.identity.selected_reviewers.map((r) => r.name)).not.toContain("diff-bugs");
    expect(fake.calls.filter((c) => c.reviewerName === "diff-bugs")).toEqual([]);
    expect(record.identity.config_hash).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);
});

describe("--author-write-access (R7)", () => {
  let trustedFx: Fixture;
  beforeAll(async () => {
    const source = mkdtempSync(join(tmpdir(), "pr-review-cli-bash-"));
    try {
      mkdirSync(join(source, "dir", "reviewers"), { recursive: true });
      writeFileSync(
        join(source, "dir", "reviewers", "shell-check.md"),
        [
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
          "trusted: true",
          "---",
          "You check shell use.",
          "",
        ].join("\n"),
      );
      trustedFx = await makeFixture("--pr-review-dir", join(source, "dir"));
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  }, 30_000);
  afterAll(() => {
    if (trustedFx) rmSync(trustedFx.repo, { recursive: true, force: true });
  });

  async function shellCall(...extra: string[]) {
    const fake = createFakeSdkClient(script(trustedFx));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync(
        argsFor(
          trustedFx,
          join(outRoot, `bash-${extra.length}`),
          "--format",
          "json",
          "--tier",
          "fast",
          ...extra,
        ),
      ),
    );
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    stdout = "";
    return { call: fake.calls.find((c) => c.reviewerName === "shell-check"), doc };
  }

  it("grants Bash to a trusted custom reviewer only with the option", async () => {
    const without = await shellCall();
    expect(without.call?.bash).not.toBe(true);
    expect(without.doc.coverage.reviewers_without_bash).toEqual([
      { name: "shell-check", reason: "author has no write access" },
    ]);
    const withOption = await shellCall("--author-write-access");
    expect(withOption.call?.bash).toBe(true);
    expect(withOption.doc.coverage.reviewers_without_bash).toEqual([]);
  }, 30_000);

  async function prShellCall(seed: FakePullRequestSeed, ...extra: string[]) {
    const fake = createFakeSdkClient(script(trustedFx));
    const github = prFor(trustedFx, seed);
    const code = await exitCodeOf(
      createProgram({ client: fake, github }).parseAsync(
        prArgs(
          trustedFx,
          join(outRoot, `bash-pr-${extra.length}-${String(seed.fork)}`),
          "--format",
          "json",
          "--tier",
          "fast",
          ...extra,
        ),
      ),
    );
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    stdout = "";
    const record = JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord;
    return { call: fake.calls.find((c) => c.reviewerName === "shell-check"), doc, record };
  }

  it("takes write access from the permission of the author with --pr (R2)", async () => {
    const write = await prShellCall({ permission: "write" });
    expect(write.call?.bash).toBe(true);
    expect(write.record.identity.github?.author_write_access).toBe(true);
    const read = await prShellCall({ permission: "read" });
    expect(read.call?.bash).not.toBe(true);
    expect(read.record.identity.github?.author_write_access).toBe(false);
  }, 30_000);

  it("gives no Bash for a fork pull request, even with the flag and admin (R2)", async () => {
    const fork = await prShellCall(
      { fork: true, head_repo: "eve/widgets", permission: "admin" },
      "--author-write-access",
    );
    expect(fork.call?.bash).not.toBe(true);
    expect(fork.record.identity.github?.author_write_access).toBe(false);
    expect(fork.record.identity.github?.fork).toBe(true);
    expect(fork.doc.coverage.reviewers_without_bash).toEqual([
      { name: "shell-check", reason: "author has no write access" },
    ]);
  }, 30_000);
});

describe("the repo config changes the run (the charter's two runs)", () => {
  const CONFIG = [
    "reviewers:",
    "  history:",
    "    enabled: false",
    "suppressions:",
    "  - reviewer: conventions",
    "    category: convention",
    "    reason: The linter owns style.",
    "",
  ].join("\n");

  // diff-bugs reports the planted bug. conventions reports a convention
  // nit on line 1. The other reviewers report nothing.
  function twoFindingScript(fixture: Fixture) {
    const base = script(fixture);
    return (req: QueryRequest): QueryOutcome<unknown> => {
      if (req.role === "reviewer") {
        const planted = base(req);
        if (req.reviewerName === "diff-bugs") return planted;
        if (req.reviewerName !== "conventions") {
          return { ok: true, output: { findings: [] }, raw: META };
        }
        return {
          ok: true,
          output: {
            findings: [
              {
                file: fixture.file,
                start_line: 1,
                end_line: 1,
                category: "convention",
                severity_estimate: "nit",
                confidence: "high",
                claim: "CLAIM-convention",
                evidence: "export function sum(values: number[]): number {",
                explanation: "e",
                needs_context: false,
              },
            ],
          },
          raw: META,
        };
      }
      if (req.role === "verifier" || req.role === "verifier-escalation") {
        const verified = base(req) as { output: Record<string, unknown> };
        return {
          ok: true,
          output: {
            ...verified.output,
            quotes: ["export function sum", "i <= values.length"],
            severity: "suggestion",
          },
          raw: META,
        } as QueryOutcome<unknown>;
      }
      return base(req);
    };
  }

  async function review(fixture: Fixture, name: string) {
    const fake = createFakeSdkClient(twoFindingScript(fixture));
    const code = await exitCodeOf(
      createProgram({ client: fake }).parseAsync(
        argsFor(fixture, join(outRoot, name), "--format", "json"),
      ),
    );
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    stdout = "";
    const record = JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord;
    expect(RecordSchema.safeParse(record).error).toBeUndefined();
    return { doc, record };
  }

  it("differs in the reviewers that ran, the posted findings, the suppressed list and the hash", async () => {
    const configured = await fixtureWithConfig(CONFIG);
    try {
      const first = await review(fx, "two-runs-1");
      const second = await review(configured, "two-runs-2");

      // The reviewers that ran differ: the second run lacks history.
      expect(first.record.posted.coverage.reviewers_ran).toContain("history");
      expect(second.record.posted.coverage.reviewers_ran).not.toContain("history");
      expect(second.record.posted.coverage.reviewers_ran).toHaveLength(
        first.record.posted.coverage.reviewers_ran.length - 1,
      );
      expect(second.doc.coverage.reviewers_skipped).toEqual([
        { name: "history", reason: "disabled by config" },
      ]);

      // The first run posts both findings and suppresses none.
      expect(first.record.posted.findings.map((f) => f.claim).sort()).toEqual([
        "CLAIM-convention",
        "CLAIM-off-by-one",
      ]);
      expect(first.record.stages.suppressed).toEqual([]);

      // The second run omits the suppressed finding and records it with its rule.
      expect(second.record.posted.findings.map((f) => f.claim)).toEqual(["CLAIM-off-by-one"]);
      expect(second.doc.findings.map((f: { claim: string }) => f.claim)).toEqual([
        "CLAIM-off-by-one",
      ]);
      expect(second.record.stages.suppressed).toHaveLength(1);
      expect(second.record.stages.suppressed[0]).toMatchObject({
        reviewer: "conventions",
        finding: { claim: "CLAIM-convention", category: "convention", start_line: 1 },
        rule: { reviewer: "conventions", category: "convention", reason: "The linter owns style." },
      });

      // The hash follows spec R4: the path, one newline, the bytes. One file here.
      const expected = createHash("sha256")
        .update(Buffer.from(`.pr-review/config.yaml\n${CONFIG}`, "utf8"))
        .digest("hex");
      expect(second.record.identity.config_hash).toBe(expected);
      expect(first.record.identity.config_hash).toBeNull();
    } finally {
      rmSync(configured.repo, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("--pr (R2)", () => {
  async function prRun(github: ReturnType<typeof prFor>, name: string, ...extra: string[]) {
    const fake = createFakeSdkClient(script(fx));
    const code = await exitCodeOf(
      createProgram({ client: fake, github }).parseAsync(
        prArgs(fx, join(outRoot, name), "--format", "json", ...extra),
      ),
    );
    const doc = code === 0 ? JSON.parse(stdout) : null;
    stdout = "";
    const record =
      doc === null ? null : (JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord);
    if (record) expect(RecordSchema.safeParse(record).error).toBeUndefined();
    return { code, doc, record, fake };
  }

  it("takes --base and --head from the pull request and records the PR identity", async () => {
    const github = prFor(fx);
    const { code, record } = await prRun(github, "pr-defaults", "--tier", "skip");
    expect(code).toBe(0);
    expect(record?.identity.base).toBe(fx.base);
    expect(record?.identity.head).toBe(fx.head);
    expect(record?.identity.pr).toBe(7);
    expect(record?.identity.github).toEqual({
      slug: "acme/widgets",
      title: "Add average",
      draft: false,
      labels: ["bug"],
      author: "alice",
      author_type: "User",
      author_write_access: true,
      fork: false,
      head_repo: "acme/widgets",
      url: "https://github.com/acme/widgets/pull/7",
    });
    expect(record?.identity.description).toBe("Add average\n\nAdds an average function.");
    expect(record?.identity.description_meta).toEqual({
      source: "pr",
      sanitized: false,
      truncated: false,
    });
    expect(github.calls).toContainEqual({ method: "resolveSlug", input: { repo: fx.repo } });
    expect(github.calls).toContainEqual({
      method: "getPullRequest",
      input: { slug: "acme/widgets", number: 7 },
    });
  });

  it("keeps --base and --head when they are given", async () => {
    const github = prFor(fx, { base_sha: "1".repeat(40), head_sha: "2".repeat(40) });
    const { code, record } = await prRun(
      github,
      "pr-explicit",
      "--tier",
      "skip",
      "--base",
      fx.base,
      "--head",
      fx.head,
    );
    expect(code).toBe(0);
    expect(record?.identity.base).toBe(fx.base);
    expect(record?.identity.head).toBe(fx.head);
  });

  it("uses --github-repo over the slug of the checkout", async () => {
    const github = prFor(fx);
    const { code, record } = await prRun(
      github,
      "pr-slug",
      "--tier",
      "skip",
      "--github-repo",
      "other/place",
    );
    expect(code).toBe(0);
    expect(record?.identity.github?.slug).toBe("other/place");
    expect(github.calls.map((c) => c.method)).not.toContain("resolveSlug");
    expect(github.calls).toContainEqual({
      method: "getPullRequest",
      input: { slug: "other/place", number: 7 },
    });
  });

  it("exits 2 on --format github without --pr, and runs nothing", async () => {
    const fake = createFakeSdkClient(script(fx));
    const github = prFor(fx);
    const out = join(outRoot, "github-no-pr");
    const code = await exitCodeOf(
      createProgram({ client: fake, github }).parseAsync(args(out, "--format", "github")),
    );
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("prints the JSON document with --format github and --pr", async () => {
    const fake = createFakeSdkClient(script(fx));
    const code = await exitCodeOf(
      createProgram({ client: fake, github: prFor(fx) }).parseAsync(
        prArgs(fx, join(outRoot, "github-format"), "--format", "github", "--tier", "skip"),
      ),
    );
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc).toMatchObject({ tier: "skip", verdict: "skipped" });
    expect(typeof doc.record_path).toBe("string");
  });

  it("exits 2 without --base or --head when --pr is absent", async () => {
    for (const drop of ["--base", "--head"]) {
      const full = args(join(outRoot, `missing${drop}`));
      const at = full.indexOf(drop);
      full.splice(at, 2);
      const fake = createFakeSdkClient(script(fx));
      expect(await exitCodeOf(createProgram({ client: fake }).parseAsync(full))).toBe(2);
      expect(fake.calls).toEqual([]);
    }
  });

  it("exits 2 on a --pr that is not a positive integer, or a bad --github-repo", async () => {
    for (const bad of [
      ["--pr", "abc"],
      ["--pr", "0"],
      ["--pr", "1.5"],
      ["--pr", "7", "--github-repo", "no-slash"],
    ]) {
      const fake = createFakeSdkClient(script(fx));
      const argv = [
        "node",
        "pr-review",
        "run",
        "--repo",
        fx.repo,
        "--out",
        join(outRoot, "bad-pr"),
        ...bad,
      ];
      expect(
        await exitCodeOf(createProgram({ client: fake, github: prFor(fx) }).parseAsync(argv)),
      ).toBe(2);
      expect(fake.calls).toEqual([]);
    }
  });

  it("exits 1 when GitHub fails, and names the endpoint", async () => {
    const github = prFor(fx);
    github.failNext(
      "getPullRequest",
      new GitHubError({
        endpoint: "repos/acme/widgets/pulls/7",
        exitCode: 4,
        message: "gh api repos/acme/widgets/pulls/7 failed with exit code 4: Bad credentials",
      }),
    );
    const { code } = await prRun(github, "pr-gh-fails");
    expect(code).toBe(1);
    expect(stderr).toContain("repos/acme/widgets/pulls/7");
  });

  it("gives the skip tier for a draft with skip.draft: true, and names the rule (R4)", async () => {
    const draftFx = await fixtureWithConfig("skip:\n  draft: true\n");
    try {
      const fake = createFakeSdkClient(script(draftFx));
      const code = await exitCodeOf(
        createProgram({ client: fake, github: prFor(draftFx, { draft: true }) }).parseAsync(
          prArgs(draftFx, join(outRoot, "pr-draft"), "--format", "json"),
        ),
      );
      expect(code).toBe(0);
      const doc = JSON.parse(stdout);
      expect(doc).toMatchObject({ tier: "skip", verdict: "skipped" });
      const record = JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord;
      expect(record.identity.tier).toBe("skip");
      expect(record.identity.tier_reason).toContain("skip.draft");
      expect(record.identity.github?.draft).toBe(true);
      expect(fake.calls).toEqual([]);
      expect(stderr).toContain("skip.draft");
    } finally {
      rmSync(draftFx.repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("gives the tier floor full for the label review:full alone, with no fresh flag (R4)", async () => {
    const { code, record, fake } = await prRun(
      prFor(fx, { labels: ["review:full"] }),
      "pr-review-full",
    );
    expect(code).toBe(0);
    expect(record?.identity.tier).toBe("full");
    expect(record?.identity.tier_reason).toContain("review:full");
    expect(record?.identity.tier_reason).toMatch(/floor of full/);
    // The run is a normal review: triage and the reviewers run.
    expect(fake.calls.some((c) => c.role === "triage")).toBe(true);
    expect(fake.calls.some((c) => c.role === "reviewer")).toBe(true);
  });

  it("gives fast for the label review:fast, over the sensitive floor (R4)", async () => {
    const { code, record } = await prRun(prFor(fx, { labels: ["review:fast"] }), "pr-fast");
    expect(code).toBe(0);
    expect(record?.identity.sensitive_files.length).toBeGreaterThan(0);
    expect(record?.identity.tier).toBe("fast");
    expect(record?.identity.tier_reason).toContain("review:fast");
  });
});
