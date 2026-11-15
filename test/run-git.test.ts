import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../src/gather/worktree.js";

let repo = "";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "pr-review-run-git-"));
  execFileSync("git", ["init", "--quiet", repo]);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("runGit", () => {
  it("gives the extra environment to the git command", async () => {
    const ident = await runGit(repo, ["var", "GIT_AUTHOR_IDENT"], {
      GIT_AUTHOR_NAME: "Zed Author",
      GIT_AUTHOR_EMAIL: "zed@example.com",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
    });
    expect(ident).toContain("Zed Author <zed@example.com>");
  });

  it("puts the stderr of git in the error text of a failed call", async () => {
    await expect(runGit(repo, ["checkout", "no-such-branch"])).rejects.toThrow(
      /no-such-branch.*did not match/s,
    );
  });

  it("puts the stderr of git in the error text of a failed call with extra environment", async () => {
    await expect(
      runGit(repo, ["checkout", "no-such-branch"], { GIT_INDEX_FILE: join(repo, "idx") }),
    ).rejects.toThrow(/did not match/);
  });
});
