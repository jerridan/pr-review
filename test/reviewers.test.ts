import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { ROLE_DEFAULTS } from "../src/config/models.js";
import { FindingsOutputSchema } from "../src/schemas/finding.js";
import { VerifierResultSchema } from "../src/schemas/verifier.js";
import type { QueryRequest } from "../src/sdk/client.js";
import { buildQueryOptions } from "../src/sdk/options.js";
import {
  loadBuiltinReviewers,
  loadReviewer,
  parseReviewer,
  ReviewerLoadError,
  reviewerOverrides,
  reviewerTools,
  type ReviewerDefinition,
} from "../src/reviewers/loader.js";
import { selectReviewers, skipSelected } from "../src/reviewers/select.js";
import { UNTRUSTED_SYSTEM_LINE } from "../src/untrusted.js";

const dir = mkdtempSync(join(tmpdir(), "pr-review-reviewers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GOOD_FRONTMATTER = [
  "name: test-reviewer",
  "description: A reviewer for tests.",
  "model: sonnet",
  "effort: medium",
  "tools: [Read, Grep, Glob]",
  "triggers:",
  "  paths: []",
  "  categories: []",
  "  min_tier: fast",
  "passes: 2",
  "threshold: 70",
  "trusted: false",
];

let fileCount = 0;
function writeReviewer(frontmatter: string[] | null, body = "You review code.\n"): string {
  fileCount += 1;
  const path = join(dir, `reviewer-${fileCount}.md`);
  const text = frontmatter === null ? body : `---\n${frontmatter.join("\n")}\n---\n${body}`;
  writeFileSync(path, text);
  return path;
}

function withField(name: string, line: string | null): string[] {
  const out = GOOD_FRONTMATTER.filter((l) => !l.startsWith(`${name}:`));
  return line === null ? out : [...out, line];
}

function loadError(path: string): ReviewerLoadError {
  try {
    loadReviewer(path);
  } catch (err) {
    if (err instanceof ReviewerLoadError) return err;
    throw err;
  }
  throw new Error(`Expected ${path} to fail to load.`);
}

// The built-in reviewers of spec R1, in file name order, with their triggers.
const BUILTINS: { name: string; minTier: "fast" | "full"; passes: number }[] = [
  { name: "conventions", minTier: "fast", passes: 1 },
  { name: "description-drift", minTier: "full", passes: 1 },
  { name: "diff-bugs", minTier: "fast", passes: 2 },
  { name: "docs-and-comments", minTier: "full", passes: 1 },
  { name: "history", minTier: "full", passes: 1 },
  { name: "security", minTier: "full", passes: 2 },
  { name: "tests", minTier: "full", passes: 1 },
];

const PATH_RULE =
  "the path from the repo root, without the a/ or b/ prefix of the diff and without a leading /";

function builtin(name: string): ReviewerDefinition {
  const def = loadBuiltinReviewers().find((d) => d.frontmatter.name === name);
  if (!def) throw new Error(`no built-in reviewer ${name}`);
  return def;
}

// The text of one section of a body: from its "## " heading to the next.
function section(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length + 4);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("built-in reviewers (A4, R1)", () => {
  it("loads the seven reviewers, in file name order", () => {
    expect(loadBuiltinReviewers().map((d) => d.frontmatter.name)).toEqual(
      BUILTINS.map((b) => b.name),
    );
  });

  for (const { name, minTier, passes } of BUILTINS) {
    describe(name, () => {
      it("has the frontmatter of spec R1", () => {
        const def = builtin(name);
        expect(def.frontmatter).toEqual({
          name,
          description: expect.any(String),
          model: "opus",
          effort: "low",
          tools: ["Read", "Grep", "Glob"],
          triggers: { paths: [], categories: [], min_tier: minTier },
          passes,
          threshold: 80,
          trusted: false,
        });
        expect(def.frontmatter.description.trim()).not.toBe("");
        expect(def.source).toBe("builtin");
        expect(def.path).toMatch(new RegExp(`prompts[/\\\\]reviewers[/\\\\]${name}\\.md$`));
        // The file omits the trusted key; the schema fills in false.
        expect(readFileSync(def.path, "utf8")).not.toMatch(/^trusted:/m);
      });

      it("uses the body as the system prompt, with the prompt rules", () => {
        const prompt = builtin(name).systemPrompt;
        expect(prompt).not.toMatch(/^---/);
        expect(prompt).toContain(UNTRUSTED_SYSTEM_LINE);
        expect(prompt).toMatch(/every issue/i);
        expect(prompt).toMatch(/confidence/i);
        expect(prompt).toMatch(/severity/i);
        expect(prompt).toMatch(/quote/i);
        expect(prompt).toMatch(/subagent/i);
        expect(prompt).toMatch(/lint or formatting/i);
        expect(prompt.split("\n").length).toBeLessThan(80);
      });

      it("tells the reviewer to give the file path without the diff prefix or a leading /", () => {
        expect(builtin(name).systemPrompt).toContain(PATH_RULE);
      });

      it("has a Do not flag section with content", () => {
        const body = builtin(name).systemPrompt;
        expect(body).toContain("\n## Do not flag\n");
        expect(section(body, "Do not flag").trim()).not.toBe("");
      });
    });
  }

  it("lists in each Do not flag section what spec R1 gives", () => {
    const doNotFlag = (name: string) => section(builtin(name).systemPrompt, "Do not flag");
    expect(doNotFlag("diff-bugs")).toMatch(/security/i);
    expect(doNotFlag("diff-bugs")).toMatch(/test/i);
    expect(doNotFlag("diff-bugs")).toMatch(/docs/i);
    expect(doNotFlag("diff-bugs")).toMatch(/convention/i);
    expect(doNotFlag("conventions")).toMatch(/logic bug/i);
    expect(doNotFlag("conventions")).toMatch(/missing test/i);
    expect(doNotFlag("conventions")).toMatch(/security/i);
    expect(doNotFlag("conventions")).toMatch(/linter or a formatter/i);
    expect(doNotFlag("tests")).toMatch(/logic bug/i);
    expect(doNotFlag("tests")).toMatch(/naming/i);
    expect(doNotFlag("security")).toMatch(/no security effect/i);
    expect(doNotFlag("history")).toMatch(/does not show/i);
    expect(doNotFlag("description-drift")).toMatch(/code itself/i);
    expect(doNotFlag("docs-and-comments")).toMatch(/no comment or doc/i);
  });

  it("names the evidence source of each reviewer", () => {
    const opening = (name: string) => builtin(name).systemPrompt.split("\n## ")[0] ?? "";
    expect(opening("conventions")).toMatch(/CLAUDE\.md/);
    expect(opening("conventions")).toMatch(/rules\.md/);
    expect(opening("conventions")).toMatch(/nearby code/i);
    expect(opening("tests")).toMatch(/test/i);
    expect(opening("security")).toContain(".pr-review/");
    expect(opening("history")).toMatch(/history block/i);
    expect(opening("description-drift")).toMatch(/description block/i);
    expect(opening("docs-and-comments")).toMatch(/comments/i);
    expect(opening("diff-bugs")).toMatch(/diff and the files of the head commit/);
  });

  it("tells the history reviewer that the block holds blame and log at the merge base, and never to quote it", () => {
    const body = builtin("history").systemPrompt;
    expect(body).toMatch(/blame/i);
    expect(body).toMatch(/merge base/i);
    expect(body).toMatch(/never quote the history block/i);
    expect(body).toMatch(/head file or .*diff/i);
  });

  it("tells the description-drift reviewer what to report and where to quote from", () => {
    const body = builtin("description-drift").systemPrompt;
    expect(body).toMatch(/does not keep/i);
    expect(body).toMatch(/does not mention/i);
    expect(body).toMatch(/never quote the description block/i);
  });
});

describe("loadReviewer", () => {
  it("makes trusted optional, with the default false", () => {
    const def = loadReviewer(writeReviewer(withField("trusted", null)));
    expect(def.frontmatter.trusted).toBe(false);
    expect(loadError(writeReviewer(withField("trusted", "trusted: maybe"))).message).toMatch(
      /trusted/,
    );
  });

  it("marks a built-in reviewer with source builtin, and a custom one as told", () => {
    expect(loadBuiltinReviewers().every((d) => d.source === "builtin")).toBe(true);
    expect(loadReviewer(writeReviewer(GOOD_FRONTMATTER)).source).toBe("builtin");
    expect(
      parseReviewer(`---\n${GOOD_FRONTMATTER.join("\n")}\n---\nBody.\n`, "x.md", "custom"),
    ).toMatchObject({
      source: "custom",
      path: "x.md",
      systemPrompt: "Body.\n",
    });
  });

  it("reads passes, threshold and trusted", () => {
    const def = loadReviewer(writeReviewer(withField("trusted", "trusted: true")));
    expect(def.frontmatter.passes).toBe(2);
    expect(def.frontmatter.threshold).toBe(70);
    expect(def.frontmatter.trusted).toBe(true);
    expect(def.systemPrompt).toBe("You review code.\n");
  });

  it("rejects a malformed file with a clear error that names the file and the field", () => {
    const path = writeReviewer(withField("threshold", "threshold: 150"));
    const err = loadError(path);
    expect(err.path).toBe(path);
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.message).toContain(path);
    expect(err.message).toContain("threshold");
  });

  it("rejects a missing field, a bad effort and an unknown key", () => {
    expect(loadError(writeReviewer(withField("name", null))).message).toContain("name");
    expect(loadError(writeReviewer(withField("effort", "effort: huge"))).message).toContain(
      "effort",
    );
    expect(loadError(writeReviewer([...GOOD_FRONTMATTER, "colour: red"])).message).toContain(
      "colour",
    );
  });

  it("rejects an unknown model alias", () => {
    const err = loadError(writeReviewer(withField("model", "model: gpt")));
    expect(err.message).toContain("model");
  });

  it("rejects a file with no frontmatter, bad YAML or an empty body", () => {
    expect(loadError(writeReviewer(null)).message).toMatch(/frontmatter/i);
    expect(loadError(writeReviewer(["name: [x"])).path).toContain("reviewer-");
    expect(loadError(writeReviewer(GOOD_FRONTMATTER, "\n  \n")).message).toMatch(/body/i);
  });

  it("rejects a file that does not exist", () => {
    expect(loadError(join(dir, "missing.md")).message).toContain("missing.md");
  });
});

describe("model overrides from frontmatter", () => {
  it("maps an alias to the pinned ID", () => {
    const def = loadReviewer(writeReviewer(withField("model", "model: haiku")));
    expect(reviewerOverrides(def)).toEqual({ model: "claude-haiku-5-5", effort: "medium" });
    const builtin = loadBuiltinReviewers()[0] as ReviewerDefinition;
    expect(reviewerOverrides(builtin)).toEqual({ model: "claude-opus-5-5", effort: "low" });
  });

  it("passes an exact ID through", () => {
    const def = loadReviewer(writeReviewer(withField("model", "model: claude-opus-4-1-20250805")));
    expect(reviewerOverrides(def).model).toBe("claude-opus-4-1-20250805");
  });

  it("changes the model for that reviewer only", () => {
    const sonnet = loadReviewer(writeReviewer(GOOD_FRONTMATTER));
    const builtin = loadBuiltinReviewers()[0] as ReviewerDefinition;
    const base = { systemPrompt: "s", userMessage: "u", cwd: "/tmp/head" };
    const req = (def: ReviewerDefinition): QueryRequest => ({
      ...base,
      role: "reviewer",
      reviewerName: def.frontmatter.name,
      schema: FindingsOutputSchema,
      overrides: reviewerOverrides(def),
    });
    const env = { allowApiKey: false, env: {} };
    expect(buildQueryOptions(req(sonnet), env).model).toBe("claude-sonnet-5-5");
    expect(buildQueryOptions(req(sonnet), env).effort).toBe("medium");
    expect(buildQueryOptions(req(builtin), env).model).toBe("claude-opus-5-5");
    const verifier = buildQueryOptions(
      { ...base, role: "verifier", schema: VerifierResultSchema },
      env,
    );
    expect(verifier.model).toBe("claude-sonnet-5-5");
    expect(verifier.effort).toBe("high");
    expect(ROLE_DEFAULTS.reviewer.model).toBe("claude-opus-5-5");
  });
});

describe("the tools of a reviewer", () => {
  function withTools(tools: string[]): ReviewerDefinition {
    const def = loadReviewer(writeReviewer(GOOD_FRONTMATTER));
    return { ...def, frontmatter: { ...def.frontmatter, tools } };
  }

  const noBash = { bashGranted: false, bashReason: null };

  it("grants the read-only tools that the reviewer names, in canonical form", () => {
    expect(reviewerTools(withTools(["Read", "Grep", "Glob"]), false)).toEqual({
      granted: ["Read", "Grep", "Glob"],
      ignored: [],
      ...noBash,
    });
    expect(reviewerTools(withTools(["glob", "READ"]), true)).toEqual({
      granted: ["Read", "Glob"],
      ignored: [],
      ...noBash,
    });
    expect(reviewerTools(withTools([]), false)).toEqual({ granted: [], ignored: [], ...noBash });
  });

  it("ignores a tool outside the read-only set and never grants it", () => {
    expect(reviewerTools(withTools(["Bash", "Read", "WebFetch", "Write"]), false)).toEqual({
      granted: ["Read"],
      ignored: ["Bash", "WebFetch", "Write"],
      ...noBash,
    });
  });

  describe("the Bash policy (R7)", () => {
    function custom(trusted: boolean, tools = ["Read", "Bash", "Write"]): ReviewerDefinition {
      const def = withTools(tools);
      return { ...def, source: "custom", frontmatter: { ...def.frontmatter, trusted } };
    }

    it("grants Bash to a trusted custom reviewer when the author has write access", () => {
      expect(reviewerTools(custom(true), true)).toEqual({
        granted: ["Read", "Bash"],
        ignored: ["Write"],
        bashGranted: true,
        bashReason: null,
      });
    });

    it("does not grant Bash to a custom reviewer that is not trusted", () => {
      expect(reviewerTools(custom(false), true)).toEqual({
        granted: ["Read"],
        ignored: ["Bash", "Write"],
        bashGranted: false,
        bashReason: "not trusted",
      });
    });

    it("does not grant Bash when the author has no write access", () => {
      expect(reviewerTools(custom(true), false)).toMatchObject({
        granted: ["Read"],
        bashGranted: false,
        bashReason: "author has no write access",
      });
    });

    it("joins both reasons with and", () => {
      expect(reviewerTools(custom(false), false)).toMatchObject({
        bashGranted: false,
        bashReason: "not trusted and author has no write access",
      });
    });

    it("matches the Bash name without regard to case", () => {
      expect(reviewerTools(custom(true, ["bash"]), true)).toMatchObject({
        granted: ["Bash"],
        ignored: [],
        bashGranted: true,
      });
    });

    it("gives no reason for a custom reviewer whose tools do not name Bash", () => {
      expect(reviewerTools(custom(false, ["Read"]), false)).toEqual({
        granted: ["Read"],
        ignored: [],
        bashGranted: false,
        bashReason: null,
      });
    });

    it("never grants Bash to a built-in reviewer, whatever trusted says", () => {
      const builtinDef = { ...custom(true), source: "builtin" as const };
      expect(reviewerTools(builtinDef, true)).toEqual({
        granted: ["Read"],
        ignored: ["Bash", "Write"],
        bashGranted: false,
        bashReason: null,
      });
    });
  });

  it("narrows the query options of the reviewer to its granted tools", () => {
    const def = withTools(["Read", "Bash"]);
    const opts = buildQueryOptions(
      {
        role: "reviewer",
        reviewerName: def.frontmatter.name,
        systemPrompt: def.systemPrompt,
        userMessage: "u",
        schema: FindingsOutputSchema,
        cwd: "/tmp/x",
        overrides: reviewerOverrides(def),
        tools: def.frontmatter.tools,
      },
      { allowApiKey: false, env: {} },
    );
    expect(opts.tools).toEqual(["Read"]);
    expect(opts.allowedTools).toEqual(["Read(./**)"]);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Grep", "Glob"]));
  });

  it("keeps trusted parsed but unused", () => {
    const def = withTools(["Read"]);
    const opts = buildQueryOptions(
      {
        role: "reviewer",
        systemPrompt: "s",
        userMessage: "u",
        schema: FindingsOutputSchema,
        cwd: "/tmp/x",
        tools: def.frontmatter.tools,
      },
      { allowApiKey: false, env: {} },
    );
    expect(def.frontmatter.trusted).toBe(false);
    expect(JSON.stringify(opts)).not.toMatch(/trusted/);
  });
});

describe("selectReviewers", () => {
  function def(
    name: string,
    triggers: Partial<ReviewerDefinition["frontmatter"]["triggers"]> = {},
  ): ReviewerDefinition {
    return {
      source: "builtin",
      path: `/x/${name}.md`,
      systemPrompt: "p",
      frontmatter: {
        name,
        description: "d",
        model: "opus",
        effort: "low",
        tools: [],
        triggers: { paths: [], categories: [], min_tier: "fast", ...triggers },
        passes: 1,
        threshold: 80,
        trusted: true,
      },
    };
  }
  const names = (picked: { def: ReviewerDefinition }[]) =>
    picked.map((p) => p.def.frontmatter.name);

  it("picks a reviewer when min_tier is at or below the tier", () => {
    const defs = [def("fast-one"), def("full-one", { min_tier: "full" })];
    expect(names(selectReviewers(defs, "fast", ["a.ts"], []))).toEqual(["fast-one"]);
    expect(names(selectReviewers(defs, "full", ["a.ts"], []))).toEqual(["fast-one", "full-one"]);
    expect(selectReviewers(defs, "skip", ["a.ts"], [])).toEqual([]);
  });

  it("needs a changed file to match a path glob when paths is not empty", () => {
    const defs = [def("ts-only", { paths: ["**/*.ts"] }), def("py-only", { paths: ["**/*.py"] })];
    expect(names(selectReviewers(defs, "full", ["src/a.ts", "README.md"], []))).toEqual([
      "ts-only",
    ]);
  });

  it("needs a triage category to match, case-insensitively, when categories is not empty", () => {
    const defs = [def("sec", { categories: ["security"] }), def("docs", { categories: ["docs"] })];
    expect(names(selectReviewers(defs, "full", ["a.ts"], ["Security", "bug"]))).toEqual(["sec"]);
    expect(selectReviewers(defs, "full", ["a.ts"], [])).toEqual([]);
  });

  it("needs every trigger to match", () => {
    const both = [def("both", { paths: ["src/**"], categories: ["bug"], min_tier: "full" })];
    expect(names(selectReviewers(both, "full", ["src/a.ts"], ["bug"]))).toEqual(["both"]);
    expect(selectReviewers(both, "fast", ["src/a.ts"], ["bug"])).toEqual([]);
    expect(selectReviewers(both, "full", ["lib/a.ts"], ["bug"])).toEqual([]);
    expect(selectReviewers(both, "full", ["src/a.ts"], ["docs"])).toEqual([]);
  });

  it("states the trigger that picked each reviewer", () => {
    const [plain] = selectReviewers([def("diff-bugs")], "fast", ["a.ts"], []);
    expect(plain?.trigger).toMatch(/min_tier fast/);
    const [picked] = selectReviewers(
      [def("ts", { paths: ["**/*.ts"], categories: ["bug"] })],
      "full",
      ["src/a.ts"],
      ["BUG"],
    );
    expect(picked?.trigger).toContain("src/a.ts");
    expect(picked?.trigger).toContain("**/*.ts");
    expect(picked?.trigger).toContain("bug");
  });

  it("skips a disabled reviewer, and the description reviewer when the description is empty", () => {
    const picked = [def("diff-bugs"), def("description-drift"), def("tests")].map((d) => ({
      def: d,
      trigger: "t",
    }));
    const config = {
      ...DEFAULT_REPO_CONFIG,
      reviewers: { tests: { enabled: false } },
    };
    const empty = skipSelected(picked, { config, description: "  \n" });
    expect(names(empty.run)).toEqual(["diff-bugs"]);
    expect(empty.skipped).toEqual([
      { name: "description-drift", reason: "no description" },
      { name: "tests", reason: "disabled by config" },
    ]);
    const described = skipSelected(picked, { config, description: "Adds average." });
    expect(names(described.run)).toEqual(["diff-bugs", "description-drift"]);
    expect(described.skipped).toEqual([{ name: "tests", reason: "disabled by config" }]);
    // A disabled description reviewer gives the config reason.
    const off = skipSelected(picked, {
      config: { ...DEFAULT_REPO_CONFIG, reviewers: { "description-drift": { enabled: false } } },
      description: "",
    });
    expect(off.skipped).toEqual([{ name: "description-drift", reason: "disabled by config" }]);
    // A reviewer that was not selected is in neither list.
    expect(skipSelected([], { config, description: "" })).toEqual({ run: [], skipped: [] });
  });

  it("selects conventions and diff-bugs at the fast tier, and all seven at the full tier", () => {
    const builtins = loadBuiltinReviewers();
    expect(names(selectReviewers(builtins, "fast", ["src/stats.ts"], []))).toEqual([
      "conventions",
      "diff-bugs",
    ]);
    expect(names(selectReviewers(builtins, "full", ["src/stats.ts"], []))).toEqual(
      BUILTINS.map((b) => b.name),
    );
  });
});
