// Sanitize text from GitHub before it enters a prompt. The text is still
// untrusted after this. The caller must also wrap it with src/untrusted.ts.

/** The default cap, in characters (code points). */
export const SANITIZE_CAP = 20000;

export type Sanitized = { text: string; sanitized: boolean; truncated: boolean };

// A closed HTML comment, also across lines.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// An HTML comment with no end. GitHub hides the text after it, so the
// sanitizer removes the text to the end too.
const OPEN_HTML_COMMENT = /<!--[\s\S]*$/;
// Unicode format characters: zero-width characters, bidi controls, the
// soft hyphen and the byte order mark.
const FORMAT_CHARS = /\p{Cf}/gu;
// Remove C0 control characters (below U+0020) other than tab (U+0009)
// and newline (U+000A). A regex with control characters fails the lint
// rule no-control-regex, so this is a loop.
function removeC0Controls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 || code === 0x09 || code === 0x0a) out += ch;
  }
  return out;
}

// Remove the hidden and invisible parts and normalize to NFC. No cap.
// The invisible characters go first. Thus a comment that they split, such
// as "<!\u200B--", is still found and removed.
function clean(text: string): string {
  return removeC0Controls(text)
    .replace(FORMAT_CHARS, "")
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
 * Remove HTML comments, format characters and C0 controls other than tab
 * and newline, normalize to NFC, and cap the text at "cap" characters.
 * "sanitized" is true when the result differs from the input. "truncated"
 * is true when the cap cut the text.
 */
export function sanitizeGitHubText(text: string, cap = SANITIZE_CAP): Sanitized {
  const capped = capText(clean(text), cap);
  return { text: capped.text, sanitized: capped.text !== text, truncated: capped.truncated };
}

/**
 * Sanitize each commit message, join them with one blank line, and cap
 * the joined text. Each message is cleaned alone, so a comment that one
 * message opens cannot remove text of the next message.
 */
export function sanitizeCommitMessages(messages: string[], cap = SANITIZE_CAP): Sanitized {
  const cleaned = messages.map(clean);
  const changed = cleaned.some((m, i) => m !== messages[i]);
  const capped = capText(cleaned.join("\n\n"), cap);
  return { text: capped.text, sanitized: changed || capped.truncated, truncated: capped.truncated };
}
