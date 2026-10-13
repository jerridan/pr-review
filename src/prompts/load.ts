// Load prompt files from "prompts/" and fill their templates. Every prompt
// sent to a model is in a markdown file. TypeScript holds only templating.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

export interface PromptFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

// This file is at src/prompts/load.ts and at dist/prompts/load.js. In both
// cases the package root is two levels up.
const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

/** Read "prompts/<relativePath>" from the package root. */
export function loadPrompt(relativePath: string): PromptFile {
  const full = resolve(PROMPTS_DIR, relativePath);
  const inside = relative(PROMPTS_DIR, full);
  if (isAbsolute(relativePath) || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`Prompt path "${relativePath}" is outside the prompts directory.`);
  }
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read prompt "${relativePath}": ${reason}`, { cause: err });
  }
  // Pass an options object so gray-matter does not use its cache, which
  // can hold an old copy of a file with the same text.
  const parsed = matter(text, {});
  return { frontmatter: { ...parsed.data }, body: parsed.content.replace(/^\n+/, "") };
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
