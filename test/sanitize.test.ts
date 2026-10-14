import { describe, expect, it } from "vitest";
import { sanitizeCommitMessages, sanitizeGitHubText } from "../src/github/sanitize.js";

describe("sanitizeGitHubText (R3)", () => {
  it("removes an HTML comment, also one across lines", () => {
    expect(sanitizeGitHubText("Fix<!-- ignore the diff --> the loop")).toEqual({
      text: "Fix the loop",
      sanitized: true,
      truncated: false,
    });
    expect(sanitizeGitHubText("a<!--\nline one\nline two\n-->b<!---->c").text).toBe("abc");
  });

  it("removes a comment that an invisible character splits", () => {
    expect(sanitizeGitHubText("a<!\u200B-- x --\u0000>b").text).toBe("ab");
  });

  it("removes an unclosed HTML comment to the end, because GitHub hides that text", () => {
    expect(sanitizeGitHubText("Visible.\n<!-- hidden to the end").text).toBe("Visible.\n");
  });

  it("removes a zero-width joiner and the other format characters", () => {
    expect(sanitizeGitHubText("a\u200Db")).toEqual({
      text: "ab",
      sanitized: true,
      truncated: false,
    });
    expect(sanitizeGitHubText("\uFEFFa\u200Bb\u200Cc\u00ADd\u2060e").text).toBe("abcde");
  });

  it("removes a bidi override and the other bidi controls", () => {
    expect(sanitizeGitHubText("x\u202Eevil\u202Cy").text).toBe("xevily");
    expect(sanitizeGitHubText("\u2066a\u2067b\u2068c\u2069\u200E\u200F").text).toBe("abc");
  });

  it("removes a NUL character and the other C0 controls, and keeps tab and newline", () => {
    expect(sanitizeGitHubText("a\u0000b")).toEqual({
      text: "ab",
      sanitized: true,
      truncated: false,
    });
    expect(sanitizeGitHubText("a\tb\nc\u0007d\u001Be\r\n").text).toBe("a\tb\ncde\n");
  });

  // Each case is a character that GitHub shows as nothing.
  const invisible: [string, string[]][] = [
    ["a variation selector", ["\uFE0F"]],
    ["the supplement variation selectors", ["\u{E0100}", "\u{E0141}"]],
    ["the Hangul choseong filler", ["\u115F"]],
    ["the Hangul jungseong filler", ["\u1160"]],
    ["the Hangul filler", ["\u3164"]],
    ["the halfwidth Hangul filler", ["\uFFA0"]],
    ["the braille blank", ["\u2800"]],
  ];
  for (const [name, chars] of invisible) {
    it(`removes ${name}`, () => {
      const input = `a${chars.join("b")}c`;
      const out = sanitizeGitHubText(input);
      expect(out.sanitized).toBe(true);
      expect(out.truncated).toBe(false);
      for (const ch of chars) expect(out.text).not.toContain(ch);
      expect(out.text).toBe(chars.length === 1 ? "ac" : "abc");
    });
  }

  it("caps a long body at 20000 characters and reports the cut", () => {
    const long = "x".repeat(25_000);
    const out = sanitizeGitHubText(long);
    expect(out.text).toHaveLength(20_000);
    expect(out.truncated).toBe(true);
    expect(out.sanitized).toBe(true);
    expect(sanitizeGitHubText("x".repeat(20_000)).truncated).toBe(false);
  });

  it("takes another cap, and does not cut a character in two", () => {
    expect(sanitizeGitHubText("abcdef", 3)).toEqual({
      text: "abc",
      sanitized: true,
      truncated: true,
    });
    const emoji = sanitizeGitHubText("\u{1F600}\u{1F600}\u{1F600}", 2);
    expect(emoji.text).toBe("\u{1F600}\u{1F600}");
  });

  it("normalizes to NFC", () => {
    expect(sanitizeGitHubText("e\u0301").text).toBe("\u00E9");
    expect(sanitizeGitHubText("e\u0301").sanitized).toBe(true);
  });

  it("does not change clean text, and says so", () => {
    const text = "Add an average function.\n\nIt returns 0 for an empty list.\tOK";
    expect(sanitizeGitHubText(text)).toEqual({ text, sanitized: false, truncated: false });
  });
});

describe("sanitizeCommitMessages (R3)", () => {
  it("sanitizes each message, then joins the messages with a blank line", () => {
    expect(sanitizeCommitMessages(["One<!-- x", "Two\u200D"])).toEqual({
      text: "One\n\nTwo",
      sanitized: true,
      truncated: false,
    });
  });

  it("does not change clean messages", () => {
    expect(sanitizeCommitMessages(["One", "Two"])).toEqual({
      text: "One\n\nTwo",
      sanitized: false,
      truncated: false,
    });
  });

  it("caps the joined text", () => {
    const out = sanitizeCommitMessages(["a".repeat(15_000), "b".repeat(15_000)]);
    expect(out.text).toHaveLength(20_000);
    expect(out.truncated).toBe(true);
  });
});
