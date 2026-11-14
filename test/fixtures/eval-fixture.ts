// Helpers for the eval tests of D8: a fixture repo, a case made from it,
// the output of a command, and its exit code.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommanderError } from "commander";
import { afterEach, beforeEach, vi } from "vitest";
import type { GoldenFinding } from "../../src/eval/case.js";

const run = promisify(execFile);
const FIXTURE_SCRIPT = fileURLToPath(new URL("../../scripts/make-fixture.sh", import.meta.url));
const MAKE_CASE = fileURLToPath(new URL("../../scripts/make-case.sh", import.meta.url));

export type Fixture = { repo: string; base: string; head: string };

/** Make the fixture repo of scripts/make-fixture.sh. */
export async function makeFixture(): Promise<Fixture> {
  const { stdout } = await run("bash", [FIXTURE_SCRIPT]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  return { repo: value("FIXTURE"), base: value("BASE"), head: value("HEAD") };
}

/** Make a case template from the fixture in "root". It has no golden.json. */
export async function makeTemplate(fx: Fixture, root: string): Promise<string> {
  await run("bash", [MAKE_CASE, fx.repo, fx.base, fx.head, "template"], { cwd: root });
  return join(root, "template");
}

/** Write a cases directory with one case per name, each a copy of the template. */
export function casesFrom(
  template: string,
  root: string,
  specs: { name: string; golden: GoldenFinding[] }[],
): string {
  mkdirSync(root, { recursive: true });
  for (const spec of specs) {
    const dir = join(root, spec.name);
    cpSync(template, dir, { recursive: true });
    const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as Record<
      string,
      unknown
    >;
    meta.name = spec.name;
    writeFileSync(join(dir, "case.json"), JSON.stringify(meta));
    writeFileSync(join(dir, "golden.json"), JSON.stringify({ findings: spec.golden }));
  }
  return root;
}

/** A new temporary directory, removed by "cleanup". */
export function tempDir(label: string, made: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `pr-review-${label}-`));
  made.push(dir);
  return dir;
}

export function cleanup(made: string[]): void {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
}

/** The text that the program writes to stdout and stderr in a test. */
export const output = { stdout: "", stderr: "" };

/** Capture stdout and stderr for each test of the file. */
export function captureOutput(): void {
  beforeEach(() => {
    output.stdout = "";
    output.stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.stderr += String(chunk);
      return true;
    });
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
}

/** The exit code of a parseAsync call. */
export async function exitCodeOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}
