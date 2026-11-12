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
const INJECT_CASE = fileURLToPath(new URL("../scripts/inject-case.sh", import.meta.url));
const FETCH_CASES = fileURLToPath(new URL("../scripts/fetch-cases.sh", import.meta.url));
const FETCH_PR = fileURLToPath(new URL("../scripts/fetch-pr.sh", import.meta.url));

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

describe("inject-case.sh", () => {
  const PATCH = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-beta",
    "+BETA",
    " gamma",
    "",
  ].join("\n");
  const MESSAGE = "Host title\n\nHost body line one.\n\nHost body line two.\n";

  type Host = { repo: string; base: string; head: string; patch: string; message: string };

  async function makeHost(): Promise<Host> {
    const dir = newDir("inject-host");
    const repo = join(dir, "repo");
    mkdirSync(repo);
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    const commit = async (msg: string) => {
      await git(repo, ["add", "-A"]);
      await git(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", msg]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    writeFileSync(join(repo, "a.txt"), "alpha\nbeta\ngamma\n");
    const base = await commit("Base");
    writeFileSync(join(repo, "b.txt"), "extra\n");
    await commit("Head one");
    writeFileSync(join(repo, "c.txt"), "more\n");
    const head = await commit("Head two");
    const patch = join(dir, "bug.patch");
    writeFileSync(patch, PATCH);
    const message = join(dir, "message.txt");
    writeFileSync(message, MESSAGE);
    return { repo, base, head, patch, message };
  }

  async function inject(h: Host, out: string, name = "inj"): Promise<Result> {
    return runScript(INJECT_CASE, [h.repo, h.base, h.head, h.patch, h.message, name], out);
  }

  it("writes case.json with source injection and the title and body of the message file", async () => {
    const h = await makeHost();
    const out = newDir("inject-out");
    const result = await inject(h, out);
    expect(result.code, result.stderr).toBe(0);
    const meta = JSON.parse(readFileSync(join(out, "inj", "case.json"), "utf8")) as {
      name: string;
      source: string;
      base: string;
      title: string;
      body: string;
    };
    expect(meta.name).toBe("inj");
    expect(meta.source).toBe("injection");
    expect(meta.base).toBe(h.base);
    expect(meta.title).toBe("Host title");
    expect(meta.body).toBe("Host body line one.\n\nHost body line two.");
  }, 30_000);

  it("bundles one commit on base whose tree is the head tree with the patch applied", async () => {
    const h = await makeHost();
    const out = newDir("inject-out");
    await inject(h, out);
    const meta = JSON.parse(readFileSync(join(out, "inj", "case.json"), "utf8")) as {
      head: string;
    };
    const clone = join(out, "clone");
    await run("git", ["clone", "--quiet", join(out, "inj", "repo.bundle"), clone], { env: ENV });
    expect(await git(clone, ["rev-list", "--count", `${h.base}..${meta.head}`])).toBe("1");
    expect(await git(clone, ["rev-parse", `${meta.head}^`])).toBe(h.base);
    expect(await git(clone, ["show", `${meta.head}:a.txt`])).toBe("alpha\nBETA\ngamma");
    expect(await git(clone, ["show", `${meta.head}:b.txt`])).toBe("extra");
    expect(await git(clone, ["show", `${meta.head}:c.txt`])).toBe("more");
    expect(await git(clone, ["log", "-1", "--format=%B", meta.head])).toBe(MESSAGE.trim());
  }, 30_000);

  it("copies the patch to injection.patch", async () => {
    const h = await makeHost();
    const out = newDir("inject-out");
    await inject(h, out);
    expect(readFileSync(join(out, "inj", "injection.patch"), "utf8")).toBe(PATCH);
  }, 30_000);

  it("does not change the source repo", async () => {
    const h = await makeHost();
    const snapshot = async () => ({
      refs: await git(h.repo, ["for-each-ref"]),
      status: await git(h.repo, ["status", "--porcelain"]),
      objects: await git(h.repo, ["count-objects", "-v"]),
    });
    const before = await snapshot();
    const result = await inject(h, newDir("inject-out"));
    expect(result.code, result.stderr).toBe(0);
    expect(await snapshot()).toEqual(before);
  }, 30_000);

  it("gives the same head sha for the same inputs", async () => {
    const h = await makeHost();
    const heads: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const out = newDir("inject-out");
      await inject(h, out);
      const meta = JSON.parse(readFileSync(join(out, "inj", "case.json"), "utf8")) as {
        head: string;
      };
      heads.push(meta.head);
    }
    expect(heads[0]).toBe(heads[1]);
  }, 30_000);

  it("exits non-zero and writes no directory when the patch does not apply", async () => {
    const h = await makeHost();
    writeFileSync(h.patch, PATCH.replace("-beta", "-delta"));
    const out = newDir("inject-out");
    const result = await inject(h, out);
    expect(result.code).not.toBe(0);
    expect(existsSync(join(out, "inj"))).toBe(false);
  }, 30_000);

  it("exits non-zero and keeps the directory when the name exists", async () => {
    const h = await makeHost();
    const out = newDir("inject-out");
    mkdirSync(join(out, "inj"));
    writeFileSync(join(out, "inj", "golden.json"), "labelled\n");
    const result = await inject(h, out);
    expect(result.code).not.toBe(0);
    expect(readdirSync(join(out, "inj"))).toEqual(["golden.json"]);
  }, 30_000);

  it("exits non-zero when the message file is missing or the arguments are short", async () => {
    const h = await makeHost();
    const out = newDir("inject-out");
    const missing = await runScript(
      INJECT_CASE,
      [h.repo, h.base, h.head, h.patch, join(out, "none.txt"), "inj"],
      out,
    );
    expect(missing.code).not.toBe(0);
    expect(existsSync(join(out, "inj"))).toBe(false);
    const short = await runScript(INJECT_CASE, [h.repo, h.base, h.head], out);
    expect(short.code).not.toBe(0);
  }, 30_000);
});

describe("scripts/fetch-pr.sh", () => {
  // A fixture whose head is two commits past the merge base, so the first
  // shallow fetch does not hold the base and the script must deepen.
  let remote: string;
  let mergeBase: string;
  let head2: string;

  beforeAll(async () => {
    const { stdout } = await run("bash", [FIXTURE_SCRIPT, "--second-push"]);
    const value = (key: string) =>
      stdout
        .split("\n")
        .find((l) => l.startsWith(`${key}=`))
        ?.slice(key.length + 1) ?? "";
    remote = value("FIXTURE");
    head2 = value("HEAD2");
    mergeBase = await git(remote, ["merge-base", value("BASE"), head2]);
    // Let a fetch name a commit by sha, as GitHub does.
    await git(remote, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  }, 30_000);

  afterAll(() => {
    rmSync(remote, { recursive: true, force: true });
  });

  it("gives a shallow repo from which make-case.sh makes a case that cloneCase checks out", async () => {
    const dir = join(newDir("fetch-pr"), "src");
    const result = await runScript(FETCH_PR, [`file://${remote}`, mergeBase, head2, dir], work);
    expect(result.code).toBe(0);
    expect(await git(dir, ["rev-list", "--count", `${mergeBase}..${head2}`])).toBe("2");

    const out = newDir("fetch-pr-case");
    await runScript(MAKE_CASE, [dir, mergeBase, head2, "fetched"], out);
    writeFileSync(join(out, "fetched", "golden.json"), JSON.stringify(GOLDEN()));
    const [c] = await loadCases(out);
    if (!c) throw new Error("no case loaded");
    const path = await cloneCase(c, join(work, "fetched-clone"));
    expect(await git(path, ["rev-parse", "HEAD"])).toBe(head2);
    expect(await git(path, ["rev-parse", `${mergeBase}^{commit}`])).toBe(mergeBase);
    expect((await git(path, ["diff", "--stat", `${mergeBase}...${head2}`])).length).toBeGreaterThan(
      0,
    );
  }, 60_000);

  it("exits non-zero and changes nothing when the directory exists", async () => {
    const dir = newDir("fetch-pr-taken");
    writeFileSync(join(dir, "keep.txt"), "keep\n");
    const result = await runScript(FETCH_PR, [`file://${remote}`, mergeBase, head2, dir], work);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(dir);
    expect(readdirSync(dir)).toEqual(["keep.txt"]);
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
