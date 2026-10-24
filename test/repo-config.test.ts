import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_CONFIG,
  loadRepoConfig,
  parseRepoConfig,
  RepoConfigError,
  type RepoConfig,
} from "../src/config/repo-config.js";
import { readBlobAt } from "../src/gather/blob.js";
import {
  effectiveModel,
  effectivePasses,
  effectiveThreshold,
  loadBuiltinReviewers,
  type ReviewerDefinition,
} from "../src/reviewers/loader.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

// Git settings that keep the user's own git config out of the test repos.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.trim();
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** Make a repo with one commit that holds the files. Give the repo and the sha. */
async function repoWith(files: Record<string, string>): Promise<{ repo: string; sha: string }> {
  const repo = mkdtempSync(join(tmpdir(), "pr-review-config-"));
  roots.push(repo);
  await git(repo, "init", "--quiet", "--initial-branch=main");
  writeFiles(repo, { "README.md": "# r\n", ...files });
  await git(repo, "add", "-A");
  await git(repo, "commit", "--quiet", "--no-gpg-sign", "-m", "one");
  return { repo, sha: await git(repo, "rev-parse", "HEAD") };
}

/** Make a repo whose one commit holds the files and the symlinks (path to target). */
async function repoWithLinks(
  files: Record<string, string>,
  links: Record<string, string>,
): Promise<{ repo: string; sha: string }> {
  const repo = mkdtempSync(join(tmpdir(), "pr-review-config-"));
  roots.push(repo);
  await git(repo, "init", "--quiet", "--initial-branch=main");
  writeFiles(repo, { "README.md": "# r\n", ...files });
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    symlinkSync(target, join(repo, path));
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "--quiet", "--no-gpg-sign", "-m", "one");
  return { repo, sha: await git(repo, "rev-parse", "HEAD") };
}

async function loadError(files: Record<string, string>): Promise<RepoConfigError> {
  const { repo, sha } = await repoWith(files);
  try {
    await loadRepoConfig(repo, sha);
  } catch (err) {
    if (err instanceof RepoConfigError) return err;
    throw err;
  }
  throw new Error("Expected the config to fail to load.");
}

/** The config hash by spec R4, computed here apart from the code. */
function r4Hash(files: Record<string, string>): string {
  const paths = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const entries = paths.map((p) => Buffer.from(`${p}\n${files[p]}`, "utf8"));
  const parts: Buffer[] = [];
  entries.forEach((entry, i) => {
    if (i > 0) parts.push(Buffer.from([0]));
    parts.push(entry);
  });
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

const CUSTOM_REVIEWER = [
  "---",
  "name: migration-safety",
  "description: Checks migrations.",
  "model: sonnet",
  "effort: medium",
  "tools: [Read, Grep, Glob]",
  "triggers:",
  "  paths: []",
  "  categories: []",
  "  min_tier: fast",
  "passes: 1",
  "threshold: 85",
  "---",
  "You review migrations.",
  "",
].join("\n");

describe("loadRepoConfig: the base copy (R3)", () => {
  let fixture: { repo: string; base: string; head: string };
  let headWithConfig: string;

  beforeAll(async () => {
    const source = mkdtempSync(join(tmpdir(), "pr-review-config-src-"));
    roots.push(source);
    writeFiles(source, {
      "dir/config.yaml": "thresholds:\n  default: 70\nconcurrency: 2\n",
      "dir/rules.md": "Base rules.\n",
      "claude.md": "Base CLAUDE text.\n",
    });
    const { stdout } = await run("bash", [
      SCRIPT,
      "--pr-review-dir",
      join(source, "dir"),
      "--claude-md",
      join(source, "claude.md"),
    ]);
    const value = (key: string) =>
      stdout
        .split("\n")
        .find((l) => l.startsWith(`${key}=`))
        ?.slice(key.length + 1) ?? "";
    fixture = { repo: value("FIXTURE"), base: value("BASE"), head: value("HEAD") };
    roots.push(fixture.repo);
    // The head gets its own, different .pr-review/ directory.
    writeFiles(fixture.repo, {
      ".pr-review/config.yaml": "thresholds:\n  default: 95\nconcurrency: 9\n",
      ".pr-review/rules.md": "Head rules.\n",
      "CLAUDE.md": "Head CLAUDE text.\n",
    });
    await git(fixture.repo, "add", "-A");
    await git(fixture.repo, "commit", "--quiet", "--no-gpg-sign", "-m", "Head: change config");
    headWithConfig = await git(fixture.repo, "rev-parse", "HEAD");
  }, 30_000);

  it("loads the base commit's files, not the head's", async () => {
    expect(headWithConfig).not.toBe(fixture.head);
    const loaded = await loadRepoConfig(fixture.repo, fixture.base);
    expect(loaded.config.thresholds.default).toBe(70);
    expect(loaded.config.concurrency).toBe(2);
    expect(loaded.rulesMd).toBe("Base rules.\n");
    expect(loaded.claudeMd).toBe("Base CLAUDE text.\n");
    expect(loaded.files).toEqual([".pr-review/config.yaml", ".pr-review/rules.md"]);
    expect(loaded.hash).toBe(
      r4Hash({
        ".pr-review/config.yaml": "thresholds:\n  default: 70\nconcurrency: 2\n",
        ".pr-review/rules.md": "Base rules.\n",
      }),
    );
  });

  it("does not read the working tree, which holds the head copy", async () => {
    const loaded = await loadRepoConfig(fixture.repo, fixture.base);
    expect(loaded.config.thresholds.default).not.toBe(95);
    expect(await readBlobAt(fixture.repo, fixture.base, ".pr-review/rules.md")).toBe(
      "Base rules.\n",
    );
    expect(await readBlobAt(fixture.repo, headWithConfig, ".pr-review/rules.md")).toBe(
      "Head rules.\n",
    );
  });
});

describe("loadRepoConfig: defaults and files", () => {
  it("gives the defaults, no files and a null hash when .pr-review/ is absent", async () => {
    const { repo, sha } = await repoWith({});
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded).toEqual({
      config: DEFAULT_REPO_CONFIG,
      files: [],
      hash: null,
      rulesMd: null,
      claudeMd: null,
      customReviewers: [],
      warnings: [],
    });
  });

  it("fills every default from spec R3", () => {
    const expected: RepoConfig = {
      thresholds: { default: 80, middle_band: [60, 85] },
      reviewers: {},
      suppressions: [],
      sensitive_globs: [],
      generated_globs: [],
      skip: { draft: false, title_keywords: [], labels: [], bot_authors: [] },
      caps: { non_blocking_base: 3, non_blocking_per_hunks: 4, non_blocking_max: 20 },
      models: {},
      pre_existing: "off",
      concurrency: 5,
      token_ceiling: null,
    };
    expect(DEFAULT_REPO_CONFIG).toEqual(expected);
  });

  it("does not hash CLAUDE.md, and the hash is null with CLAUDE.md alone", async () => {
    const { repo, sha } = await repoWith({ "CLAUDE.md": "Rules.\n" });
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.claudeMd).toBe("Rules.\n");
    expect(loaded.hash).toBeNull();
    expect(loaded.files).toEqual([]);
  });

  it("hashes each loaded kind, in path byte order, with a NUL between entries", async () => {
    const files = {
      ".pr-review/rules.md": "Keep it short.\n",
      ".pr-review/reviewers/migration-safety.md": CUSTOM_REVIEWER,
      ".pr-review/config.yaml": "concurrency: 3\n",
    };
    const { repo, sha } = await repoWith({ ...files, "CLAUDE.md": "Not hashed.\n" });
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.files).toEqual([
      ".pr-review/config.yaml",
      ".pr-review/reviewers/migration-safety.md",
      ".pr-review/rules.md",
    ]);
    expect(loaded.hash).toBe(r4Hash(files));
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives a hash for rules.md alone", async () => {
    const { repo, sha } = await repoWith({ ".pr-review/rules.md": "R.\n" });
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.config).toEqual(DEFAULT_REPO_CONFIG);
    expect(loaded.hash).toBe(r4Hash({ ".pr-review/rules.md": "R.\n" }));
  });

  it("parses every key and keeps the values", async () => {
    const yaml = [
      "thresholds:",
      "  default: 75",
      "  middle_band: [50, 90]",
      "reviewers:",
      "  diff-bugs:",
      "    enabled: true",
      "    passes: 3",
      "    threshold: 85",
      "    model: sonnet",
      "    effort: High",
      "suppressions:",
      "  - reviewer: diff-bugs",
      "    path: 'src/legacy/**'",
      "    reason: Old code.",
      "  - category: docs",
      "    reason: No docs review.",
      "sensitive_globs: ['**/keys/**']",
      "generated_globs: ['**/gen/**']",
      "skip:",
      "  draft: true",
      "  title_keywords: [WIP]",
      "  labels: [no-review]",
      "  bot_authors: [dependabot]",
      "caps:",
      "  non_blocking_base: 1",
      "  non_blocking_per_hunks: 2",
      "  non_blocking_max: 5",
      "models:",
      "  triage:",
      "    model: haiku",
      "  verifier:",
      "    effort: max",
      "pre_existing: comment",
      "concurrency: 2",
      "token_ceiling: 100000",
      "",
    ].join("\n");
    const { repo, sha } = await repoWith({ ".pr-review/config.yaml": yaml });
    const { config } = await loadRepoConfig(repo, sha);
    expect(config).toEqual({
      thresholds: { default: 75, middle_band: [50, 90] },
      reviewers: {
        "diff-bugs": { enabled: true, passes: 3, threshold: 85, model: "sonnet", effort: "high" },
      },
      suppressions: [
        { reviewer: "diff-bugs", path: "src/legacy/**", reason: "Old code." },
        { category: "docs", reason: "No docs review." },
      ],
      sensitive_globs: ["**/keys/**"],
      generated_globs: ["**/gen/**"],
      skip: {
        draft: true,
        title_keywords: ["WIP"],
        labels: ["no-review"],
        bot_authors: ["dependabot"],
      },
      caps: { non_blocking_base: 1, non_blocking_per_hunks: 2, non_blocking_max: 5 },
      models: { triage: { model: "haiku" }, verifier: { effort: "max" } },
      pre_existing: "comment",
      concurrency: 2,
      token_ceiling: 100000,
    });
  });

  it("fills enabled with true for a reviewer entry that omits it", async () => {
    const { repo, sha } = await repoWith({
      ".pr-review/config.yaml": "reviewers:\n  diff-bugs:\n    passes: 2\n",
    });
    const { config } = await loadRepoConfig(repo, sha);
    expect(config.reviewers["diff-bugs"]).toEqual({ enabled: true, passes: 2 });
  });

  it("treats an empty config.yaml as the defaults and still hashes it", async () => {
    const { repo, sha } = await repoWith({ ".pr-review/config.yaml": "" });
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.config).toEqual(DEFAULT_REPO_CONFIG);
    expect(loaded.hash).toBe(r4Hash({ ".pr-review/config.yaml": "" }));
  });
});

describe("parseRepoConfig: the threshold and the middle band must agree", () => {
  const file = ".pr-review/config.yaml";
  const names = ["diff-bugs"];
  const failure = (text: string): RepoConfigError => {
    try {
      parseRepoConfig(text, file, names);
    } catch (err) {
      if (err instanceof RepoConfigError) return err;
      throw err;
    }
    throw new Error("expected a RepoConfigError");
  };

  it("rejects a default threshold above the upper bound of the default band", () => {
    const err = failure("thresholds:\n  default: 90\n");
    expect(err.file).toBe(file);
    expect(err.field).toBe("thresholds.middle_band");
    expect(err.message).toMatch(
      /upper bound of the band .* must be at least the default threshold/,
    );
  });

  it("rejects a reviewer threshold above the upper bound of the band", () => {
    const err = failure(
      "thresholds:\n  default: 80\n  middle_band: [60, 85]\nreviewers:\n  diff-bugs:\n    threshold: 90\n",
    );
    expect(err.file).toBe(file);
    expect(err.field).toBe("reviewers.diff-bugs.threshold");
    expect(err.message).toMatch(/upper bound/);
  });

  it("accepts the defaults, a default of 85, and a threshold at the upper bound", () => {
    expect(parseRepoConfig("", file, names)).toEqual(DEFAULT_REPO_CONFIG);
    expect(parseRepoConfig("thresholds:\n  default: 85\n", file, names).thresholds.default).toBe(
      85,
    );
    const config = parseRepoConfig("reviewers:\n  diff-bugs:\n    threshold: 85\n", file, names);
    expect(config.reviewers["diff-bugs"]?.threshold).toBe(85);
  });
});

describe("loadRepoConfig: validation errors name the file and the field (R3)", () => {
  it("fails when reviewers.<name>.threshold is below thresholds.default", async () => {
    const err = await loadError({
      ".pr-review/config.yaml":
        "thresholds:\n  default: 85\nreviewers:\n  diff-bugs:\n    threshold: 80\n",
    });
    expect(err.file).toBe(".pr-review/config.yaml");
    expect(err.field).toBe("reviewers.diff-bugs.threshold");
    expect(err.message).toContain(".pr-review/config.yaml");
    expect(err.message).toContain("reviewers.diff-bugs.threshold");
  });

  it("accepts reviewers.<name>.threshold at or above thresholds.default", async () => {
    const { repo, sha } = await repoWith({
      ".pr-review/config.yaml":
        "thresholds:\n  default: 85\nreviewers:\n  diff-bugs:\n    threshold: 85\n",
    });
    const { config } = await loadRepoConfig(repo, sha);
    expect(config.reviewers["diff-bugs"]?.threshold).toBe(85);
  });

  const cases: [string, string, string][] = [
    ["an unknown top-level key", "colour: blue\n", "colour"],
    ["an unknown nested key", "caps:\n  non_blocking_min: 1\n", "caps.non_blocking_min"],
    ["a default threshold above 100", "thresholds:\n  default: 101\n", "thresholds.default"],
    [
      "a band with low above high",
      "thresholds:\n  middle_band: [90, 60]\n",
      "thresholds.middle_band",
    ],
    ["a band with one value", "thresholds:\n  middle_band: [60]\n", "thresholds.middle_band"],
    [
      "an unknown reviewer key",
      "reviewers:\n  diff-bugs:\n    paths: []\n",
      "reviewers.diff-bugs.paths",
    ],
    ["passes of 0", "reviewers:\n  diff-bugs:\n    passes: 0\n", "reviewers.diff-bugs.passes"],
    [
      "a reviewer that does not exist",
      "reviewers:\n  nobody:\n    enabled: false\n",
      "reviewers.nobody",
    ],
    [
      "an unknown model alias",
      "reviewers:\n  diff-bugs:\n    model: gpt\n",
      "reviewers.diff-bugs.model",
    ],
    ["an unknown effort", "models:\n  merge:\n    effort: huge\n", "models.merge.effort"],
    ["an unknown role", "models:\n  smoke:\n    model: haiku\n", "models.smoke"],
    [
      "a suppression without reason",
      "suppressions:\n  - reviewer: diff-bugs\n",
      "suppressions.0.reason",
    ],
    ["a suppression with only a reason", "suppressions:\n  - reason: r\n", "suppressions.0"],
    ["a bad pre_existing value", "pre_existing: always\n", "pre_existing"],
    ["concurrency of 0", "concurrency: 0\n", "concurrency"],
    ["a token ceiling of 1.5", "token_ceiling: 1.5\n", "token_ceiling"],
    [
      "caps.non_blocking_per_hunks of 0",
      "caps:\n  non_blocking_per_hunks: 0\n",
      "caps.non_blocking_per_hunks",
    ],
    ["a list at the top", "- a\n", "(root)"],
  ];
  for (const [name, yaml, field] of cases) {
    it(`fails on ${name}`, async () => {
      const err = await loadError({ ".pr-review/config.yaml": yaml });
      expect(err.file).toBe(".pr-review/config.yaml");
      expect(err.field).toBe(field);
      expect(err.message).toContain(field);
    });
  }

  it("fails on YAML that does not parse", async () => {
    const err = await loadError({ ".pr-review/config.yaml": "thresholds: [1, 2\n" });
    expect(err.file).toBe(".pr-review/config.yaml");
    expect(err.field).toBe("(root)");
  });
});

describe("loadRepoConfig: custom reviewers", () => {
  it("loads a custom reviewer from the base commit with source custom", async () => {
    const { repo, sha } = await repoWith({
      ".pr-review/reviewers/migration-safety.md": CUSTOM_REVIEWER,
      ".pr-review/reviewers/notes.txt": "not a reviewer",
      ".pr-review/config.yaml": "reviewers:\n  migration-safety:\n    enabled: false\n",
    });
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.customReviewers).toHaveLength(1);
    const def = loaded.customReviewers[0] as ReviewerDefinition;
    expect(def.source).toBe("custom");
    expect(def.path).toBe(".pr-review/reviewers/migration-safety.md");
    expect(def.frontmatter.name).toBe("migration-safety");
    expect(def.frontmatter.trusted).toBe(false);
    expect(def.systemPrompt).toBe("You review migrations.\n");
    expect(loaded.config.reviewers["migration-safety"]).toEqual({ enabled: false });
  });

  it("fails when a custom reviewer has the name of a built-in reviewer", async () => {
    const err = await loadError({
      ".pr-review/reviewers/mine.md": CUSTOM_REVIEWER.replace(
        "name: migration-safety",
        "name: diff-bugs",
      ),
    });
    expect(err.file).toBe(".pr-review/reviewers/mine.md");
    expect(err.field).toBe("name");
  });

  it("fails when two custom reviewers have the same name", async () => {
    const err = await loadError({
      ".pr-review/reviewers/a.md": CUSTOM_REVIEWER,
      ".pr-review/reviewers/b.md": CUSTOM_REVIEWER,
    });
    expect(err.file).toBe(".pr-review/reviewers/b.md");
    expect(err.field).toBe("name");
  });

  it("fails on a custom reviewer with a bad frontmatter field", async () => {
    const err = await loadError({
      ".pr-review/reviewers/bad.md": CUSTOM_REVIEWER.replace("passes: 1", "passes: 0"),
    });
    expect(err.file).toBe(".pr-review/reviewers/bad.md");
    expect(err.field).toBe("passes");
  });
});

describe("effective reviewer values (R3, R6)", () => {
  const diffBugs = (): ReviewerDefinition => {
    const def = loadBuiltinReviewers().find((d) => d.frontmatter.name === "diff-bugs");
    if (!def) throw new Error("diff-bugs is missing");
    return def;
  };
  const withConfig = (patch: Partial<RepoConfig>): RepoConfig => ({
    ...DEFAULT_REPO_CONFIG,
    ...patch,
  });
  const withFrontmatter = (
    def: ReviewerDefinition,
    patch: Partial<ReviewerDefinition["frontmatter"]>,
  ): ReviewerDefinition => ({ ...def, frontmatter: { ...def.frontmatter, ...patch } });

  it("threshold: the config value when set, else the higher of the frontmatter and the default", () => {
    const def = withFrontmatter(diffBugs(), { threshold: 70 });
    expect(effectiveThreshold(def, DEFAULT_REPO_CONFIG)).toBe(80);
    expect(
      effectiveThreshold(def, withConfig({ thresholds: { default: 60, middle_band: [60, 85] } })),
    ).toBe(70);
    expect(
      effectiveThreshold(
        def,
        withConfig({ reviewers: { "diff-bugs": { enabled: true, threshold: 92 } } }),
      ),
    ).toBe(92);
  });

  it("model and effort: the reviewer key, then models.reviewer, then the role default", () => {
    const def = diffBugs();
    expect(effectiveModel(def, DEFAULT_REPO_CONFIG)).toEqual({
      model: "claude-opus-5-5",
      effort: "low",
    });
    const roleOnly = withConfig({ models: { reviewer: { model: "sonnet" } } });
    expect(effectiveModel(def, roleOnly)).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    const both = withConfig({
      models: { reviewer: { model: "sonnet", effort: "medium" } },
      reviewers: { "diff-bugs": { enabled: true, model: "haiku" } },
    });
    expect(effectiveModel(def, both)).toEqual({ model: "claude-haiku-5-5", effort: "medium" });
    const effortOnly = withConfig({
      reviewers: { "diff-bugs": { enabled: true, effort: "xhigh" } },
    });
    expect(effectiveModel(def, effortOnly)).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
  });

  it("model and effort: the frontmatter value applies when no config sets one, apart for each field", () => {
    const base = diffBugs();
    const only = withFrontmatter(base, { effort: "high" });
    expect(effectiveModel(only, DEFAULT_REPO_CONFIG)).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
    });
    const model = withFrontmatter(base, { model: "haiku" });
    expect(effectiveModel(model, DEFAULT_REPO_CONFIG)).toEqual({
      model: "claude-haiku-5-5",
      effort: "low",
    });
    const role = withConfig({ models: { reviewer: { effort: "medium" } } });
    expect(effectiveModel(only, role).effort).toBe("medium");
    const own = withConfig({
      models: { reviewer: { effort: "medium" } },
      reviewers: { "diff-bugs": { enabled: true, effort: "max" } },
    });
    expect(effectiveModel(only, own).effort).toBe("max");
  });

  it("reads only own keys of reviewers, so a prototype name gives the frontmatter values", () => {
    const def = withFrontmatter(diffBugs(), { name: "constructor", threshold: 85, passes: 2 });
    expect(effectiveThreshold(def, DEFAULT_REPO_CONFIG)).toBe(85);
    expect(effectivePasses(def, DEFAULT_REPO_CONFIG, "full")).toBe(2);
    expect(effectiveModel(def, DEFAULT_REPO_CONFIG)).toEqual({
      model: "claude-opus-5-5",
      effort: "low",
    });
  });

  it("passes: the config value when set, else the frontmatter, and 1 at the fast tier", () => {
    const def = withFrontmatter(diffBugs(), { passes: 2 });
    expect(effectivePasses(def, DEFAULT_REPO_CONFIG, "full")).toBe(2);
    const config = withConfig({ reviewers: { "diff-bugs": { enabled: true, passes: 4 } } });
    expect(effectivePasses(def, config, "full")).toBe(4);
    expect(effectivePasses(def, config, "fast")).toBe(1);
    expect(effectivePasses(def, DEFAULT_REPO_CONFIG, "fast")).toBe(1);
  });
});

describe("loadRepoConfig: suppressions name a known reviewer", () => {
  it("fails when suppressions[i].reviewer is not a built-in or custom reviewer", async () => {
    const err = await loadError({
      ".pr-review/config.yaml":
        "suppressions:\n  - path: a.ts\n    reason: ok\n  - reviewer: no-such-reviewer\n    reason: typo\n",
    });
    expect(err.file).toBe(".pr-review/config.yaml");
    expect(err.field).toBe("suppressions.1.reviewer");
    expect(err.message).toContain("suppressions.1.reviewer");
  });

  it("accepts a built-in reviewer name and a custom reviewer name", async () => {
    const { repo, sha } = await repoWith({
      ".pr-review/reviewers/migration-safety.md": CUSTOM_REVIEWER,
      ".pr-review/config.yaml":
        "suppressions:\n  - reviewer: diff-bugs\n    reason: a\n  - reviewer: migration-safety\n    reason: b\n",
    });
    const { config } = await loadRepoConfig(repo, sha);
    expect(config.suppressions.map((s) => s.reviewer)).toEqual(["diff-bugs", "migration-safety"]);
  });
});

describe("loadRepoConfig: a config path that is not a regular file", () => {
  async function errorOf(repo: string, sha: string): Promise<RepoConfigError> {
    try {
      await loadRepoConfig(repo, sha);
    } catch (err) {
      if (err instanceof RepoConfigError) return err;
      throw err;
    }
    throw new Error("Expected the config to fail to load.");
  }

  it("fails on a symlink at .pr-review/config.yaml and names the mode", async () => {
    const { repo, sha } = await repoWithLinks(
      { "elsewhere.yaml": "caps: {}\n" },
      {
        ".pr-review/config.yaml": "../elsewhere.yaml",
      },
    );
    const err = await errorOf(repo, sha);
    expect(err.file).toBe(".pr-review/config.yaml");
    expect(err.field).toBe("(root)");
    expect(err.message).toContain("120000");
  });

  it("fails on a symlink at .pr-review/rules.md", async () => {
    const { repo, sha } = await repoWithLinks(
      { "elsewhere.md": "rules\n" },
      {
        ".pr-review/rules.md": "../elsewhere.md",
      },
    );
    const err = await errorOf(repo, sha);
    expect(err.file).toBe(".pr-review/rules.md");
    expect(err.field).toBe("(root)");
    expect(err.message).toContain("120000");
  });

  it("fails on a symlink under .pr-review/reviewers/", async () => {
    const { repo, sha } = await repoWithLinks(
      { "elsewhere.md": CUSTOM_REVIEWER },
      {
        ".pr-review/reviewers/linked.md": "../../elsewhere.md",
      },
    );
    const err = await errorOf(repo, sha);
    expect(err.file).toBe(".pr-review/reviewers/linked.md");
    expect(err.field).toBe("(root)");
    expect(err.message).toContain("120000");
  });

  it("fails on a submodule entry at .pr-review/config.yaml", async () => {
    const { repo } = await repoWith({});
    const oid = "1".repeat(40);
    await git(repo, "update-index", "--add", "--cacheinfo", `160000,${oid},.pr-review/config.yaml`);
    await git(repo, "commit", "--quiet", "--no-gpg-sign", "-m", "two");
    const err = await errorOf(repo, await git(repo, "rev-parse", "HEAD"));
    expect(err.file).toBe(".pr-review/config.yaml");
    expect(err.field).toBe("(root)");
    expect(err.message).toContain("160000");
  });

  it("fails on a symlinked .pr-review directory, also when the target holds an invalid config", async () => {
    const { repo, sha } = await repoWithLinks(
      { "real/config.yaml": "concurrency: 0\n" },
      { ".pr-review": "real" },
    );
    const err = await errorOf(repo, sha);
    expect(err.file).toBe(".pr-review");
    expect(err.field).toBe("(root)");
    expect(err.message).toContain("120000");
    expect(err.message).toContain("must be a directory");
  });

  it("fails on a submodule entry at .pr-review", async () => {
    const { repo } = await repoWith({});
    const oid = "1".repeat(40);
    await git(repo, "update-index", "--add", "--cacheinfo", `160000,${oid},.pr-review`);
    await git(repo, "commit", "--quiet", "--no-gpg-sign", "-m", "two");
    const err = await errorOf(repo, await git(repo, "rev-parse", "HEAD"));
    expect(err.file).toBe(".pr-review");
    expect(err.field).toBe("(root)");
    expect(err.message).toContain("160000");
    expect(err.message).toContain("must be a directory");
  });

  it("fails on a symlinked .pr-review/reviewers directory", async () => {
    const { repo, sha } = await repoWithLinks(
      { "real/linked.md": CUSTOM_REVIEWER, ".pr-review/config.yaml": "caps: {}\n" },
      { ".pr-review/reviewers": "../real" },
    );
    const err = await errorOf(repo, sha);
    expect(err.file).toBe(".pr-review/reviewers");
    expect(err.field).toBe("(root)");
    expect(err.message).toContain("120000");
    expect(err.message).toContain("must be a directory");
  });

  it("still gives the defaults when the paths are absent", async () => {
    const { repo, sha } = await repoWithLinks({}, {});
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.config).toEqual(DEFAULT_REPO_CONFIG);
  });
});

describe("loadRepoConfig: a symlinked root CLAUDE.md", () => {
  it("reads the target when the link points at a file in the tree", async () => {
    const { repo, sha } = await repoWithLinks(
      { "AGENTS.md": "Agents text.\n" },
      { "CLAUDE.md": "AGENTS.md" },
    );
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.claudeMd).toBe("Agents text.\n");
    expect(loaded.warnings).toEqual([]);
  });

  it("resolves a ./ target and a target in a subdirectory", async () => {
    const dot = await repoWithLinks({ "AGENTS.md": "Dot.\n" }, { "CLAUDE.md": "./AGENTS.md" });
    expect((await loadRepoConfig(dot.repo, dot.sha)).claudeMd).toBe("Dot.\n");
    const sub = await repoWithLinks(
      { "docs/a.md": "Sub.\n" },
      { "CLAUDE.md": "docs/../docs/a.md" },
    );
    expect((await loadRepoConfig(sub.repo, sub.sha)).claudeMd).toBe("Sub.\n");
  });

  it("gives null and one warning when the target leaves the repo root", async () => {
    const { repo, sha } = await repoWithLinks({}, { "CLAUDE.md": "../outside" });
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.claudeMd).toBeNull();
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("CLAUDE.md is a symlink to ../outside");
    expect(loaded.warnings[0]).toContain("not a regular file in the base tree");
  });

  it("gives null and one warning for an absolute target", async () => {
    const { repo, sha } = await repoWithLinks({}, { "CLAUDE.md": "/etc/passwd" });
    const loaded = await loadRepoConfig(repo, sha);
    expect(loaded.claudeMd).toBeNull();
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("/etc/passwd");
  });

  it("gives null and one warning when the target is absent, a directory or a second link", async () => {
    const missing = await repoWithLinks({}, { "CLAUDE.md": "NOPE.md" });
    const dir = await repoWithLinks({ "docs/a.md": "x\n" }, { "CLAUDE.md": "docs" });
    const chain = await repoWithLinks(
      { "AGENTS.md": "x\n" },
      { "CLAUDE.md": "MID.md", "MID.md": "AGENTS.md" },
    );
    for (const { repo, sha } of [missing, dir, chain]) {
      const loaded = await loadRepoConfig(repo, sha);
      expect(loaded.claudeMd).toBeNull();
      expect(loaded.warnings).toHaveLength(1);
    }
  });

  it("gives no warning when CLAUDE.md is absent or a regular file", async () => {
    const absent = await repoWith({});
    expect((await loadRepoConfig(absent.repo, absent.sha)).warnings).toEqual([]);
    const plain = await repoWith({ "CLAUDE.md": "Plain.\n" });
    const loaded = await loadRepoConfig(plain.repo, plain.sha);
    expect(loaded.claudeMd).toBe("Plain.\n");
    expect(loaded.warnings).toEqual([]);
  });
});
