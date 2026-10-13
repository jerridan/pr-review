import { describe, expect, it } from "vitest";
import { loadPrompt, parseFrontmatter, render } from "../src/prompts/load.js";

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

describe("parseFrontmatter", () => {
  it("splits YAML frontmatter from the body", () => {
    const text = "---\nrole: smoke\nlist:\n  - a\n  - b\n---\nBody line one.\n\nBody line two.\n";
    expect(parseFrontmatter(text)).toEqual({
      frontmatter: { role: "smoke", list: ["a", "b"] },
      body: "Body line one.\n\nBody line two.\n",
    });
  });

  it("accepts CRLF line ends and a byte order mark", () => {
    const text = "﻿---\r\nrole: triage\r\n---\r\nBody.\r\n";
    const parsed = parseFrontmatter(text);
    expect(parsed.frontmatter).toEqual({ role: "triage" });
    expect(parsed.body).toBe("Body.\r\n");
  });

  it("gives an empty frontmatter when the file has none", () => {
    expect(parseFrontmatter("Just a body.\n")).toEqual({ frontmatter: {}, body: "Just a body.\n" });
  });

  it("accepts an empty frontmatter block and a file that ends at the closing line", () => {
    expect(parseFrontmatter("---\n---\nBody.\n")).toEqual({ frontmatter: {}, body: "Body.\n" });
    expect(parseFrontmatter("---\nrole: smoke\n---")).toEqual({
      frontmatter: { role: "smoke" },
      body: "",
    });
  });

  it("does not end the frontmatter at a line that only starts with ---", () => {
    const text = "---\nnote: |\n  ---x\nrole: smoke\n---\nBody.\n";
    expect(parseFrontmatter(text).frontmatter).toEqual({ note: "---x\n", role: "smoke" });
  });

  it("throws when the closing line is missing", () => {
    expect(() => parseFrontmatter("---\nrole: smoke\nBody.\n")).toThrow(/closing/i);
  });

  it("throws on bad YAML and on frontmatter that is not a mapping", () => {
    expect(() => parseFrontmatter("---\nrole: [smoke\n---\nBody.\n")).toThrow();
    expect(() => parseFrontmatter("---\n- a\n- b\n---\nBody.\n")).toThrow(/mapping/i);
  });
});
