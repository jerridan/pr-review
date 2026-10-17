import { execFile } from "node:child_process";
import {
  cpSync,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCases } from "../src/eval/case.js";
import { cloneCase } from "../src/eval/checkout.js";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));
const MAKE_CASE = fileURLToPath(new URL("../scripts/make-case.sh", import.meta.url));
const FETCH_CASES = fileURLToPath(new URL("../scripts/fetch-cases.sh", import.meta.url));

// Do not let the user's git config change the result.
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

type Fixture = { repo: string; base: string; head: string; file: string; line: number };

async function makeFixture(): Promise<Fixture> {
  const { stdout } = await run("bash", [FIXTURE_SCRIPT]);
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

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], { env: ENV });
  return stdout.trim();
}

type Result = { code: number; stdout: string; stderr: string };

/** Run a script in "cwd" and give its exit code and output. */
async function runScript(script: string, args: string[], cwd: string): Promise<Result> {
  try {
    const { stdout, stderr } = await run("bash", [script, ...args], { cwd, env: ENV });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

let fixture: Fixture;
let work: string;
let dirCount = 0;
function newDir(label: string): string {
  dirCount += 1;
  const dir = join(work, `${label}-${dirCount}`);
  mkdirSync(dir);
  return dir;
}

beforeAll(async () => {
  fixture = await makeFixture();
  work = mkdtempSync(join(tmpdir(), "pr-review-eval-scripts-"));
}, 30_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(fixture.repo, { recursive: true, force: true });
});

const GOLDEN = () => ({
  findings: [
    {
      file: fixture.file,
      start_line: fixture.line,
      end_line: fixture.line,
      category: "bug",
      severity: "blocking",
      claim: "The loop reads one element past the end of the list.",
    },
  ],
});

describe("scripts/make-case.sh (R2.10)", () => {
  it("writes case.json with the arguments and the head commit message", async () => {
    const out = newDir("make-case");
    const result = await runScript(
      MAKE_CASE,
      [fixture.repo, fixture.base, fixture.head, "fixture-off-by-one"],
      out,
    );
    expect(result.code, result.stderr).toBe(0);
    const meta: unknown = JSON.parse(
      readFileSync(join(out, "fixture-off-by-one", "case.json"), "utf8"),
    );
    expect(meta).toEqual({
      name: "fixture-off-by-one",
      source: "pr",
      base: fixture.base,
      head: fixture.head,
      title: "Head: add average, move format helpers, bump lockfile, add CI",
      body: "",
      origin: "",
      language: "",
    });
  }, 30_000);

  it("writes a repo.bundle whose clone resolves base and head", async () => {
    const out = newDir("make-case");
    await runScript(MAKE_CASE, [fixture.repo, fixture.base, fixture.head, "c"], out);
    const clone = join(out, "clone");
    await run("git", ["clone", "--quiet", join(out, "c", "repo.bundle"), clone], { env: ENV });
    expect(await git(clone, ["rev-parse", `${fixture.base}^{commit}`])).toBe(fixture.base);
    expect(await git(clone, ["rev-parse", `${fixture.head}^{commit}`])).toBe(fixture.head);
  }, 30_000);

  it("writes diff.patch as the three-dot diff of the source repo", async () => {
    const out = newDir("make-case");
    await runScript(MAKE_CASE, [fixture.repo, fixture.base, fixture.head, "c"], out);
    const { stdout: expected } = await run(
      "git",
      ["-C", fixture.repo, "diff", `${fixture.base}...${fixture.head}`],
      { env: ENV },
    );
    expect(readFileSync(join(out, "c", "diff.patch"), "utf8")).toBe(expected);
  }, 30_000);

  it("writes the full shas when it gets branch names", async () => {
    const out = newDir("make-case");
    const result = await runScript(MAKE_CASE, [fixture.repo, "main", "feature", "c"], out);
    expect(result.code, result.stderr).toBe(0);
    const meta = JSON.parse(readFileSync(join(out, "c", "case.json"), "utf8")) as {
      base: string;
      head: string;
    };
    expect([meta.base, meta.head]).toEqual([fixture.base, fixture.head]);
  }, 30_000);

  it("takes the title and the body from a head commit message with quotes", async () => {
    const repo = newDir("message-repo");
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Base"]);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    await git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-am",
      'Fix the "two" path',
      "-m",
      "First line of the body.\n\nA \\ backslash and a\ttab.",
    ]);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const out = newDir("make-case");
    const result = await runScript(MAKE_CASE, [repo, base, head, "quoted"], out);
    expect(result.code, result.stderr).toBe(0);
    const meta = JSON.parse(readFileSync(join(out, "quoted", "case.json"), "utf8")) as {
      title: string;
      body: string;
    };
    expect(meta.title).toBe('Fix the "two" path');
    expect(meta.body).toBe("First line of the body.\n\nA \\ backslash and a\ttab.");
  }, 30_000);

  it("gives a case that loadCases loads and cloneCase checks out, once golden.json exists", async () => {
    const out = newDir("make-case");
    await runScript(MAKE_CASE, [fixture.repo, fixture.base, fixture.head, "labelled"], out);
    writeFileSync(join(out, "labelled", "golden.json"), JSON.stringify(GOLDEN()));
    const [c] = await loadCases(out);
    if (!c) throw new Error("no case loaded");
    const path = await cloneCase(c, join(work, "labelled-clone"));
    expect(await git(path, ["rev-parse", "HEAD"])).toBe(fixture.head);
  }, 30_000);

  it("exits non-zero and changes nothing when the case directory exists", async () => {
    const out = newDir("make-case");
    mkdirSync(join(out, "taken"));
    writeFileSync(join(out, "taken", "golden.json"), "labelled\n");
    const result = await runScript(
      MAKE_CASE,
      [fixture.repo, fixture.base, fixture.head, "taken"],
      out,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("taken");
    expect(readdirSync(join(out, "taken"))).toEqual(["golden.json"]);
    expect(readFileSync(join(out, "taken", "golden.json"), "utf8")).toBe("labelled\n");
  }, 30_000);

  it("exits non-zero and writes no directory when a sha does not resolve", async () => {
    const out = newDir("make-case");
    const result = await runScript(
      MAKE_CASE,
      [fixture.repo, "0123456789012345678901234567890123456789", fixture.head, "bad"],
      out,
    );
    expect(result.code).not.toBe(0);
    expect(existsSync(join(out, "bad"))).toBe(false);
  }, 30_000);
});

describe("scripts/fetch-cases.sh (R2.5)", () => {
  // A cases repo with one case at "first" and two cases at "second".
  let source: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    const staging = newDir("staging");
    for (const name of ["a-case", "b-case"]) {
      const result = await runScript(
        MAKE_CASE,
        [fixture.repo, fixture.base, fixture.head, name],
        staging,
      );
      if (result.code !== 0) throw new Error(result.stderr);
      writeFileSync(join(staging, name, "golden.json"), JSON.stringify(GOLDEN()));
    }
    source = newDir("cases-source");
    await git(source, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(source, "README.md"), "How to add a case.\n");
    cpSync(join(staging, "a-case"), join(source, "a-case"), { recursive: true });
    await git(source, ["add", "-A"]);
    await git(source, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Add a-case"]);
    first = await git(source, ["rev-parse", "HEAD"]);
    cpSync(join(staging, "b-case"), join(source, "b-case"), { recursive: true });
    await git(source, ["add", "-A"]);
    await git(source, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Add b-case"]);
    second = await git(source, ["rev-parse", "HEAD"]);
  }, 60_000);

  function project(ref: string): string {
    const dir = newDir("project");
    mkdirSync(join(dir, "eval"));
    pin(dir, ref);
    return dir;
  }

  function pin(dir: string, ref: string): void {
    writeFileSync(
      join(dir, "eval", "cases.json"),
      JSON.stringify({ repo: "jerridan/pr-review-cases", ref }),
    );
  }

  it("clones at the pin, then fetches a new pin in place", async () => {
    const dir = project(first);
    const cases = join(dir, "eval", "cases");

    const one = await runScript(FETCH_CASES, [source], dir);
    expect(one.code, one.stderr).toBe(0);
    expect(await git(cases, ["rev-parse", "HEAD"])).toBe(first);
    expect((await loadCases(cases)).map((c) => c.name)).toEqual(["a-case"]);

    // A file that only the old checkout holds shows that the second run
    // works in place and does not clone again.
    writeFileSync(join(cases, "local-note.txt"), "kept\n");
    pin(dir, second);
    const two = await runScript(FETCH_CASES, [source], dir);
    expect(two.code, two.stderr).toBe(0);
    expect(await git(cases, ["rev-parse", "HEAD"])).toBe(second);
    expect((await loadCases(cases)).map((c) => c.name)).toEqual(["a-case", "b-case"]);
    expect(readFileSync(join(cases, "local-note.txt"), "utf8")).toBe("kept\n");
  }, 60_000);

  it("exits non-zero and leaves no eval/cases for an unknown ref", async () => {
    const dir = project("0123456789012345678901234567890123456789");
    const result = await runScript(FETCH_CASES, [source], dir);
    expect(result.code).not.toBe(0);
    expect(existsSync(join(dir, "eval", "cases"))).toBe(false);
    expect(readdirSync(join(dir, "eval"))).toEqual(["cases.json"]);
  }, 30_000);

  it("exits non-zero and keeps the checkout for an unknown ref in place", async () => {
    const dir = project(first);
    const cases = join(dir, "eval", "cases");
    expect((await runScript(FETCH_CASES, [source], dir)).code).toBe(0);
    pin(dir, "0123456789012345678901234567890123456789");
    const result = await runScript(FETCH_CASES, [source], dir);
    expect(result.code).not.toBe(0);
    expect(await git(cases, ["rev-parse", "HEAD"])).toBe(first);
  }, 60_000);

  it("exits non-zero and leaves a plain file at eval/cases", async () => {
    const dir = project(first);
    writeFileSync(join(dir, "eval", "cases"), "a plain file\n");
    const result = await runScript(FETCH_CASES, [source], dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("eval/cases");
    expect(readFileSync(join(dir, "eval", "cases"), "utf8")).toBe("a plain file\n");
  }, 30_000);

  it("exits non-zero and leaves a plain directory inside another work tree", async () => {
    const dir = project(first);
    await git(dir, ["init", "--quiet", "--initial-branch=main"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Pin"]);
    const outerHead = await git(dir, ["rev-parse", "HEAD"]);
    mkdirSync(join(dir, "eval", "cases"));
    writeFileSync(join(dir, "eval", "cases", "draft.txt"), "draft\n");
    const result = await runScript(FETCH_CASES, [source], dir);
    expect(result.code).not.toBe(0);
    expect(readdirSync(join(dir, "eval", "cases"))).toEqual(["draft.txt"]);
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(outerHead);
  }, 30_000);

  it("exits non-zero without eval/cases.json", async () => {
    const dir = newDir("project");
    const result = await runScript(FETCH_CASES, [source], dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("eval/cases.json");
    expect(existsSync(join(dir, "eval", "cases"))).toBe(false);
  }, 30_000);
});

describe(".gitignore (R2.6)", () => {
  it.each(["eval/cases/x", "pr-review-eval/x"])("ignores %s", async (path) => {
    await expect(git(REPO_ROOT, ["check-ignore", "--quiet", path])).resolves.toBeDefined();
  });
});
