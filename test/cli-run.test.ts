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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { GitHubError } from "../src/github/client.js";
import { createFakeGitHubClient, type FakePullRequestSeed } from "../src/github/fake.js";
import {
  formatFingerprintMarker,
  formatRunMarker,
  parseFingerprintMarkers,
  parseRunMarker,
} from "../src/github/markers.js";
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

// The findings of the three-run test, on src/stats.ts of the fixture. A
// and D are in the hunk (lines 5 to 15). B is outside the diff. C starts
// before the hunk and ends in it, so it crosses the edge of the hunk.
const GH_FINDINGS = [
  {
    claim: "CLAIM-A",
    start: 11,
    end: 11,
    severity: "blocking",
    evidence: "for (let i = 0; i <= values.length; i++) {",
  },
  {
    claim: "CLAIM-D",
    start: 14,
    end: 14,
    severity: "suggestion",
    evidence: "return total / values.length;",
  },
  {
    claim: "CLAIM-B",
    start: 1,
    end: 1,
    severity: "blocking",
    evidence: "export function sum(values: number[]): number {",
  },
  {
    claim: "CLAIM-C",
    start: 3,
    end: 6,
    severity: "suggestion",
    evidence: "for (let i = 0; i < values.length; i++) {",
  },
] as const;

// diff-bugs reports the four findings. The verifier passes each one with
// its severity and a quote from the head file.
function githubScript(fixture: Fixture) {
  const base = script(fixture);
  return (req: QueryRequest): QueryOutcome<unknown> => {
    const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
    if (req.role === "reviewer") {
      if (req.reviewerName !== "diff-bugs") return out({ findings: [] });
      return out({
        findings: GH_FINDINGS.map((f) => ({
          file: "src/stats.ts",
          start_line: f.start,
          end_line: f.end,
          category: "bug",
          severity_estimate: f.severity,
          confidence: "high",
          claim: f.claim,
          evidence: f.evidence,
          explanation: "e",
          needs_context: false,
        })),
      });
    }
    if (req.role === "verifier" || req.role === "verifier-escalation") {
      const f = GH_FINDINGS.find((g) => req.userMessage.includes(`"claim": "${g.claim}"`));
      if (!f) throw new Error("unknown finding");
      return out({
        in_scope: true,
        claim_holds: true,
        introduced_by_pr: true,
        quotes: [f.evidence],
        rationale: "r",
        score: 95,
        severity: f.severity,
      });
    }
    return base(req);
  };
}

describe("--format github (R5, R5a, R6)", () => {
  async function githubRun(
    fixture: Fixture,
    github: ReturnType<typeof prFor>,
    script: (req: QueryRequest) => QueryOutcome<unknown>,
    name: string,
  ) {
    const sdk = createFakeSdkClient(script);
    const code = await exitCodeOf(
      createProgram({ client: sdk, github }).parseAsync(
        prArgs(fixture, join(outRoot, name), "--format", "github"),
      ),
    );
    const text = stdout;
    stdout = "";
    const doc = text.trim() === "" ? null : JSON.parse(text);
    const record =
      doc === null ? null : (JSON.parse(readFileSync(doc.record_path, "utf8")) as RunRecord);
    if (record) expect(RecordSchema.safeParse(record).error).toBeUndefined();
    return { code, doc, record, sdk };
  }

  const fp = (record: RunRecord | null, claim: string) =>
    record?.posted.findings.find((f) => f.claim === claim)?.fingerprint ?? "missing";

  describe("the three-run test", () => {
    it("first run: one COMMENT review on the head with the marker, the lines, inline and body findings", async () => {
      const github = prFor(fx);
      const { code, doc, record } = await githubRun(fx, github, githubScript(fx), "three-run-1");
      expect(code).toBe(0);

      // One review, made with the create-review call, whose event is COMMENT.
      expect(github.calls.filter((c) => c.method === "createReview")).toHaveLength(1);
      expect(github.state.reviews).toHaveLength(1);
      const review = github.state.reviews[0]!;
      expect(review.commit_id).toBe(fx.head);

      const lines = review.body.split("\n");
      const runId = basename(doc.record_path, ".json");
      const marker = { run: runId, head: fx.head, base: fx.base, tier: "full" as const };
      expect(lines[0]?.startsWith(formatRunMarker(marker))).toBe(true);
      expect(parseRunMarker(review.body)).toEqual(marker);
      expect(lines[0]).toContain("**Would request changes**");
      expect(lines[0]).toContain(record?.identity.tier_reason ?? "missing");
      expect(lines[1]).toContain("Blocking: 2");
      expect(lines[1]).toContain("Suggestions: 2");
      expect(lines[1]).toContain("Nits: 0");
      expect(lines[1]).toContain("Coverage: reviewers ran:");
      expect(review.body).toContain(`pr-review ${record?.identity.tool_version}`);

      // One inline comment per in-diff finding, each with its fingerprint marker.
      const inline = [...github.state.review_comments].sort(
        (a, b) => (a.line ?? 0) - (b.line ?? 0),
      );
      expect(inline.map((c) => [c.path, c.line, c.review_id])).toEqual([
        ["src/stats.ts", 11, review.id],
        ["src/stats.ts", 14, review.id],
      ]);
      expect(parseFingerprintMarkers(inline[0]?.body ?? "")).toEqual([fp(record, "CLAIM-A")]);
      expect(parseFingerprintMarkers(inline[1]?.body ?? "")).toEqual([fp(record, "CLAIM-D")]);
      expect(review.body).not.toContain("CLAIM-A");
      expect(review.body).not.toContain("CLAIM-D");

      // A body entry with a permalink for the finding outside the diff.
      expect(lines).toContain("### Findings outside the diff");
      const outside = lines.find((l) => l.includes("CLAIM-B")) ?? "";
      expect(outside).toContain(
        `https://github.com/acme/widgets/blob/${fx.head}/src/stats.ts#L1-L1`,
      );
      expect(outside).toContain(formatFingerprintMarker(fp(record, "CLAIM-B")));
      // A body entry for the span that crosses the edge of the hunk.
      const edge = lines.find((l) => l.includes("CLAIM-C")) ?? "";
      expect(edge).toContain(`https://github.com/acme/widgets/blob/${fx.head}/src/stats.ts#L3-L6`);
      expect(edge).toContain(formatFingerprintMarker(fp(record, "CLAIM-C")));

      // The stdout holds the JSON document and the review url.
      expect(doc.review_url).toBe(review.url);
      expect(doc.verdict).toBe("would request changes");
      expect(record?.posted.github).toMatchObject({
        review_id: review.id,
        review_url: review.url,
        error: null,
        in_body: expect.arrayContaining([fp(record, "CLAIM-B"), fp(record, "CLAIM-C")]),
        check_run: { id: github.state.check_runs[0]?.id },
        cleanup_comment_id: null,
        resolved: [],
        errors: [],
      });
      expect(record?.posted.github?.inline).toHaveLength(2);
      expect(github.state.check_runs).toHaveLength(1);
      expect(basename(doc.record_path)).toBe(`${runId}.json`);
    }, 60_000);
  });

  it("retries once with a body-only review when the first create-review call fails", async () => {
    const github = prFor(fx);
    github.failNext(
      "createReview",
      new GitHubError({
        endpoint: "repos/acme/widgets/pulls/7/reviews",
        exitCode: 1,
        message: "422",
      }),
    );
    const { code, doc, record } = await githubRun(fx, github, githubScript(fx), "gh-retry");
    expect(code).toBe(0);
    expect(github.calls.filter((c) => c.method === "createReview")).toHaveLength(2);
    expect(github.state.reviews).toHaveLength(1);
    expect(github.state.review_comments).toEqual([]);
    const body = github.state.reviews[0]?.body ?? "";
    for (const claim of ["CLAIM-A", "CLAIM-B", "CLAIM-C", "CLAIM-D"]) expect(body).toContain(claim);
    expect(record?.posted.github?.inline).toEqual([]);
    expect(record?.posted.github?.in_body).toHaveLength(4);
    expect(doc.review_url).toBe(github.state.reviews[0]?.url);
  }, 60_000);

  it("records posted.github.error, writes the record and exits 1 when both calls fail", async () => {
    const github = prFor(fx);
    const fail = () =>
      new GitHubError({
        endpoint: "repos/acme/widgets/pulls/7/reviews",
        exitCode: 1,
        message: "gh api repos/acme/widgets/pulls/7/reviews failed with exit code 1: HTTP 502",
      });
    github.failNext("createReview", fail());
    github.failNext("createReview", fail());
    const { code, doc, record } = await githubRun(fx, github, githubScript(fx), "gh-double");
    expect(code).toBe(1);
    expect(record?.posted.github?.error).toContain("HTTP 502");
    expect(record?.posted.github?.review_id).toBeNull();
    expect(record?.posted.github?.check_run).toBeNull();
    expect(doc.review_url).toBeNull();
    expect(github.state.reviews).toEqual([]);
    expect(github.state.check_runs).toEqual([]);
    expect(stderr).toContain("HTTP 502");
  }, 60_000);

  it("R5a: posts a failure review with status=failed, writes the record and exits 1", async () => {
    const github = prFor(fx);
    const broken = (req: QueryRequest): QueryOutcome<unknown> => {
      // An output that breaks the find stage makes the run throw there.
      if (req.role === "reviewer") return { ok: true, output: { findings: null }, raw: META };
      return githubScript(fx)(req);
    };
    const { code, record } = await githubRun(fx, github, broken, "gh-r5a");
    expect(code).toBe(1);
    expect(github.state.reviews).toHaveLength(1);
    const body = github.state.reviews[0]?.body ?? "";
    const marker = parseRunMarker(body);
    expect(marker).toMatchObject({ head: fx.head, base: fx.base, tier: "full", status: "failed" });
    expect(body.split("\n")[1]).toMatch(/^pr-review failed at find_verify: /);
    expect(body.split("\n")).toHaveLength(2);
    expect(github.state.review_comments).toEqual([]);
    expect(github.state.check_runs).toEqual([]);
    expect(github.state.issue_comments).toEqual([]);
    // The record exists, with no posted.github and the error of the stage.
    expect(record?.posted.github).toBeNull();
    expect(record?.posted.verdict).toBe("incomplete");
    expect(record?.cost.errors).toContainEqual({
      stage: "find_verify",
      message: expect.any(String),
    });

    // A second run on the same head is a first run.
    const second = await githubRun(fx, github, githubScript(fx), "gh-r5a-2");
    expect(second.code).toBe(0);
    expect(github.state.reviews).toHaveLength(2);
    const next = parseRunMarker(github.state.reviews[1]?.body ?? "");
    expect(next).toMatchObject({ head: fx.head, tier: "full" });
    expect(next?.status).toBeUndefined();
    expect(github.state.check_runs).toHaveLength(1);
  }, 60_000);

  it("R5a: gives tier=unknown when the run fails before the tier, and writes no record", async () => {
    const github = prFor(fx, { base_sha: "0".repeat(40) });
    const out = join(outRoot, "gh-unknown");
    const sdk = createFakeSdkClient(githubScript(fx));
    const code = await exitCodeOf(
      createProgram({ client: sdk, github }).parseAsync(prArgs(fx, out, "--format", "github")),
    );
    expect(code).toBe(1);
    expect(sdk.calls).toEqual([]);
    expect(github.state.reviews).toHaveLength(1);
    const body = github.state.reviews[0]?.body ?? "";
    expect(parseRunMarker(body)).toMatchObject({
      head: fx.head,
      base: "0".repeat(40),
      tier: "unknown",
      status: "failed",
    });
    expect(body).toContain("pr-review failed at config: ");
    expect(existsSync(out)).toBe(false);
  });

  it("posts the one-line skip review once per reason", async () => {
    const github = prFor(fx, { labels: ["review:skip"] });
    const first = await githubRun(fx, github, githubScript(fx), "gh-skip-1");
    expect(first.code).toBe(0);
    expect(github.state.reviews).toHaveLength(1);
    const body = github.state.reviews[0]?.body ?? "";
    expect(body.split("\n")).toHaveLength(1);
    expect(parseRunMarker(body)?.tier).toBe("skip");
    expect(body).toContain("Label review:skip sets the tier skip.");
    expect(first.doc.review_url).toBe(github.state.reviews[0]?.url);
    expect(github.state.check_runs).toHaveLength(1);

    const second = await githubRun(fx, github, githubScript(fx), "gh-skip-2");
    expect(second.code).toBe(0);
    expect(github.state.reviews).toHaveLength(1);
    expect(github.state.check_runs).toHaveLength(1);
    expect(second.record?.posted.github).toBeNull();
    expect(second.doc.review_url).toBeNull();
  }, 60_000);

  it("posts a full first-run review after a skip run at the same head", async () => {
    const github = prFor(fx, { labels: ["review:skip"] });
    await githubRun(fx, github, githubScript(fx), "gh-skip-then-full-1");
    github.state.pr.labels = [];
    const { code, record } = await githubRun(fx, github, githubScript(fx), "gh-skip-then-full-2");
    expect(code).toBe(0);
    expect(github.state.reviews).toHaveLength(2);
    const full = github.state.reviews[1]?.body ?? "";
    expect(parseRunMarker(full)?.tier).toBe("full");
    expect(full).toContain("**Would request changes**");
    expect(github.state.review_comments).toHaveLength(2);
    expect(record?.posted.github?.review_id).toBe(github.state.reviews[1]?.id);
  }, 60_000);
});
