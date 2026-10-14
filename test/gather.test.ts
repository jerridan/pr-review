import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBS, withRepoGlobs } from "../src/config/globs.js";
import { countHunks, diffSections, filterDiff, parseNameStatus } from "../src/gather/diff.js";
import { applyExclusions } from "../src/gather/exclusions.js";
import type * as History from "../src/gather/history.js";
import { gatherHistory, HISTORY_CAP_BYTES, oldSideRanges } from "../src/gather/history.js";
import { gather, type GatherResult } from "../src/gather/index.js";
import { withHeadWorktree } from "../src/gather/worktree.js";

// A switch for the history mock below. It is off unless a test sets it.
const mocks = vi.hoisted(() => ({ failHistory: false, historyCalls: 0 }));

vi.mock("../src/gather/history.js", async (importOriginal) => {
  const original = await importOriginal<typeof History>();
  return {
    ...original,
    gatherHistory: (...args: Parameters<typeof original.gatherHistory>) => {
      mocks.historyCalls += 1;
      if (mocks.failHistory) return Promise.reject(new Error("git blame failed"));
      return original.gatherHistory(...args);
    },
  };
});

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

// A patch in the form that gather asks git for, with fixed a/ and b/ prefixes.
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,2 +10,3 @@ function f() {",
  " ten",
  "+ten and a half",
  " eleven",
  "diff --git a/old/name.ts b/new/name.ts",
  "similarity index 90%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "index 3333333..4444444 100644",
  "--- a/old/name.ts",
  "+++ b/new/name.ts",
  "@@ -5,1 +5,1 @@",
  "-x",
  "+y",
  "diff --git a/moved.ts b/moved/again.ts",
  "similarity index 100%",
  "rename from moved.ts",
  "rename to moved/again.ts",
  "diff --git a/yarn.lock b/yarn.lock",
  "index 5555555..6666666 100644",
  "--- a/yarn.lock",
  "+++ b/yarn.lock",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "index 7777777..0000000",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-p",
  "-q",
  "diff --git a/img.png b/img.png",
  "new file mode 100644",
  "index 0000000..8888888",
  "Binary files /dev/null and b/img.png differ",
  "diff --git a/src/auth/login.ts b/src/auth/login.ts",
  "index 9999999..aaaaaaa 100644",
  "--- a/src/auth/login.ts",
  "+++ b/src/auth/login.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const NAME_STATUS = [
  "M",
  "src/a.ts",
  "R090",
  "old/name.ts",
  "new/name.ts",
  "R100",
  "moved.ts",
  "moved/again.ts",
  "M",
  "yarn.lock",
  "D",
  "gone.ts",
  "A",
  "img.png",
  "M",
  "src/auth/login.ts",
  "",
].join("\0");

describe("parseNameStatus", () => {
  it("parses NUL-separated name-status output with renames", () => {
    expect(parseNameStatus(NAME_STATUS)).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "new/name.ts", status: "R", oldPath: "old/name.ts", similarity: 90 },
      { path: "moved/again.ts", status: "R", oldPath: "moved.ts", similarity: 100 },
      { path: "yarn.lock", status: "M" },
      { path: "gone.ts", status: "D" },
      { path: "img.png", status: "A" },
      { path: "src/auth/login.ts", status: "M" },
    ]);
  });

  it("keeps a path with spaces and a tab", () => {
    expect(parseNameStatus("M\0dir/a file\twith tab.ts\0")).toEqual([
      { path: "dir/a file\twith tab.ts", status: "M" },
    ]);
  });

  it("gives an empty list for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("countHunks", () => {
  it("counts the hunks of each file, keyed by the new path", () => {
    const hunks = countHunks(PATCH);
    expect(Object.fromEntries(hunks)).toEqual({
      "src/a.ts": 2,
      "new/name.ts": 1,
      "moved/again.ts": 0,
      "yarn.lock": 1,
      "gone.ts": 1,
      "img.png": 0,
      "src/auth/login.ts": 1,
    });
  });

  it("does not count a line in a hunk body that looks like a hunk header", () => {
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,2 +1,2 @@",
      " @@ not a header",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(countHunks(patch).get("x.md")).toBe(1);
  });
});

describe("diffSections", () => {
  it("maps each new path to the text of its sections, as filterDiff selects it", () => {
    const sections = diffSections(PATCH);
    expect([...sections.keys()].sort()).toEqual([...countHunks(PATCH).keys()].sort());
    for (const path of sections.keys()) {
      expect(sections.get(path)).toBe(filterDiff(PATCH, (p) => p === path));
    }
    expect(sections.get("src/a.ts")).toContain("+ten and a half");
    expect(sections.get("src/a.ts")).not.toContain("yarn.lock");
    expect(sections.get("new/name.ts")).toContain("rename to new/name.ts");
  });

  it("joins two sections of the same path, and gives an empty map for an empty diff", () => {
    const one = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const two = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -9 +9 @@\n-c\n+d\n";
    expect(diffSections(one + two).get("x.ts")).toBe(one + two);
    expect(diffSections("").size).toBe(0);
  });
});

describe("filterDiff", () => {
  it("keeps only the sections of files that pass", () => {
    const kept = filterDiff(PATCH, (path) => path === "src/a.ts" || path === "gone.ts");
    expect(kept).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(kept).toContain("+ten and a half");
    expect(kept).toContain("diff --git a/gone.ts b/gone.ts");
    expect(kept).not.toContain("yarn.lock");
    expect(kept).not.toContain("new/name.ts");
    expect(Object.fromEntries(countHunks(kept))).toEqual({ "src/a.ts": 2, "gone.ts": 1 });
  });

  it("returns the same text when every file passes", () => {
    expect(filterDiff(PATCH, () => true)).toBe(PATCH);
  });
});

describe("applyExclusions", () => {
  const result = applyExclusions(parseNameStatus(NAME_STATUS), PATCH);

  it("removes a rename-only file entirely", () => {
    expect(result.excluded).toContainEqual({ path: "moved/again.ts", reason: "rename-only" });
    expect(result.changedFiles.map((f) => f.path)).not.toContain("moved/again.ts");
    expect(result.diff).not.toContain("moved/again.ts");
  });

  it("keeps a rename with a content change", () => {
    expect(result.changedFiles).toContainEqual({ path: "new/name.ts", hunks: 1 });
  });

  it("removes a lockfile from the diff and the hunk counts", () => {
    expect(result.excluded).toContainEqual({ path: "yarn.lock", reason: "generated" });
    expect(result.changedFiles.map((f) => f.path)).not.toContain("yarn.lock");
    expect(result.diff).not.toContain("yarn.lock");
    expect(result.totalHunks).toBe(2 + 1 + 1 + 0 + 1);
  });

  it("flags a sensitive path and removes nothing for it", () => {
    expect(result.sensitive).toEqual(["src/auth/login.ts"]);
    expect(result.changedFiles).toContainEqual({ path: "src/auth/login.ts", hunks: 1 });
    expect(result.diff).toContain("+++ b/src/auth/login.ts");
  });

  it("flags a file that moves out of a sensitive path", () => {
    const files = [
      { path: "src/session.ts", status: "R", oldPath: "src/auth/session.ts", similarity: 80 },
    ];
    const patch = [
      "diff --git a/src/auth/session.ts b/src/session.ts",
      "similarity index 80%",
      "rename from src/auth/session.ts",
      "rename to src/session.ts",
      "--- a/src/auth/session.ts",
      "+++ b/src/session.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(applyExclusions(files, patch).sensitive).toEqual(["src/session.ts"]);
  });

  it("gives zero hunks when every change is excluded", () => {
    const files = parseNameStatus("M\0yarn.lock\0R100\0moved.ts\0moved/again.ts\0");
    const only = applyExclusions(
      files,
      filterDiff(PATCH, (p) => p === "yarn.lock" || p === "moved/again.ts"),
    );
    expect(only.changedFiles).toEqual([]);
    expect(only.totalHunks).toBe(0);
    expect(only.diff.trim()).toBe("");
  });
});

type Fixture = { repo: string; base: string; head: string; planted: string };

async function makeFixture(): Promise<Fixture> {
  const { stdout } = await run("bash", [SCRIPT]);
  const value = (key: string): string => {
    const line = stdout.split("\n").find((l) => l.startsWith(`${key}=`));
    if (!line) throw new Error(`make-fixture.sh printed no ${key}= line:\n${stdout}`);
    return line.slice(key.length + 1);
  };
  return {
    repo: value("FIXTURE"),
    base: value("BASE"),
    head: value("HEAD"),
    planted: value("PLANTED"),
  };
}

describe("gather on the fixture repo (A2)", () => {
  let fixture: Fixture;
  let result: GatherResult;

  beforeAll(async () => {
    fixture = await makeFixture();
    result = await gather(fixture.repo, fixture.base, fixture.head, DEFAULT_GLOBS);
  }, 30_000);

  afterAll(() => {
    if (fixture) rmSync(fixture.repo, { recursive: true, force: true });
  });

  it("prints a planted line in src/stats.ts", () => {
    const [file, line] = fixture.planted.split(":");
    const text = readFileSync(join(fixture.repo, file ?? ""), "utf8").split("\n");
    expect(text[Number(line) - 1]).toContain("i <= values.length");
  });

  it("returns the full SHAs", () => {
    expect(result.base).toBe(fixture.base);
    expect(result.head).toBe(fixture.head);
    expect(result.base).toMatch(/^[0-9a-f]{40}$/);
  });

  it("uses the three-dot diff, so a base change after the fork is absent", () => {
    expect(result.diff).not.toContain("README.md");
    expect(result.changedFiles.map((f) => f.path)).not.toContain("README.md");
  });

  it("lists the changed files with their hunk counts", () => {
    expect(result.changedFiles).toEqual([
      { path: ".github/workflows/ci.yml", hunks: 1 },
      { path: "src/stats.ts", hunks: 1 },
    ]);
    expect(result.totalHunks).toBe(2);
  });

  it("holds the planted bug in the diff", () => {
    expect(result.diff).toContain("+  for (let i = 0; i <= values.length; i++) {");
    expect(result.diff).toContain("+++ b/src/stats.ts");
  });

  it("removes the rename-only file from the file list and the diff", () => {
    expect(result.changedFiles.map((f) => f.path)).not.toContain("src/format.ts");
    expect(result.diff).not.toContain("format.ts");
    expect(result.excluded).toContainEqual({ path: "src/format.ts", reason: "rename-only" });
  });

  it("removes the lockfile from the diff and the hunk count", () => {
    expect(result.diff).not.toContain("package-lock.json");
    expect(result.changedFiles.map((f) => f.path)).not.toContain("package-lock.json");
    expect(result.excluded).toContainEqual({ path: "package-lock.json", reason: "generated" });
  });

  it("flags the workflow file as sensitive and keeps it", () => {
    expect(result.sensitive).toEqual([".github/workflows/ci.yml"]);
    expect(result.diff).toContain("+++ b/.github/workflows/ci.yml");
  });

  it("gives the merge base of base and head", async () => {
    const { stdout: mergeBase } = await run("git", [
      "-C",
      fixture.repo,
      "merge-base",
      fixture.base,
      fixture.head,
    ]);
    expect(result.mergeBase).toBe(mergeBase.trim());
    expect(result.mergeBase).not.toBe(fixture.base);
  });

  it("gives the description: the head commit message (R2)", () => {
    expect(result.description).toBe(
      "Head: add average, move format helpers, bump lockfile, add CI",
    );
  });

  it("gives a history block that names the planted file and holds a blame line for it (R2)", () => {
    expect(result.history).not.toBeNull();
    const text = result.history?.text ?? "";
    expect(text).toContain("src/stats.ts");
    // A blame line: the commit, the author and date, the line number, the code.
    expect(text).toMatch(/^\^?[0-9a-f]{7,} \(Fixture\s+2026-01-01\s+\d+\) /m);
    expect(text).toContain("  return total;");
    // The log line of the commit that last changed those lines.
    expect(text).toMatch(/^[0-9a-f]{7,} 2026-01-01 Fixture Base: sum, format helpers, lockfile$/m);
    expect(result.history?.truncated).toBe(false);
  });

  it("gives no history for a file that the merge base does not have", () => {
    expect(result.history?.text ?? "").not.toContain("ci.yml");
  });

  describe("the history block", () => {
    beforeEach(() => {
      mocks.historyCalls = 0;
    });

    afterEach(() => {
      mocks.failHistory = false;
    });

    it("builds the history block when the history flag is true or absent", async () => {
      const on = await gather(fixture.repo, fixture.base, fixture.head, {
        ...DEFAULT_GLOBS,
        history: true,
      });
      expect(on.history).not.toBeNull();
      expect(on.historyError).toBeNull();
      expect(mocks.historyCalls).toBe(1);
    });

    it("skips the history block when the history flag is false", async () => {
      const off = await gather(fixture.repo, fixture.base, fixture.head, {
        ...DEFAULT_GLOBS,
        history: false,
      });
      expect(off.history).toBeNull();
      expect(off.historyError).toBeNull();
      expect(mocks.historyCalls).toBe(0);
      expect(off.changedFiles).toEqual(result.changedFiles);
      expect(off.description).toBe(result.description);
    });

    it("gives null history, and does not stop, when gatherHistory fails", async () => {
      mocks.failHistory = true;
      const out = await gather(fixture.repo, fixture.base, fixture.head, DEFAULT_GLOBS);
      expect(mocks.historyCalls).toBe(1);
      expect(out.history).toBeNull();
      expect(out.historyError).toBe("git blame failed");
      expect(out.diff).toBe(result.diff);
      expect(out.description).toBe(result.description);
    });
  });

  it("throws on a SHA that does not exist", async () => {
    await expect(
      gather(fixture.repo, "0".repeat(40), fixture.head, DEFAULT_GLOBS),
    ).rejects.toThrow();
  });

  it("adds the repo config's globs to the defaults", async () => {
    const globs = withRepoGlobs({
      sensitive_globs: ["src/stats.ts"],
      generated_globs: [".github/**"],
    });
    const out = await gather(fixture.repo, fixture.base, fixture.head, globs);
    expect(out.excluded).toContainEqual({ path: ".github/workflows/ci.yml", reason: "generated" });
    expect(out.excluded).toContainEqual({ path: "package-lock.json", reason: "generated" });
    expect(out.changedFiles).toEqual([{ path: "src/stats.ts", hunks: 1 }]);
    expect(out.sensitive).toEqual(["src/stats.ts"]);
    expect(out.diff).not.toContain(".github/workflows/ci.yml");
  });
});

describe("withHeadWorktree", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture();
  }, 30_000);

  afterAll(() => {
    if (fixture) rmSync(fixture.repo, { recursive: true, force: true });
  });

  async function worktreeList(): Promise<string> {
    const { stdout } = await run("git", ["-C", fixture.repo, "worktree", "list", "--porcelain"]);
    return stdout;
  }

  it("checks out the head commit, detached, and removes it after", async () => {
    let seen = "";
    const value = await withHeadWorktree(fixture.repo, fixture.head, async (path) => {
      seen = path;
      expect(readFileSync(join(path, "src/stats.ts"), "utf8")).toContain("i <= values.length");
      const { stdout } = await run("git", ["-C", path, "rev-parse", "HEAD"]);
      expect(stdout.trim()).toBe(fixture.head);
      const list = await worktreeList();
      expect(list).toContain(`worktree ${path}`);
      expect(list).toContain("detached");
      return 42;
    });
    expect(value).toBe(42);
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
    expect(await worktreeList()).not.toContain(seen);
  });

  it("removes the worktree when the function throws", async () => {
    let seen = "";
    await expect(
      withHeadWorktree(fixture.repo, fixture.head, async (path) => {
        seen = path;
        expect(await worktreeList()).toContain(`worktree ${path}`);
        throw new Error("stage failed");
      }),
    ).rejects.toThrow("stage failed");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
    expect(await worktreeList()).not.toContain(seen);
  });

  it("throws on a head that does not exist", async () => {
    await expect(withHeadWorktree(fixture.repo, "f".repeat(40), async () => 1)).rejects.toThrow();
  });
});

describe("oldSideRanges", () => {
  it("takes the old side of each hunk, context lines included", () => {
    const section = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -5,7 +5,9 @@ function f() {",
      " a",
      "@@ -40 +42,2 @@",
      " b",
      "@@ -12,0 +15,3 @@",
      "+c",
      "@@ -0,0 +1,2 @@",
      "+d",
      "",
    ].join("\n");
    expect(oldSideRanges(section)).toEqual([
      { start: 5, end: 11 },
      { start: 40, end: 40 },
      { start: 12, end: 12 },
    ]);
  });

  it("ignores a line in a hunk body that only looks like a header", () => {
    const section = ["@@ -1,2 +1,2 @@", "-@@ -9,9 +9,9 @@", "+x", " y", ""].join("\n");
    expect(oldSideRanges(section)).toEqual([{ start: 1, end: 2 }]);
  });

  it("gives no range for a section with no hunk", () => {
    expect(oldSideRanges("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n")).toEqual([]);
  });
});

describe("gatherHistory", () => {
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Hist",
    GIT_AUTHOR_EMAIL: "hist@example.invalid",
    GIT_COMMITTER_NAME: "Hist",
    GIT_COMMITTER_EMAIL: "hist@example.invalid",
    GIT_AUTHOR_DATE: "2026-02-03T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-02-03T00:00:00Z",
  };
  let repo = "";
  let sha = "";

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "pr-review-history-"));
    const git = (...args: string[]) => run("git", ["-C", repo, ...args], { env: GIT_ENV });
    await git("init", "--quiet", "--initial-branch=main");
    const big = Array.from({ length: 3000 }, (_, i) => `const line${i} = "${"x".repeat(40)}";`);
    writeFileSync(join(repo, "big.ts"), `${big.join("\n")}\n`);
    writeFileSync(join(repo, "small.ts"), "one\ntwo\nthree\n");
    await git("add", "-A");
    await git("commit", "--quiet", "--no-gpg-sign", "-m", "Add files");
    sha = (await git("rev-parse", "HEAD")).stdout.trim();
  }, 30_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("gives null when no file exists at the merge base", async () => {
    expect(await gatherHistory(repo, sha, [])).toBeNull();
    expect(
      await gatherHistory(repo, sha, [{ path: "absent.ts", ranges: [{ start: 1, end: 2 }] }]),
    ).toBeNull();
  });

  it("limits the blame to the ranges, and clamps a range to the file", async () => {
    const out = await gatherHistory(repo, sha, [
      { path: "small.ts", ranges: [{ start: 2, end: 9 }] },
    ]);
    expect(out?.truncated).toBe(false);
    expect(out?.text).toMatch(/\(Hist\s+2026-02-03\s+2\) two$/m);
    expect(out?.text).toMatch(/\(Hist\s+2026-02-03\s+3\) three$/m);
    expect(out?.text).not.toMatch(/\) one$/m);
    expect(out?.text).toMatch(/^[0-9a-f]{7,} 2026-02-03 Hist Add files$/m);
  });

  it("cuts the block at a line end to fit the cap, and notes the cut", async () => {
    const out = await gatherHistory(repo, sha, [
      { path: "big.ts", ranges: [{ start: 1, end: 3000 }] },
    ]);
    expect(out?.truncated).toBe(true);
    expect(Buffer.byteLength(out?.text ?? "", "utf8")).toBeLessThanOrEqual(HISTORY_CAP_BYTES);
    expect(Buffer.byteLength(out?.text ?? "", "utf8")).toBeGreaterThan(HISTORY_CAP_BYTES - 200);
    expect(HISTORY_CAP_BYTES).toBe(65536);
    expect(out?.text.endsWith(";")).toBe(true);
  });
});
