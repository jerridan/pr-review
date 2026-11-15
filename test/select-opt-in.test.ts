import { describe, expect, it } from "vitest";
import { loadBuiltinReviewers } from "../src/reviewers/loader.js";
import { selectReviewers } from "../src/reviewers/select.js";

const names = (picked: { def: { frontmatter: { name: string } } }[]) =>
  picked.map((p) => p.def.frontmatter.name);

describe("selectReviewers with an opt-in reviewer", () => {
  const defs = loadBuiltinReviewers();
  const files = ["src/stats.ts"];

  it("leaves out general-review when no reviewer is named", () => {
    expect(names(selectReviewers(defs, "full", files, []))).not.toContain("general-review");
    expect(names(selectReviewers(defs, "full", files, [], new Set()))).not.toContain(
      "general-review",
    );
    expect(names(selectReviewers(defs, "full", files, [], new Set(["tests"])))).not.toContain(
      "general-review",
    );
  });

  it("adds general-review beside the normal selection when it is named", () => {
    const normal = names(selectReviewers(defs, "full", files, []));
    const named = names(selectReviewers(defs, "full", files, [], new Set(["general-review"])));
    expect(named).toContain("general-review");
    expect(named.filter((n) => n !== "general-review")).toEqual(normal);
  });

  it("still needs the tier of the reviewer", () => {
    expect(names(selectReviewers(defs, "skip", files, [], new Set(["general-review"])))).toEqual(
      [],
    );
    expect(names(selectReviewers(defs, "fast", files, [], new Set(["general-review"])))).toContain(
      "general-review",
    );
  });

  it("still needs the triggers of the reviewer", () => {
    const base = defs.find((d) => d.frontmatter.name === "general-review");
    if (!base) throw new Error("no general-review");
    const narrow = {
      ...base,
      frontmatter: {
        ...base.frontmatter,
        triggers: { ...base.frontmatter.triggers, paths: ["**/*.py"] },
      },
    };
    expect(
      names(selectReviewers([narrow], "full", files, [], new Set(["general-review"]))),
    ).toEqual([]);
    expect(
      names(selectReviewers([narrow], "full", ["a.py"], [], new Set(["general-review"]))),
    ).toEqual(["general-review"]);
  });
});
