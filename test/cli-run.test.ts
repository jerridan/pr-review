import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
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
  return [
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
    ...extra,
  ];
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
