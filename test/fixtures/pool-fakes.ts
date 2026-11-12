// Fakes and a fixture case for the pool tests. The fake SDK client and
// the fake codex answer from a plan. A marker "MARK-<id>" in a claim
// selects the answer of an adjudication.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../../src/sdk/client.js";
import { createFakeSdkClient } from "../../src/sdk/fake.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The six fields of a finding that the pool keeps. */
export type Item = {
  file: string;
  start_line: number;
  end_line: number;
  category: string;
  claim: string;
  evidence: string;
};

/** The answer of one adjudication, or a failed call. */
export type Verdict = { score: number; start_line: number; end_line: number } | "fail";

/** A grouping answer for the items of one call, or a failed call. */
export type Grouper = (
  items: (Item & { id: string })[],
) => { groups: { members: string[]; representative: string }[] } | "fail";

/** The findings of one review call, or a failed call. A retry takes the next entry. */
export type ReviewAnswer = Item[] | "fail";

export type Plan = {
  claudeReviews?: ReviewAnswer[];
  gptReviews?: ReviewAnswer[];
  groupers?: Grouper[];
  claude?: Record<string, Verdict>;
  gpt?: Record<string, Verdict>;
};

export const META: QueryMeta = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0.01,
};

const FAILED: QueryOutcome<unknown> = {
  ok: false,
  failure: { kind: "subtype", message: "The result subtype is error_during_execution" },
  raw: META,
};

function markerOf(text: string): string {
  return /MARK-[A-Za-z0-9]+/.exec(text)?.[0] ?? "default";
}

/** The items of a grouping request: the JSON array in its items block. */
export function itemsIn(message: string): (Item & { id: string })[] {
  const match = /<(items_[0-9a-f]{16})>\n([\s\S]*?)\n<\/\1>/.exec(message);
  if (!match?.[2]) throw new Error("the grouping request has no items block");
  return JSON.parse(match[2]) as (Item & { id: string })[];
}

/** Group the items that share a "GROUP-<x>" tag. The last member represents a group. */
export const byTag: Grouper = (items) => {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = /GROUP-[A-Za-z0-9]+/.exec(item.claim)?.[0] ?? item.id;
    groups.set(key, [...(groups.get(key) ?? []), item.id]);
  }
  return {
    groups: [...groups.values()].map((members) => ({
      members,
      representative: members.at(-1) ?? "",
    })),
  };
};

/** Put every item in one group. */
export const allInOne: Grouper = (items) => ({
  groups: [{ members: items.map((i) => i.id), representative: items[0]?.id ?? "" }],
});

export const failGrouping: Grouper = () => "fail";

function verdictOutcome(v: Verdict | undefined): QueryOutcome<unknown> {
  const answer = v ?? { score: 0, start_line: 1, end_line: 1 };
  if (answer === "fail") return FAILED;
  return { ok: true, output: { ...answer, reason: "fake reason" }, raw: META };
}

/** A fake SDK client that answers each role from the plan. */
export function fakeClient(plan: Plan) {
  let review = 0;
  let group = 0;
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    if (req.role === "pool-reviewer") {
      const findings = plan.claudeReviews?.[review] ?? [];
      review += 1;
      return findings === "fail" ? FAILED : { ok: true, output: { findings }, raw: META };
    }
    if (req.role === "pool-grouper") {
      const grouper = plan.groupers?.[group] ?? byTag;
      group += 1;
      const out = grouper(itemsIn(req.userMessage));
      return out === "fail" ? FAILED : { ok: true, output: out, raw: META };
    }
    if (req.role === "adjudicator") {
      return verdictOutcome(plan.claude?.[markerOf(req.userMessage)]);
    }
    throw new Error(`unexpected role ${req.role}`);
  });
}

/** The error that the fake codex writes last to stderr when a call fails. */
export const CODEX_ERROR = "ERROR: You've hit your usage limit. Try again at 4:33 PM.";
/** The start of the long banner that the fake codex writes first to stderr. */
export const CODEX_BANNER = "CODEX-BANNER-START";

// The fake codex: a shell shim first on PATH that runs a node script. The
// script logs its argv and the kind of call (from the output schema), and
// writes the planned answer to the out file. A failed call writes a long
// banner and then an error to stderr, and exits 1, as the real codex does.
const SHIM_SCRIPT = `import { appendFileSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
const schemaPath = argv[argv.indexOf("--output-schema") + 1];
const out = argv[argv.indexOf("-o") + 1];
const schemaExists = existsSync(schemaPath);
const schema = schemaExists ? JSON.parse(readFileSync(schemaPath, "utf8")) : {};
const kind = schema.properties && schema.properties.findings ? "review" : "adjudicate";
appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ argv, kind, schemaExists }) + "\\n");
const prompt = argv.at(-1) ?? "";
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const fail = () => {
  process.stderr.write(${JSON.stringify(CODEX_BANNER)} + "x".repeat(3000) + "\\n" + ${JSON.stringify(CODEX_ERROR)} + "\\n");
  process.exit(1);
};
let answer;
if (kind === "review") {
  let n = 0;
  for (;; n++) {
    try { openSync(join(dir, "review-" + n), "wx"); break; } catch {}
  }
  const findings = (plan.gptReviews ?? [])[n] ?? [];
  if (findings === "fail") fail();
  answer = { findings };
} else {
  const marker = (prompt.match(/MARK-[A-Za-z0-9]+/) ?? ["default"])[0];
  const v = (plan.gpt ?? {})[marker] ?? { score: 0, start_line: 1, end_line: 1 };
  if (v === "fail") fail();
  answer = { ...v, reason: "fake reason" };
}
writeFileSync(out, JSON.stringify(answer));
`;

export type CodexCall = { argv: string[]; kind: "review" | "adjudicate"; schemaExists: boolean };

/** Put a fake codex first on PATH in "dir", with the plan. */
export function installCodex(dir: string, plan: Plan): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shim.mjs"), SHIM_SCRIPT);
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec node '${join(dir, "shim.mjs")}' "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(dir, "plan.json"),
    JSON.stringify({ gptReviews: plan.gptReviews, gpt: plan.gpt }),
  );
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_CODEX_DIR", dir);
}

/** The calls that the fake codex in "dir" got. */
export function codexCalls(dir: string): CodexCall[] {
  const path = join(dir, "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CodexCall);
}

/** The fixture repo and a case template made from it with make-case.sh. */
export type FixtureCase = { repo: string; template: string; file: string; line: number };

/** Make the fixture repo and the case "<name>" in "work", with source "pool". */
export async function makeFixtureCase(work: string, name: string): Promise<FixtureCase> {
  const { stdout } = await run("bash", [join(ROOT, "scripts/make-fixture.sh")]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  const repo = value("FIXTURE");
  const [file, line] = value("PLANTED").split(":");
  const templates = join(work, "templates");
  mkdirSync(templates, { recursive: true });
  await run(
    "bash",
    [join(ROOT, "scripts/make-case.sh"), repo, value("BASE"), value("HEAD"), name],
    {
      cwd: templates,
    },
  );
  const template = join(templates, name);
  const meta = JSON.parse(readFileSync(join(template, "case.json"), "utf8")) as Record<
    string,
    unknown
  >;
  meta.source = "pool";
  meta.title = "Add an average helper";
  meta.body = "This PR adds the average function.";
  writeFileSync(join(template, "case.json"), JSON.stringify(meta, null, 2));
  return { repo, template, file: file ?? "", line: Number(line) };
}

/** Capture stdout and stderr of the process while a test runs. */
export function captureOutput(): { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  return { stdout: () => out, stderr: () => err };
}

/** Run the CLI entry with "args", and give the exit code. */
export async function cli(
  client: ReturnType<typeof fakeClient>,
  ...args: string[]
): Promise<number> {
  process.exitCode = undefined;
  try {
    await createProgram({ client }).parseAsync(["node", "pr-review", ...args]);
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

/** The names in "dir", for a check that a run wrote nothing. */
export function namesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** The path of the record fixture. */
export const RECORD_FIXTURE = join(ROOT, "test/fixtures/pool-record.json");
