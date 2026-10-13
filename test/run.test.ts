import { execFile } from "node:child_process";
import {
  existsSync,
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
import { createProgram } from "../src/cli.js";
import { runReview } from "../src/run.js";
import type { Finding } from "../src/schemas/finding.js";
import type { RunRecord } from "../src/schemas/record.js";
import type { TriageBrief } from "../src/schemas/triage.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

type Fixture = { repo: string; base: string; head: string; file: string; line: number };

async function makeFixture(): Promise<Fixture> {
  const { stdout } = await run("bash", [SCRIPT]);
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

  it("leaves the verdict alone when an escalation call is refused", async () => {
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
    expect(record.posted.findings).toHaveLength(1);
    expect(record.posted.verdict).toBe("would request changes");
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
