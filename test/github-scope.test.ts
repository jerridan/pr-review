import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    // A hunk that moves past another hunk is not new.
    expect(
      newHunks(file("src/a.ts", HUNK_A_MOVED, HUNK_B), file("src/a.ts", HUNK_B, HUNK_A)),
    ).toEqual({ diff: "", files: [] });
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

  it("reports a second hunk with the same changed lines as new when the prior diff holds the key once", () => {
    const prior = file("src/a.ts", HUNK_A);
    const head = file("src/a.ts", HUNK_A, HUNK_A_MOVED);
    const out = newHunks(head, prior);
    expect(out.files).toEqual(["src/a.ts"]);
    // One of the two hunks is new. The first one matches the prior hunk.
    expect(out.diff).toBe(file("src/a.ts", HUNK_A_MOVED));
  });

  it("reports no hunk when two prior hunks and two head hunks share one key", () => {
    const prior = file("src/a.ts", HUNK_A, HUNK_A_MOVED);
    const head = file("src/a.ts", HUNK_A_MOVED, HUNK_A);
    expect(newHunks(head, prior)).toEqual({ diff: "", files: [] });
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

  // The clone has the commit "present". Only the origin has "missing".
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  let present = "";
  let missing = "";
  beforeAll(async () => {
    await run("git", ["init", "-q", origin]);
    await git(origin, "commit", "-q", "--allow-empty", "-m", "one");
    await run("git", ["clone", "-q", origin, clone]);
    present = (await git(origin, "rev-parse", "HEAD")).stdout.trim();
    await git(origin, "checkout", "-q", "-b", "side");
    await git(origin, "commit", "-q", "--allow-empty", "-m", "two");
    missing = (await git(origin, "rev-parse", "HEAD")).stdout.trim();
  });

  it("is true for a commit in the store", async () => {
    expect(await ensureCommit(clone, present)).toBe(true);
  });

  it("fetches a missing commit, and is true", async () => {
    expect(await ensureCommit(clone, missing)).toBe(true);
    await expect(git(clone, "cat-file", "-e", `${missing}^{commit}`)).resolves.toBeDefined();
  });

  it("is false when the fetch fails", async () => {
    expect(await ensureCommit(clone, "e".repeat(40))).toBe(false);
    // A repo with no remote cannot fetch.
    expect(await ensureCommit(origin, "e".repeat(40))).toBe(false);
  });
});
