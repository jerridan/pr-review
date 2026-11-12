// R3: the pool prompt files and the pins of the pool roles.
import { describe, expect, it } from "vitest";
import { ROLES, roleConfig } from "../src/config/models.js";
import { loadPrompt } from "../src/prompts/load.js";
import { UNTRUSTED_SYSTEM_LINE } from "../src/untrusted.js";

describe("the pool prompt files", () => {
  it.each([
    [
      "pool-review.md",
      "pool-reviewer",
      ["{{title}}", "{{body}}", "{{changed_files}}", "{{diff}}"],
      ["cut_text", "kind", "role", "user_message"],
    ],
    ["pool-group.md", "pool-grouper", ["{{items}}"], ["kind", "role", "user_message"]],
    [
      "pool-adjudicate.md",
      "adjudicator",
      ["{{finding}}", "{{diff}}"],
      ["cut_text", "kind", "role", "user_message"],
    ],
  ])("%s has its frontmatter keys", (file, role, tokens, keys) => {
    const p = loadPrompt(file);
    expect(Object.keys(p.frontmatter).sort()).toEqual(keys);
    expect(p.frontmatter.role).toBe(role);
    expect(p.frontmatter.kind).toBe("system");
    for (const token of tokens) expect(p.frontmatter.user_message).toContain(token);
    expect(p.body).toContain(UNTRUSTED_SYSTEM_LINE);
  });

  it("asks the adjudicator to score below 50 a claim that rests only on lines the PR does not change", () => {
    expect(loadPrompt("pool-adjudicate.md").body).toMatch(/below 50/);
  });
});

describe("the pins of the pool roles", () => {
  it("pins the blind reviewer and the adjudicator on Opus at high effort with read-only tools", () => {
    for (const role of ["pool-reviewer", "adjudicator"] as const) {
      expect(roleConfig(role)).toMatchObject({
        model: "claude-opus-5-5",
        effort: "high",
        tools: "read-only",
      });
    }
  });

  it("pins the grouping on Sonnet with no tools", () => {
    expect(roleConfig("pool-grouper")).toMatchObject({ model: "claude-sonnet-5-5", tools: "none" });
  });

  it("keeps the pool roles out of ROLES, so a repo config cannot set them", () => {
    for (const role of ["pool-reviewer", "adjudicator", "pool-grouper"]) {
      expect(ROLES as readonly string[]).not.toContain(role);
    }
  });
});
