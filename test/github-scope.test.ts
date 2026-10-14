import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { ensureCommit, newHunks } from "../src/github/scope.js";

const run = promisify(execFile);

const file = (path: string, ...hunks: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n") + "\n";

const HUNK_A = ["@@ -1,3 +1,4 @@", " one", "+two", " three", " four"].join("\n");
const HUNK_B = ["@@ -10,2 +11,2 @@", " ten", "-old", "+new"].join("\n");
// HUNK_A at other lines, with other context: the same added and removed text.
const HUNK_A_MOVED = ["@@ -20,3 +25,4 @@", " x", "+two", " y", " z"].join("\n");
const HUNK_C = ["@@ -30,1 +40,2 @@", " c", "+added later"].join("\n");

describe("newHunks (R7)", () => {
  it("gives no new hunk when the diffs are the same", () => {
    const diff = file("src/a.ts", HUNK_A, HUNK_B) + file("src/b.ts", HUNK_A);
    expect(newHunks(diff, diff)).toEqual({ diff: "", files: [] });
  });

  it("keeps only the new hunks, with the header of their file", () => {
    const prior = file("src/a.ts", HUNK_A, HUNK_B) + file("src/b.ts", HUNK_A);
    const head = file("src/a.ts", HUNK_A, HUNK_B, HUNK_C) + file("src/b.ts", HUNK_A);
    const out = newHunks(head, prior);
    expect(out.files).toEqual(["src/a.ts"]);
    expect(out.diff).toBe(file("src/a.ts", HUNK_C));
  });

  it("matches a hunk by its path and its added and removed text, not by its lines or context", () => {
    const prior = file("src/a.ts", HUNK_A);
    expect(newHunks(file("src/a.ts", HUNK_A_MOVED), prior).files).toEqual([]);
    // The same text in another file is new.
    expect(newHunks(file("src/b.ts", HUNK_A), prior).files).toEqual(["src/b.ts"]);
  });

  it("treats a changed hunk as new", () => {
    const changed = ["@@ -10,2 +11,2 @@", " ten", "-old", "+newer"].join("\n");
    const out = newHunks(
      file("src/a.ts", HUNK_B.replace("+new", "+newer")),
      file("src/a.ts", HUNK_B),
    );
    expect(out.files).toEqual(["src/a.ts"]);
    expect(out.diff).toContain(changed);
  });

  it("treats every hunk as new against an empty prior diff", () => {
    const head = file("src/a.ts", HUNK_A) + file("src/b.ts", HUNK_B);
    expect(newHunks(head, "")).toEqual({ diff: head, files: ["src/a.ts", "src/b.ts"] });
  });
});

describe("ensureCommit (R7)", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-review-scope-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (repo: string, ...args: string[]) =>
    run("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

  it("is true for a commit in the store, fetches a missing one, and is false when the fetch fails", async () => {
    const origin = join(root, "origin");
    const clone = join(root, "clone");
    await run("git", ["init", "-q", origin]);
    await git(origin, "commit", "-q", "--allow-empty", "-m", "one");
    await run("git", ["clone", "-q", origin, clone]);
    const present = (await git(origin, "rev-parse", "HEAD")).stdout.trim();
    await git(origin, "checkout", "-q", "-b", "side");
    await git(origin, "commit", "-q", "--allow-empty", "-m", "two");
    const missing = (await git(origin, "rev-parse", "HEAD")).stdout.trim();

    expect(await ensureCommit(clone, present)).toBe(true);
    expect(await ensureCommit(clone, missing)).toBe(true);
    await expect(git(clone, "cat-file", "-e", `${missing}^{commit}`)).resolves.toBeDefined();
    expect(await ensureCommit(clone, "e".repeat(40))).toBe(false);
    // A repo with no remote cannot fetch.
    expect(await ensureCommit(origin, "e".repeat(40))).toBe(false);
  });
});
