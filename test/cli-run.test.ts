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
import { basename, dirname, join } from "node:path";
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
import { recordFileName } from "../src/record/write.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

type Fixture = {
  repo: string;
  base: string;
  head: string;
  file: string;
  line: number;
  /** The heads of --second-push and --amend, or "". */
  head2: string;
  head3: string;
};

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
    head2: value("HEAD2"),
    head3: value("HEAD3"),
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
  // The viewer login comes from the fake client, also in GitHub Actions.
  vi.stubEnv("GITHUB_ACTIONS", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

/** The run id of a record: its file name without ".json". */
function recordRunIdOf(record: RunRecord): string {
  return recordFileName(new Date(record.identity.started_at), record.identity.head).replace(
    /\.json$/,
    "",
  );
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

// The findings at HEAD2 of the fixture (--second-push). The push changes
// line 14, so the span of D is gone. A is the same finding as before. E is
// new and blocking on the new line 14. F is new on line 10 and is only a
// suggestion. B is the same finding outside the diff as before.
const GH_FINDINGS_2 = [
  GH_FINDINGS[0],
  {
    claim: "CLAIM-E",
    start: 14,
    end: 14,
    severity: "blocking",
    evidence: "return values.length === 0 ? 0 : total / values.length;",
  },
  { claim: "CLAIM-F", start: 10, end: 10, severity: "suggestion", evidence: "let total = 0;" },
  GH_FINDINGS[2],
] as const;

// diff-bugs reports the four findings of the head: GH_FINDINGS at HEAD and
// GH_FINDINGS_2 at HEAD2 and HEAD3. The verifier passes each one with its
// severity and a quote from the head file.
function githubScript(fixture: Fixture) {
  const base = script(fixture);
  const all = [...GH_FINDINGS, ...GH_FINDINGS_2];
  return (req: QueryRequest): QueryOutcome<unknown> => {
    const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
    if (req.role === "reviewer") {
      if (req.reviewerName !== "diff-bugs") return out({ findings: [] });
      const pushed = readFileSync(join(req.cwd, "src/stats.ts"), "utf8").includes(
        "values.length === 0",
      );
      return out({
        findings: (pushed ? GH_FINDINGS_2 : GH_FINDINGS).map((f) => ({
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
      const f = all.find((g) => req.userMessage.includes(`"claim": "${g.claim}"`));
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
    options: { sdk?: ReturnType<typeof createFakeSdkClient>; extra?: string[] } = {},
  ) {
    const sdk = options.sdk ?? createFakeSdkClient(script);
    const code = await exitCodeOf(
      createProgram({ client: sdk, github }).parseAsync(
        prArgs(fixture, join(outRoot, name), "--format", "github", ...(options.extra ?? [])),
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
    // One fixture with HEAD, HEAD2 and HEAD3, one fake SDK client and one
    // fake GitHub client. All three runs write to one --out directory.
    let fx3: Fixture;
    let github: ReturnType<typeof prFor>;
    let sdk: ReturnType<typeof createFakeSdkClient>;
    let first: RunRecord;
    let second: RunRecord;
    beforeAll(async () => {
      fx3 = await makeFixture("--amend");
      github = prFor(fx3);
      sdk = createFakeSdkClient(githubScript(fx3));
    }, 30_000);
    afterAll(() => {
      if (fx3) rmSync(fx3.repo, { recursive: true, force: true });
    });
    const fpOf = (record: RunRecord, claim: string) =>
      [...record.posted.findings, ...record.posted.below_floor].find((f) => f.claim === claim)
        ?.fingerprint ?? "missing";

    it("first run: one COMMENT review on the head with the marker, the lines, inline and body findings", async () => {
      const { code, doc, record } = await githubRun(fx3, github, githubScript(fx3), "three-run", {
        sdk,
      });
      first = record!;
      expect(code).toBe(0);

      // One review, made with the create-review call, whose event is COMMENT.
      expect(github.calls.filter((c) => c.method === "createReview")).toHaveLength(1);
      expect(github.state.reviews).toHaveLength(1);
      const review = github.state.reviews[0]!;
      expect(review.commit_id).toBe(fx3.head);

      const lines = review.body.split("\n");
      const runId = basename(doc.record_path, ".json");
      const marker = { run: runId, head: fx3.head, base: fx3.base, tier: "full" as const };
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
        `https://github.com/acme/widgets/blob/${fx3.head}/src/stats.ts#L1-L1`,
      );
      expect(outside).toContain(formatFingerprintMarker(fp(record, "CLAIM-B")));
      // A body entry for the span that crosses the edge of the hunk.
      const edge = lines.find((l) => l.includes("CLAIM-C")) ?? "";
      expect(edge).toContain(`https://github.com/acme/widgets/blob/${fx3.head}/src/stats.ts#L3-L6`);
      expect(edge).toContain(formatFingerprintMarker(fp(record, "CLAIM-C")));

      // The stdout holds the JSON document and the review url.
      expect(doc.review_url).toBe(review.url);
      expect(doc.verdict).toBe("would request changes");
      expect(record?.posted.github).toMatchObject({
        review_id: review.id,
        review_url: review.url,
        author: "me",
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
      // With --pr, the record is in <out>/pr-<n>/.
      expect(basename(dirname(doc.record_path))).toBe("pr-7");
      expect(record?.identity.run_kind).toBe("first");
      expect(record?.identity.prior).toBeNull();
    }, 60_000);

    it("second run on HEAD2: only new blocking findings, a since line, one resolved thread", async () => {
      // A human gives the comment of A a thumbs-down. The PR moves to HEAD2.
      const commentOf = (claim: string) =>
        github.state.review_comments.find((c) =>
          c.body.includes(formatFingerprintMarker(fpOf(first, claim))),
        )!;
      github.react(commentOf("CLAIM-A").id, "-1", "alice");
      const threadD = commentOf("CLAIM-D").thread_id;
      github.state.pr.head_sha = fx3.head2;
      const callsBefore = sdk.calls.length;

      const { code, doc, record } = await githubRun(fx3, github, githubScript(fx3), "three-run", {
        sdk,
      });
      expect(code).toBe(0);
      second = record!;
      const runCalls = sdk.calls.slice(callsBefore);

      // One more review, on HEAD2, with the since line.
      expect(github.state.reviews).toHaveLength(2);
      const review = github.state.reviews[1]!;
      expect(review.commit_id).toBe(fx3.head2);
      expect(parseRunMarker(review.body)).toMatchObject({ head: fx3.head2, tier: "full" });
      expect(review.body).toContain(`Review of changes since ${fx3.head.slice(0, 7)}`);
      expect(doc.review_url).toBe(review.url);

      // Only the new blocking finding E posts. F is below the floor.
      expect(second.posted.findings.map((f) => f.claim)).toEqual(["CLAIM-E"]);
      expect(second.posted.below_floor.map((f) => f.claim)).toEqual(["CLAIM-F"]);
      const inline = github.state.review_comments.filter((c) => c.review_id === review.id);
      expect(inline.map((c) => parseFingerprintMarkers(c.body))).toEqual([
        [fpOf(second, "CLAIM-E")],
      ]);
      expect(review.body).not.toContain("CLAIM-F");

      // A (thumbs-down) and B (still open) do not post again.
      const fpA = fpOf(first, "CLAIM-A");
      const fpB = fpOf(first, "CLAIM-B");
      const fpC = fpOf(first, "CLAIM-C");
      const fpD = fpOf(first, "CLAIM-D");
      expect(
        [...second.posted.not_reposted].sort((a, b) => a.reason.localeCompare(b.reason)),
      ).toEqual([
        { fingerprint: fpA, reason: "dismissed" },
        { fingerprint: fpB, reason: "open" },
      ]);
      const markers = parseFingerprintMarkers(review.body);
      expect(markers).not.toContain(fpA);
      expect(markers).not.toContain(fpD);
      expect(review.body).not.toContain("CLAIM-A");
      expect(review.body).not.toContain("CLAIM-B");
      // The open body findings B and C stay listed as hidden markers only.
      expect(markers).toEqual(expect.arrayContaining([fpB, fpC]));
      expect(review.body).not.toContain("CLAIM-C");
      expect(second.posted.carried.map((f) => f.claim).sort()).toEqual(["CLAIM-B", "CLAIM-C"]);

      // The push removed the span of D, so its thread resolves with the reply.
      expect(second.posted.github?.resolved).toEqual([{ thread_id: threadD, fingerprint: fpD }]);
      const thread = await github.getThread({ thread_id: threadD });
      expect(thread.resolved).toBe(true);
      expect(thread.comments.at(-1)?.body).toBe(
        `Resolved by pr-review: the code this comment refers to changed at ${fx3.head2}.`,
      );

      // The prior state came from the record of the first run.
      expect(second.identity.run_kind).toBe("later");
      expect(second.identity.prior).toEqual({
        head: fx3.head,
        source: "record",
        record: first ? join(outRoot, "three-run", "pr-7", `${recordRunIdOf(first)}.json`) : null,
        open: [fpB, fpC, fpD].sort(),
        dismissed: [fpA],
        fetch_failed: false,
      });
      expect(second.posted.verdict).toBe("would request changes");

      // Triage reads the whole diff. The reviewers get only the new hunk.
      const triage = runCalls.filter((c) => c.role === "triage");
      expect(triage).toHaveLength(1);
      expect(triage[0]?.userMessage).toContain("+++ b/.github/workflows/ci.yml");
      const reviewers = runCalls.filter((c) => c.role === "reviewer");
      expect(reviewers.length).toBeGreaterThan(0);
      for (const c of reviewers) {
        expect(c.userMessage).not.toContain("+++ b/.github/workflows/ci.yml");
        expect(c.userMessage).toContain("+++ b/src/stats.ts");
      }
    }, 60_000);

    it("third run on HEAD3: the same tree, so it posts nothing and exits 0", async () => {
      github.state.pr.head_sha = fx3.head3;
      const callsBefore = sdk.calls.length;
      const { code, doc, record } = await githubRun(fx3, github, githubScript(fx3), "three-run", {
        sdk,
      });
      expect(code).toBe(0);
      expect(github.state.reviews).toHaveLength(2);
      expect(github.state.check_runs).toHaveLength(2);
      expect(record?.posted.github).toBeNull();
      expect(doc.review_url).toBeNull();
      expect(record?.identity.tier).toBe("skip");
      expect(sdk.calls.length).toBe(callsBefore);
      // H0 is HEAD2, from the record of the second run. The thread that the
      // tool resolved is neither open nor dismissed.
      const fpD = fpOf(first, "CLAIM-D");
      expect(record?.identity.run_kind).toBe("later");
      expect(record?.identity.prior?.head).toBe(fx3.head2);
      expect(record?.identity.prior?.source).toBe("record");
      expect(record?.identity.prior?.open).not.toContain(fpD);
      expect(record?.identity.prior?.dismissed).toEqual([fpOf(first, "CLAIM-A")]);
      expect(record?.identity.prior?.open).toContain(fpOf(second, "CLAIM-E"));
      expect(basename(dirname(doc.record_path))).toBe("pr-7");
      expect(record?.identity.tier_reason).toBe(`No new hunks since ${fx3.head2.slice(0, 7)}.`);
    }, 60_000);

    it("a labeled event for review:fast on the reviewed head posts nothing", async () => {
      github.state.pr.labels = ["review:fast"];
      const callsBefore = sdk.calls.length;
      const { code, record } = await githubRun(fx3, github, githubScript(fx3), "three-run", {
        sdk,
      });
      github.state.pr.labels = ["bug"];
      expect(code).toBe(0);
      expect(github.state.reviews).toHaveLength(2);
      expect(record?.posted.github).toBeNull();
      expect(record?.identity.tier).toBe("skip");
      expect(sdk.calls.length).toBe(callsBefore);
    }, 60_000);
  });

  describe("later runs on HEAD2 after a first run on HEAD", () => {
    let fx3: Fixture;
    beforeAll(async () => {
      fx3 = await makeFixture("--amend");
    }, 30_000);
    afterAll(() => {
      if (fx3) rmSync(fx3.repo, { recursive: true, force: true });
    });

    async function firstThenSecond(name: string, secondOut: string, ...extra: string[]) {
      const github = prFor(fx3);
      const firstRun = await githubRun(fx3, github, githubScript(fx3), name);
      github.state.pr.head_sha = fx3.head2;
      const sdk = createFakeSdkClient(githubScript(fx3));
      const secondRun = await githubRun(fx3, github, githubScript(fx3), secondOut, {
        sdk,
        extra,
      });
      return {
        github,
        first: firstRun.record!,
        second: secondRun.record!,
        sdk,
        code: secondRun.code,
      };
    }

    it("falls back to the review markers with no record, and says no prior record", async () => {
      const { github, first, second, code } = await firstThenSecond("marker-1", "marker-2");
      expect(code).toBe(0);
      expect(second.identity.run_kind).toBe("later");
      expect(second.identity.prior).toMatchObject({
        head: fx3.head,
        source: "marker",
        record: null,
        fetch_failed: false,
      });
      const review = github.state.reviews[1]!;
      expect(review.body.split("\n")[1]).toMatch(/; no prior record$/);
      // It dedupes against the comment fingerprints, resolves no thread, and
      // carries no full finding.
      const fpB = first.posted.findings.find((f) => f.claim === "CLAIM-B")?.fingerprint;
      expect(second.posted.not_reposted).toContainEqual({ fingerprint: fpB, reason: "open" });
      expect(second.posted.github?.resolved).toEqual([]);
      // The threads of A and D from the first run, and of E from this run.
      expect(github.state.threads.size).toBe(3);
      expect([...github.state.threads.values()].every((t) => !t.resolved)).toBe(true);
      expect(second.posted.carried).toEqual([]);
      expect(second.identity.tier_reason).not.toContain("prior record");
    }, 60_000);

    it("--fresh: a first run again with full scope and every severity, and no repost", async () => {
      const { first, second, sdk, code, github } = await firstThenSecond(
        "fresh-1",
        "fresh-1",
        "--fresh",
      );
      expect(code).toBe(0);
      expect(second.identity.run_kind).toBe("fresh");
      expect(second.identity.prior?.source).toBe("record");
      // Every severity posts.
      expect(second.posted.findings.map((f) => f.claim).sort()).toEqual(["CLAIM-E", "CLAIM-F"]);
      expect(second.posted.below_floor).toEqual([]);
      const fpB = first.posted.findings.find((f) => f.claim === "CLAIM-B")?.fingerprint;
      const fpA = first.posted.findings.find((f) => f.claim === "CLAIM-A")?.fingerprint;
      expect(second.posted.not_reposted).toEqual(
        expect.arrayContaining([
          { fingerprint: fpA, reason: "open" },
          { fingerprint: fpB, reason: "open" },
        ]),
      );
      // Full scope: the reviewers see the whole diff, and the body has no since line.
      const reviewers = sdk.calls.filter((c) => c.role === "reviewer");
      expect(reviewers.some((c) => c.userMessage.includes("+++ b/.github/workflows/ci.yml"))).toBe(
        true,
      );
      expect(github.state.reviews[1]?.body).not.toContain("Review of changes since");
    }, 60_000);
  });

  describe("a later run with no new hunk (R7)", () => {
    // Each test makes its own fixture, runs a first review on HEAD, then
    // adds a commit that only removes hunks, so no hunk is new.
    const fixtures: Fixture[] = [];
    afterAll(() => {
      for (const f of fixtures) rmSync(f.repo, { recursive: true, force: true });
    });

    // A blocking finding on line 11, in the hunk: an inline thread.
    const INLINE_A = GH_FINDINGS[0];
    // A blocking finding on lines 4 to 9. It starts before the hunk, so it
    // goes in the body. Its span holds the first line of "average".
    const BODY_G = {
      claim: "CLAIM-G",
      start: 4,
      end: 9,
      severity: "blocking",
      evidence: "export function average(values: number[]): number {",
    } as const;

    // diff-bugs reports "findings" at every head. The verifier passes each
    // one with its severity and its evidence as the quote.
    function findingsScript(
      fixture: Fixture,
      findings: readonly {
        claim: string;
        start: number;
        end: number;
        severity: string;
        evidence: string;
      }[],
    ) {
      const base = script(fixture);
      return (req: QueryRequest): QueryOutcome<unknown> => {
        const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
        if (req.role === "reviewer") {
          if (req.reviewerName !== "diff-bugs") return out({ findings: [] });
          return out({
            findings: findings.map((f) => ({
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
          const f = findings.find((g) => req.userMessage.includes(`"claim": "${g.claim}"`));
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

    // Commit the base text of each path on the feature branch of the
    // fixture. Give the new head sha.
    async function revertToBase(fixture: Fixture, paths: string[]): Promise<string> {
      const env = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      };
      const git = (...a: string[]) => run("git", ["-C", fixture.repo, ...a], { env });
      for (const path of paths) {
        const { stdout: text } = await git("show", `${fixture.base}:${path}`);
        writeFileSync(join(fixture.repo, path), text);
      }
      await git("commit", "--quiet", "-am", `Revert ${paths.join(", ")}`);
      return (await git("rev-parse", "HEAD")).stdout.trim();
    }

    async function firstRun(
      name: string,
      findings: Parameters<typeof findingsScript>[1],
    ): Promise<{ fixture: Fixture; github: ReturnType<typeof prFor>; first: RunRecord }> {
      const fixture = await makeFixture();
      fixtures.push(fixture);
      const github = prFor(fixture);
      const { code, record } = await githubRun(
        fixture,
        github,
        findingsScript(fixture, findings),
        name,
      );
      expect(code).toBe(0);
      expect(record?.posted.verdict).toBe("would request changes");
      return { fixture, github, first: record! };
    }

    it("resolves the thread whose hunk the push removes, and posts one short review that would approve", async () => {
      const { fixture, github, first } = await firstRun("no-new-thread", [INLINE_A]);
      const fpA = fp(first, "CLAIM-A");
      const threadA = github.state.review_comments.find((c) =>
        c.body.includes(formatFingerprintMarker(fpA)),
      )!.thread_id;

      // The push removes the hunk of "average", so no hunk is new.
      const head2 = await revertToBase(fixture, ["src/stats.ts"]);
      github.state.pr.head_sha = head2;
      const sdk = createFakeSdkClient(findingsScript(fixture, [INLINE_A]));
      const { code, doc, record } = await githubRun(
        fixture,
        github,
        findingsScript(fixture, [INLINE_A]),
        "no-new-thread",
        { sdk },
      );
      expect(code).toBe(0);
      expect(sdk.calls).toEqual([]);

      // The thread of A resolves with the reply.
      const thread = await github.getThread({ thread_id: threadA });
      expect(thread.resolved).toBe(true);
      expect(thread.comments.at(-1)?.body).toBe(
        `Resolved by pr-review: the code this comment refers to changed at ${head2}.`,
      );

      // One short review on the new head, at the tier of the prior record.
      expect(github.state.reviews).toHaveLength(2);
      const review = github.state.reviews[1]!;
      expect(review.commit_id).toBe(head2);
      expect(parseRunMarker(review.body)).toMatchObject({ head: head2, tier: "fast" });
      const lines = review.body.split("\n");
      expect(lines[0]).toContain("**Would approve**");
      expect(lines[0]).toContain(
        `No new hunks since ${fixture.head.slice(0, 7)}; 1 thread resolved.`,
      );
      expect(lines[1]).toContain("Blocking: 0");
      expect(lines[1]).toContain("Coverage: reviewers ran:");
      expect(review.body).toContain(`Review of changes since ${fixture.head.slice(0, 7)}`);
      expect(github.state.review_comments.filter((c) => c.review_id === review.id)).toEqual([]);
      expect(github.state.check_runs).toHaveLength(2);
      expect(doc.review_url).toBe(review.url);

      // A normal record: this head is now the last reviewed head.
      expect(record?.identity.run_kind).toBe("later");
      expect(record?.identity.tier).toBe("fast");
      expect(record?.posted.verdict).toBe("would approve");
      expect(record?.posted.findings).toEqual([]);
      expect(record?.posted.github?.review_id).toBe(review.id);
      expect(record?.posted.github?.resolved).toEqual([{ thread_id: threadA, fingerprint: fpA }]);
      expect(record?.posted.github?.check_run).toEqual({ id: github.state.check_runs[1]?.id });

      // A run on the same head takes it as H0 and posts nothing.
      const third = await githubRun(
        fixture,
        github,
        findingsScript(fixture, [INLINE_A]),
        "no-new-thread",
      );
      expect(third.code).toBe(0);
      expect(github.state.reviews).toHaveLength(2);
      expect(third.record?.identity.prior?.head).toBe(head2);
      expect(third.record?.identity.prior?.source).toBe("record");
      expect(third.record?.posted.github).toBeNull();
    }, 90_000);

    it("posts one short review when the push only drops a body finding", async () => {
      const { fixture, github, first } = await firstRun("no-new-body", [BODY_G]);
      expect(first.posted.github?.in_body).toEqual([fp(first, "CLAIM-G")]);

      const head2 = await revertToBase(fixture, ["src/stats.ts"]);
      github.state.pr.head_sha = head2;
      const { code, record } = await githubRun(
        fixture,
        github,
        findingsScript(fixture, [BODY_G]),
        "no-new-body",
      );
      expect(code).toBe(0);
      expect(github.state.reviews).toHaveLength(2);
      const review = github.state.reviews[1]!;
      expect(parseRunMarker(review.body)).toMatchObject({ head: head2, tier: "fast" });
      const line = review.body.split("\n")[0] ?? "";
      expect(line).toContain("**Would approve**");
      expect(line).toContain(
        `No new hunks since ${fixture.head.slice(0, 7)}; 1 body finding closed.`,
      );
      // The dropped body finding is not carried.
      expect(parseFingerprintMarkers(review.body)).toEqual([]);
      expect(record?.posted.github?.review_id).toBe(review.id);
      expect(record?.posted.github?.resolved).toEqual([]);
      expect(record?.posted.carried).toEqual([]);
    }, 90_000);

    it("posts nothing when the push removes no span of an open finding", async () => {
      const { fixture, github } = await firstRun("no-new-none", [INLINE_A]);
      // The push removes only the hunk of package-lock.json.
      const head2 = await revertToBase(fixture, ["package-lock.json"]);
      github.state.pr.head_sha = head2;
      const { code, doc, record } = await githubRun(
        fixture,
        github,
        findingsScript(fixture, [INLINE_A]),
        "no-new-none",
      );
      expect(code).toBe(0);
      expect(github.state.reviews).toHaveLength(1);
      expect(github.state.check_runs).toHaveLength(1);
      expect([...github.state.threads.values()].every((t) => !t.resolved)).toBe(true);
      expect(doc.review_url).toBeNull();
      expect(record?.identity.tier).toBe("skip");
      expect(record?.identity.tier_reason).toBe(`No new hunks since ${fixture.head.slice(0, 7)}.`);
      expect(record?.posted.github).toBeNull();
    }, 90_000);
  });

  it("falls back to a fresh run when H0 cannot be fetched, and says so in coverage", async () => {
    const github = prFor(fx);
    const h0 = "e".repeat(40);
    github.state.reviews.push({
      id: 1,
      body: `${formatRunMarker({ run: "old", head: h0, base: fx.base, tier: "full" })} old`,
      author: "me",
      commit_id: h0,
      url: "u",
      comments: [],
    });
    const { code, record } = await githubRun(fx, github, githubScript(fx), "fetch-fails");
    expect(code).toBe(0);
    expect(record?.identity.run_kind).toBe("fresh");
    expect(record?.identity.prior).toMatchObject({
      head: h0,
      source: "marker",
      fetch_failed: true,
    });
    expect(github.state.reviews).toHaveLength(2);
    const body = github.state.reviews[1]?.body ?? "";
    expect(body.split("\n")[1]).toContain("fresh run: could not fetch eeeeeee");
    expect(body).not.toContain("Review of changes since");
    // A fresh run posts every severity.
    expect(record?.posted.findings.map((f) => f.claim).sort()).toEqual([
      "CLAIM-A",
      "CLAIM-B",
      "CLAIM-C",
      "CLAIM-D",
    ]);
  }, 60_000);

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
    // A failure review does not make a later run.
    expect(second.record?.identity.run_kind).toBe("first");
    expect(second.record?.identity.prior).toBeNull();
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
    // A skip review does not make a later run.
    expect(record?.identity.run_kind).toBe("first");
    expect(record?.identity.prior).toBeNull();
  }, 60_000);
});
