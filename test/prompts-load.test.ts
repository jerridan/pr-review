import { describe, expect, it } from "vitest";
import { loadPrompt, render } from "../src/prompts/load.js";

describe("loadPrompt", () => {
  it("reads the frontmatter and the body of a prompt file", () => {
    const prompt = loadPrompt("smoke.md");
    expect(prompt.frontmatter.role).toBe("smoke");
    expect(typeof prompt.frontmatter.user_message).toBe("string");
    expect(prompt.body.trim().length).toBeGreaterThan(0);
    expect(prompt.body).not.toContain("---");
  });

  it("throws with the path when the file does not exist", () => {
    expect(() => loadPrompt("no-such-prompt.md")).toThrow(/no-such-prompt\.md/);
  });

  it("refuses a path outside the prompts directory", () => {
    expect(() => loadPrompt("../package.json")).toThrow(/outside/i);
    expect(() => loadPrompt("/etc/hosts")).toThrow(/outside/i);
  });
});

describe("render", () => {
  it("replaces each token, also a token that occurs two times", () => {
    expect(render("Hi {{name}}. Bye {{name}}, from {{ who }}.", { name: "Ann", who: "Bo" })).toBe(
      "Hi Ann. Bye Ann, from Bo.",
    );
  });

  it("throws on a missing var and names it", () => {
    expect(() => render("{{a}} {{b}}", { a: "x" })).toThrow(/\bb\b/);
  });

  it("does not expand a token inside an inserted value", () => {
    expect(render("{{diff}}", { diff: "see {{secret}}", secret: "s3" })).toBe("see {{secret}}");
  });

  it("inserts a value that holds replacement patterns as plain text", () => {
    expect(render("<{{v}}>", { v: "$& $1 $$" })).toBe("<$& $1 $$>");
  });

  it("leaves text without tokens unchanged", () => {
    expect(render("plain { text }", {})).toBe("plain { text }");
  });
});
