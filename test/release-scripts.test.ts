// Tests for the release scripts: scripts/release-tag.sh tags a release from
// the version in package.json.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The identity for the setup commits only. The scripts run without it.
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

// No system or global git configuration, so no user identity leaks in.
const GIT_BASE = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: { ...GIT_BASE, ...IDENTITY, HOME: cwd },
    encoding: "utf8",
  }).trim();
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a script of scripts/ in "cwd" with only the env that "env" gives. */
function runRepoScript(
  name: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Run {
  const result = spawnSync(join(ROOT, "scripts", name), args, { cwd, env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------

interface ReleaseSandbox {
  work: string;
  remote: string;
  head: string;
  log: string;
  home: string;
  path: string;
}

/**
 * Make a work repo whose package.json holds "version", and a bare remote
 * "origin". HEAD is on main of the remote. A gh stub on "path" acts as
 * GitHub for "gh release create": it makes the tag at the target in the
 * remote and writes the call to "log".
 */
function releaseSandbox(version: string | null): ReleaseSandbox {
  const base = tempDir("pr-review-release-");
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  const home = join(base, "home");
  const bin = join(base, "bin");
  const log = join(base, "gh.log");
  mkdirSync(home);
  mkdirSync(bin);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: GIT_BASE });
  execFileSync("git", ["init", "-q", "-b", "main", work], { env: GIT_BASE });
  const pkg = version === null ? { name: "x" } : { name: "x", version };
  writeFileSync(join(work, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "seed");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      'if [ "$1" = release ] && [ "$2" = create ]; then',
      '  tag="$3"',
      "  shift 3",
      '  sha=""',
      "  while [ $# -gt 0 ]; do",
      '    if [ "$1" = --target ]; then sha="$2"; shift 2; else shift; fi',
      "  done",
      `  git --git-dir='${remote}' update-ref "refs/tags/$tag" "$sha" || exit 1`,
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    work,
    remote,
    head: git(work, "rev-parse", "HEAD"),
    log,
    home,
    path: `${bin}:${process.env.PATH ?? ""}`,
  };
}

/** The sha of the tag in the remote, or null when the tag is absent. */
function remoteTag(sandbox: ReleaseSandbox, tag: string): string | null {
  const result = spawnSync(
    "git",
    ["--git-dir", sandbox.remote, "rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`],
    {
      env: GIT_BASE,
      encoding: "utf8",
    },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function ghCalls(sandbox: ReleaseSandbox): string[] {
  if (!existsSync(sandbox.log)) return [];
  return readFileSync(sandbox.log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function release(
  sandbox: ReleaseSandbox,
  env: Record<string, string>,
  options: { identity?: boolean; args?: string[] } = {},
): Run {
  const full: Record<string, string> = {
    ...GIT_BASE,
    PATH: sandbox.path,
    HOME: sandbox.home,
    ...(options.identity ? IDENTITY : {}),
    ...env,
  };
  return runRepoScript("release-tag.sh", options.args ?? [], full, sandbox.work);
}

const MAIN = { GITHUB_REF: "refs/heads/main", GH_TOKEN: "<token>" };

function oneLineReason(run: Run): void {
  const text = `${run.stdout}${run.stderr}`.trim();
  expect(text.length).toBeGreaterThan(0);
  expect(text.split("\n")).toHaveLength(1);
}

describe("scripts/release-tag.sh", () => {
  // Case (f): the cases (a) to (c) also hold with no git identity in the env.
  describe.each([
    ["with a git identity", true],
    ["with no git identity", false],
  ])("%s", (_label, identity) => {
    it("creates the release and the tag v<version> at HEAD, once, and a second run changes nothing", () => {
      const sandbox = releaseSandbox("0.2.0");
      const first = release(sandbox, MAIN, { identity });
      expect(first.status, first.stderr).toBe(0);
      expect(remoteTag(sandbox, "v0.2.0")).toBe(sandbox.head);
      expect(ghCalls(sandbox)).toEqual([
        `release create v0.2.0 --target ${sandbox.head} --title v0.2.0 --generate-notes`,
      ]);

      const second = release(sandbox, MAIN, { identity });
      expect(second.status, second.stderr).toBe(0);
      expect(remoteTag(sandbox, "v0.2.0")).toBe(sandbox.head);
      expect(ghCalls(sandbox)).toHaveLength(1);
    }, 30_000);

    it("makes no tag and no gh call in a dry run selected by RELEASE_DRY_RUN=true", () => {
      const sandbox = releaseSandbox("0.2.0");
      const run = release(sandbox, { ...MAIN, RELEASE_DRY_RUN: "true" }, { identity });
      expect(run.status, run.stderr).toBe(0);
      expect(remoteTag(sandbox, "v0.2.0")).toBeNull();
      expect(ghCalls(sandbox)).toEqual([]);
    }, 30_000);

    it("makes no tag and no gh call in a dry run selected by --dry-run", () => {
      const sandbox = releaseSandbox("0.2.0");
      const run = release(sandbox, MAIN, { identity, args: ["--dry-run"] });
      expect(run.status, run.stderr).toBe(0);
      expect(remoteTag(sandbox, "v0.2.0")).toBeNull();
      expect(ghCalls(sandbox)).toEqual([]);
    }, 30_000);
  });

  it("runs a dry run on a ref other than main and with no GH_TOKEN", () => {
    const sandbox = releaseSandbox("0.2.0");
    const run = release(sandbox, { GITHUB_REF: "refs/heads/feature", RELEASE_DRY_RUN: "true" });
    expect(run.status, run.stderr).toBe(0);
    expect(remoteTag(sandbox, "v0.2.0")).toBeNull();
    expect(ghCalls(sandbox)).toEqual([]);
  }, 30_000);

  it("refuses to release from a ref other than main", () => {
    const sandbox = releaseSandbox("0.2.0");
    const run = release(sandbox, { ...MAIN, GITHUB_REF: "refs/heads/feature" });
    expect(run.status).toBe(1);
    oneLineReason(run);
    expect(remoteTag(sandbox, "v0.2.0")).toBeNull();
    expect(ghCalls(sandbox)).toEqual([]);
  }, 30_000);

  it.each([
    ["the version 0.2", "0.2"],
    ["the version v0.2.0", "v0.2.0"],
    ["the version 0.2.0-rc.1", "0.2.0-rc.1"],
    ["no version", null],
  ])(
    "refuses %s",
    (_label, version) => {
      const sandbox = releaseSandbox(version);
      const run = release(sandbox, MAIN);
      expect(run.status).toBe(1);
      oneLineReason(run);
      expect(ghCalls(sandbox)).toEqual([]);
    },
    30_000,
  );

  it("refuses a real run when GH_TOKEN is not set", () => {
    const sandbox = releaseSandbox("0.2.0");
    const run = release(sandbox, { GITHUB_REF: "refs/heads/main" });
    expect(run.status).toBe(1);
    oneLineReason(run);
    expect(remoteTag(sandbox, "v0.2.0")).toBeNull();
    expect(ghCalls(sandbox)).toEqual([]);
  }, 30_000);

  it("fails when it cannot read the tags of the remote", () => {
    const sandbox = releaseSandbox("0.2.0");
    git(sandbox.work, "remote", "set-url", "origin", join(sandbox.home, "absent.git"));
    const run = release(sandbox, MAIN);
    expect(run.status).toBe(1);
    expect(ghCalls(sandbox)).toEqual([]);
  }, 30_000);
});
