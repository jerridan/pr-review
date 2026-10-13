// Parse git output for gather: the name-status list and the patch text.
// These functions run no git command, so tests can give them plain text.

export type NameStatusEntry = {
  path: string;
  status: string;
  oldPath?: string;
  similarity?: number;
};

/**
 * Parse the output of `git diff --name-status -z -M`. Fields are separated
 * by NUL. A rename (R) or copy (C) has a score and two paths; "path" is the
 * new path. "status" is the one-letter code.
 */
export function parseNameStatus(text: string): NameStatusEntry[] {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const code = fields[i] ?? "";
    const letter = code.charAt(0);
    if (!/^[ACDMRTUX]$/.test(letter)) {
      throw new Error(`Unknown name-status code "${code}".`);
    }
    if (letter === "R" || letter === "C") {
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      if (oldPath === undefined || path === undefined) {
        throw new Error(`Name-status entry "${code}" has fewer than two paths.`);
      }
      out.push({ path, status: letter, oldPath, similarity: Number.parseInt(code.slice(1), 10) });
      i += 3;
    } else {
      const path = fields[i + 1];
      if (path === undefined) throw new Error(`Name-status entry "${code}" has no path.`);
      out.push({ path, status: letter });
      i += 2;
    }
  }
  return out;
}

type Section = { path: string; text: string };

const HEADER = /^diff --git /gm;

// Undo the C-style quotes that git puts on a path with special characters.
function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const inner = value.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = inner.charAt(i + 1);
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Remove the "a/" or "b/" prefix from a path in a "---" or "+++" line.
// Git adds a tab after a path that holds a space.
function stripPrefix(raw: string, prefix: "a/" | "b/"): string | null {
  const value = unquote(raw.replace(/\t$/, ""));
  if (value === "/dev/null") return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

// Get the path from "diff --git a/X b/X" when no other line names it.
function pathFromHeader(line: string): string {
  const rest = line.slice("diff --git ".length);
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted?.[1]) return stripPrefix(quoted[1], "b/") ?? "";
  // Without quotes the two paths are the same, so split at the middle.
  const half = (rest.length - 1) / 2;
  const second = rest.slice(half + 1);
  return second.startsWith("b/") ? second.slice(2) : second;
}

function sectionPath(text: string): string {
  const lines = text.split("\n");
  let minus: string | null = null;
  let renameTo: string | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("+++ ")) {
      const plus = stripPrefix(line.slice(4), "b/");
      if (plus !== null) return plus;
    } else if (line.startsWith("--- ")) {
      minus = stripPrefix(line.slice(4), "a/");
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      renameTo = unquote(line.slice(line.indexOf(" to ") + 4));
    }
  }
  return minus ?? renameTo ?? pathFromHeader(lines[0] ?? "");
}

function splitSections(diff: string): { preamble: string; sections: Section[] } {
  const starts = [...diff.matchAll(HEADER)].map((m) => m.index);
  if (starts.length === 0) return { preamble: diff, sections: [] };
  const sections = starts.map((start, i) => {
    const text = diff.slice(start, starts[i + 1] ?? diff.length);
    return { path: sectionPath(text), text };
  });
  return { preamble: diff.slice(0, starts[0]), sections };
}

/** Count the hunks of each file in a patch, keyed by the new path. */
export function countHunks(diff: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const section of splitSections(diff).sections) {
    // A hunk body line starts with " ", "+", "-" or "\", so a line that
    // starts with "@@" is always a hunk header.
    const hunks = section.text.split("\n").filter((line) => line.startsWith("@@")).length;
    counts.set(section.path, (counts.get(section.path) ?? 0) + hunks);
  }
  return counts;
}

/** Keep the sections of the files for which "keep" is true. */
export function filterDiff(diff: string, keep: (path: string) => boolean): string {
  const { preamble, sections } = splitSections(diff);
  return (
    preamble +
    sections
      .filter((s) => keep(s.path))
      .map((s) => s.text)
      .join("")
  );
}
