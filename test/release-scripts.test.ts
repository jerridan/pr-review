// Tests for the release scripts and the release workflow:
// scripts/release-tag.sh tags a release from the version in package.json,
// and .github/workflows/release.yml runs it.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

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

// ---------------------------------------------------------------------------

interface Versions {
  pkg: string;
  plugin: string;
  market: string;
}

function same(version: string): Versions {
  return { pkg: version, plugin: version, market: version };
}

function writeVersions(dir: string, versions: Versions): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "pr-review", version: versions.pkg }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "pr-review", version: versions.plugin }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "pr-review",
        plugins: [{ name: "pr-review", source: "./", version: versions.market }],
      },
      null,
      2,
    )}\n`,
  );
}

function writeFiles(dir: string, paths: string[]): void {
  for (const path of paths) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${path} ${Math.random()}\n`);
  }
}

/**
 * Make a repo with a base commit at "base" versions, and a feature branch
 * that changes "paths" and, when "head" is set, the versions. Each pair in
 * "moves" moves a file with git mv on the branch. When "mainPaths" is set,
 * main gets one more commit after the branch point.
 */
function bumpSandbox(options: {
  base: string;
  paths: string[];
  head?: Versions;
  moves?: [string, string][];
  mainPaths?: string[];
}): { work: string; baseSha: string; headSha: string } {
  const work = tempDir("pr-review-bump-");
  git(work, "init", "-q", "-b", "main");
  writeVersions(work, same(options.base));
  writeFiles(work, [
    "README.md",
    "src/a.ts",
    "prompts/a.md",
    "action.yml",
    ".github/workflows/review.yml",
  ]);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "base");
  git(work, "checkout", "-q", "-b", "feature");
  writeFiles(work, options.paths);
  for (const [from, to] of options.moves ?? []) {
    mkdirSync(dirname(join(work, to)), { recursive: true });
    git(work, "mv", from, to);
  }
  if (options.head) writeVersions(work, options.head);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "head");
  const headSha = git(work, "rev-parse", "HEAD");
  if (options.mainPaths) {
    git(work, "checkout", "-q", "main");
    writeFiles(work, options.mainPaths);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "main moves on");
    git(work, "checkout", "-q", "feature");
  }
  return { work, baseSha: git(work, "rev-parse", "main"), headSha };
}

function checkBump(sandbox: { work: string; baseSha: string; headSha: string }): Run {
  return runRepoScript(
    "check-version-bump.sh",
    [sandbox.baseSha, sandbox.headSha],
    { ...GIT_BASE, HOME: sandbox.work },
    sandbox.work,
  );
}

describe("scripts/check-version-bump.sh", () => {
  it.each<[string, Parameters<typeof bumpSandbox>[0], number]>([
    ["src/ changed, no bump", { base: "0.1.0", paths: ["src/a.ts"] }, 1],
    [
      "src/ changed, bump, three versions equal",
      { base: "0.1.0", paths: ["src/a.ts"], head: same("0.2.0") },
      0,
    ],
    [
      "src/ changed, bump, three versions differ",
      {
        base: "0.1.0",
        paths: ["src/a.ts"],
        head: { pkg: "0.2.0", plugin: "0.1.0", market: "0.2.0" },
      },
      1,
    ],
    [
      "src/ changed, bump, the marketplace version differs",
      {
        base: "0.1.0",
        paths: ["src/a.ts"],
        head: { pkg: "0.2.0", plugin: "0.2.0", market: "0.1.0" },
      },
      1,
    ],
    [
      "src/ changed, version lowered 0.2.0 to 0.1.0",
      { base: "0.2.0", paths: ["src/a.ts"], head: same("0.1.0") },
      1,
    ],
    ["only README.md changed, no bump", { base: "0.1.0", paths: ["README.md"] }, 0],
    [
      "a file moved from src/ to lib/, no bump",
      { base: "0.1.0", paths: [], moves: [["src/a.ts", "lib/a.ts"]] },
      1,
    ],
    ["prompts/ changed, no bump", { base: "0.1.0", paths: ["prompts/a.md"] }, 1],
    ["action.yml changed, no bump", { base: "0.1.0", paths: ["action.yml"] }, 1],
    ["only package-lock.json changed, no bump", { base: "0.1.0", paths: ["package-lock.json"] }, 1],
    [
      ".github/workflows/review.yml changed, no bump",
      { base: "0.1.0", paths: [".github/workflows/review.yml"] },
      1,
    ],
    [
      "src/ changed, bump of the patch number",
      { base: "0.1.9", paths: ["src/a.ts"], head: same("0.1.10") },
      0,
    ],
    [
      "src/ changed, a head version that is not MAJOR.MINOR.PATCH",
      { base: "0.1.0", paths: ["src/a.ts"], head: same("0.2") },
      1,
    ],
    [
      "only README.md changed on the branch, and main changed src/ after the branch point",
      { base: "0.1.0", paths: ["README.md"], mainPaths: ["src/b.ts"] },
      0,
    ],
  ])(
    "gives the expected exit code when %s",
    (_label, options, expected) => {
      const run = checkBump(bumpSandbox(options));
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(expected);
      if (expected === 1) oneLineReason(run);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------

interface ReleaseStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface ReleaseWorkflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { permissions?: unknown; steps: ReleaseStep[] }>;
}

describe(".github/workflows/release.yml", () => {
  const load = (): ReleaseWorkflow =>
    parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as ReleaseWorkflow;
  const steps = (): ReleaseStep[] => Object.values(load().jobs).flatMap((job) => job.steps);

  it("runs on a push to main and on a dispatch with the boolean input dry_run", () => {
    const on = load().on;
    expect(Object.keys(on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(on.push).toEqual({ branches: ["main"] });
    const dispatch = on.workflow_dispatch as { inputs: Record<string, { type?: string }> };
    expect(Object.keys(dispatch.inputs)).toEqual(["dry_run"]);
    expect(dispatch.inputs.dry_run?.type).toBe("boolean");
  });

  it("has only contents: write, at the workflow level", () => {
    const wf = load();
    expect(wf.permissions).toEqual({ contents: "write" });
    for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeUndefined();
  });

  it("has the concurrency group release with no cancel-in-progress", () => {
    expect(load().concurrency).toEqual({ group: "release", "cancel-in-progress": false });
  });

  it("checks out the full history with no persisted credentials", () => {
    const checkout = steps().find((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("runs only scripts/release-tag.sh, with GH_TOKEN and RELEASE_DRY_RUN in env", () => {
    const runs = steps().filter((s) => s.run !== undefined);
    expect(runs).toHaveLength(1);
    const step = runs[0] as ReleaseStep;
    expect(step.run).toContain("scripts/release-tag.sh");
    expect(step.run).not.toContain("${{");
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      RELEASE_DRY_RUN: "${{ inputs.dry_run }}",
    });
  });

  it("pins every uses value to a full commit SHA", () => {
    const uses = steps().flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const value of uses) expect(value).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  });
});
