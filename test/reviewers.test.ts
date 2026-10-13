import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROLE_DEFAULTS } from "../src/config/models.js";
import { FindingsOutputSchema } from "../src/schemas/finding.js";
import { VerifierResultSchema } from "../src/schemas/verifier.js";
import type { QueryRequest } from "../src/sdk/client.js";
import { buildQueryOptions } from "../src/sdk/options.js";
import {
  loadBuiltinReviewers,
  loadReviewer,
  ReviewerLoadError,
  reviewerOverrides,
  type ReviewerDefinition,
} from "../src/reviewers/loader.js";
import { selectReviewers } from "../src/reviewers/select.js";
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

describe("built-in reviewers (A4)", () => {
  it("loads diff-bugs with the shipped values", () => {
    const defs = loadBuiltinReviewers();
    expect(defs.map((d) => d.frontmatter.name)).toEqual(["diff-bugs"]);
    const def = defs[0] as ReviewerDefinition;
    expect(def.frontmatter).toMatchObject({
      name: "diff-bugs",
      model: "opus",
      effort: "low",
      passes: 1,
      threshold: 80,
      triggers: { paths: [], categories: [], min_tier: "fast" },
    });
    expect(def.path).toMatch(/prompts[/\\]reviewers[/\\]diff-bugs\.md$/);
  });

  it("uses the body as the system prompt, with the prompt rules", () => {
    const def = loadBuiltinReviewers()[0] as ReviewerDefinition;
    const prompt = def.systemPrompt;
    expect(prompt).not.toMatch(/^---/);
    expect(prompt).toContain(UNTRUSTED_SYSTEM_LINE);
    expect(prompt).toMatch(/every issue/i);
    expect(prompt).toMatch(/confidence/i);
    expect(prompt).toMatch(/severity/i);
    expect(prompt).toMatch(/quote/i);
    expect(prompt).toMatch(/subagent/i);
    expect(prompt.split("\n").length).toBeLessThan(80);
  });
});

describe("loadReviewer", () => {
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

describe("selectReviewers", () => {
  function def(
    name: string,
    triggers: Partial<ReviewerDefinition["frontmatter"]["triggers"]> = {},
  ): ReviewerDefinition {
    return {
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

  it("selects the built-in diff-bugs in the fast and the full tier", () => {
    const builtins = loadBuiltinReviewers();
    expect(names(selectReviewers(builtins, "fast", ["src/stats.ts"], []))).toEqual(["diff-bugs"]);
    expect(names(selectReviewers(builtins, "full", ["src/stats.ts"], ["bug"]))).toEqual([
      "diff-bugs",
    ]);
  });
});
