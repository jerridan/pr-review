// Sanitize text from GitHub before it enters a prompt. The text is still
// untrusted after this. The caller must also wrap it with src/untrusted.ts.

// These patterns match GitHub tokens and a credential in a URL.
const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const URL_CREDENTIAL_RE = /\/\/[^/\s@]+@/g;

/**
 * Remove token-like text and the credential in a URL from "text". Use it
 * on each error text that goes to a record or to GitHub. It does not
 * compare with env values.
 */
export function redact(text: string): string {
  return text.replace(TOKEN_RE, "[redacted]").replace(URL_CREDENTIAL_RE, "//[redacted]@");
}

/** The default cap, in characters (code points). */
export const SANITIZE_CAP = 20000;

export type Sanitized = { text: string; sanitized: boolean; truncated: boolean };

// A closed HTML comment, also across lines.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// An HTML comment with no end. GitHub hides the text after it, so the
// sanitizer removes the text to the end too.
const OPEN_HTML_COMMENT = /<!--[\s\S]*$/;
// Characters that GitHub shows as nothing:
// - Unicode format characters (Cf): zero-width characters, bidi controls,
//   the soft hyphen and the byte order mark.
// - Default ignorable code points: also the variation selectors U+FE00 to
//   U+FE0F and U+E0100 to U+E01EF, and the Hangul fillers U+115F, U+1160,
//   U+3164 and U+FFA0. A string of variation selectors can hide bytes.
// - The braille blank U+2800.
const INVISIBLE_CHARS = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;
// Remove C0 control characters (below U+0020) other than tab (U+0009)
// and newline (U+000A). This also removes a lone CR (U+000D). A regex with control characters fails the lint
// rule no-control-regex, so this is a loop.
function removeC0Controls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 || code === 0x09 || code === 0x0a) out += ch;
  }
  return out;
}

// Turn each CRLF into LF. The GitHub web editor writes CRLF. This is a
// change of the line ending only, so it does not count as a sanitize.
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// Remove the hidden and invisible parts and normalize to NFC. No cap.
// The text must have LF line endings. Call normalizeLineEndings first, so
// that removeC0Controls removes only a lone CR.
// The invisible characters go first. Thus a comment that they split, such
// as "<!\u200B--", is still found and removed.
function clean(text: string): string {
  return removeC0Controls(text)
    .replace(INVISIBLE_CHARS, "")
    .replace(HTML_COMMENT, "")
    .replace(OPEN_HTML_COMMENT, "")
    .normalize("NFC");
}

// Cut the text to "cap" code points. A surrogate pair is never cut in two.
function capText(text: string, cap: number): { text: string; truncated: boolean } {
  // A string of "cap" UTF-16 units or fewer has "cap" code points or fewer.
  if (text.length <= cap) return { text, truncated: false };
  const points = Array.from(text);
  if (points.length <= cap) return { text, truncated: false };
  return { text: points.slice(0, cap).join(""), truncated: true };
}

/**
 * Turn CRLF into LF. Remove C0 controls other than tab and newline,
 * format characters, default ignorable code points and the braille blank.
 * Then remove HTML comments, normalize to NFC, and cap the text at "cap"
 * characters. "sanitized" is true when the result differs from the input
 * after the CRLF step. A body whose only change is CRLF gives false. A lone
 * CR is a C0 control, so it gives true. "truncated" is true when the cap
 * cut the text.
 */
export function sanitizeGitHubText(text: string, cap = SANITIZE_CAP): Sanitized {
  const lf = normalizeLineEndings(text);
  const capped = capText(clean(lf), cap);
  return { text: capped.text, sanitized: capped.text !== lf, truncated: capped.truncated };
}

/**
 * Sanitize each commit message, join them with one blank line, and cap
 * the joined text. Each message is cleaned alone, so a comment that one
 * message opens cannot remove text of the next message.
 */
export function sanitizeCommitMessages(messages: string[], cap = SANITIZE_CAP): Sanitized {
  // The CRLF step is not a sanitize, the same as in sanitizeGitHubText.
  const lf = messages.map(normalizeLineEndings);
  const cleaned = lf.map(clean);
  const changed = cleaned.some((m, i) => m !== lf[i]);
  const capped = capText(cleaned.join("\n\n"), cap);
  return { text: capped.text, sanitized: changed || capped.truncated, truncated: capped.truncated };
}
