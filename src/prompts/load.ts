// Load prompt files from "prompts/" and fill their templates. Every prompt
// sent to a model is in a markdown file. TypeScript holds only templating.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface PromptFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

// This file is at src/prompts/load.ts and at dist/prompts/load.js. In both
// cases the package root is two levels up.
const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

/**
 * Give the absolute path of "prompts/<relativePath>". Throw when the path
 * goes outside the prompts directory.
 */
export function promptPath(relativePath: string): string {
  const full = resolve(PROMPTS_DIR, relativePath);
  const inside = relative(PROMPTS_DIR, full);
  if (isAbsolute(relativePath) || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`Prompt path "${relativePath}" is outside the prompts directory.`);
  }
  return full;
}

// The frontmatter starts with a line that is only "---" and ends at the
// next line that is only "---".
const OPEN_LINE = /^---[ \t]*\r?\n/;
const CLOSE_LINE = /^---[ \t]*(?:\r?\n|$)/m;

/**
 * Split a markdown file into YAML frontmatter and body. A file without a
 * frontmatter block gives an empty frontmatter. Throw when the block has
 * no closing line, when the YAML is bad, or when it is not a mapping.
 */
export function parseFrontmatter(text: string): PromptFile {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const open = OPEN_LINE.exec(source);
  if (!open) return { frontmatter: {}, body: source };
  const rest = source.slice(open[0].length);
  const close = CLOSE_LINE.exec(rest);
  if (!close) throw new Error("The frontmatter has no closing --- line.");
  const yamlText = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  const data: unknown = parseYaml(yamlText);
  if (data === null || data === undefined) return { frontmatter: {}, body };
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The frontmatter is not a YAML mapping.");
  }
  return { frontmatter: { ...(data as Record<string, unknown>) }, body };
}

/** Read "prompts/<relativePath>" from the package root. */
export function loadPrompt(relativePath: string): PromptFile {
  const full = promptPath(relativePath);
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read prompt "${relativePath}": ${reason}`, { cause: err });
  }
  let parsed: PromptFile;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Bad prompt "${relativePath}": ${reason}`, { cause: err });
  }
  return { frontmatter: parsed.frontmatter, body: parsed.body.replace(/^(?:\r?\n)+/, "") };
}

const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Replace each "{{name}}" token with its value. Throw when a token has no
 * value. The replace is one pass, so a token inside a value stays as text.
 */
export function render(template: string, vars: Record<string, string>): string {
  const missing = new Set<string>();
  const out = template.replace(TOKEN, (token, name: string) => {
    if (!Object.hasOwn(vars, name)) {
      missing.add(name);
      return token;
    }
    return vars[name] as string;
  });
  if (missing.size > 0) {
    throw new Error(`Missing template value: ${[...missing].join(", ")}`);
  }
  return out;
}
