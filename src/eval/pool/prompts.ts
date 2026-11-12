// Build the messages of the pool calls from the prompt files. The data
// goes in tagged untrusted blocks. Each prompt file serves both families:
// the SDK call gets the body as the system prompt, and the codex call gets
// the body and the user message as one prompt.
import { loadPrompt, render } from "../../prompts/load.js";
import { wrapUntrusted } from "../../untrusted.js";
import { sixFields, type PoolFinding } from "./schemas.js";

/**
 * The most characters of the diff that a call gets. Linux limits one argv
 * element to 131072 bytes, and the codex prompt is one argument.
 */
export const POOL_DIFF_LIMIT = 65536;

export type Message = { system: string; user: string };

type Prompt = { system: string; template: string };

const cache = new Map<string, Prompt>();

function prompt(file: string): Prompt {
  const hit = cache.get(file);
  if (hit) return hit;
  const p = loadPrompt(file);
  const template = p.frontmatter.user_message;
  if (typeof template !== "string") {
    throw new Error(`prompts/${file} has no "user_message" string in its frontmatter.`);
  }
  const value = { system: p.body, template };
  cache.set(file, value);
  return value;
}

function block(label: string, text: string): string {
  return wrapUntrusted(label, text).block;
}

// Keep the first "limit" characters, and tell the model about the cut.
function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[The diff was cut here. The limit is ${limit} characters.]`;
}

function message(file: string, blocks: Record<string, string>): Message {
  const p = prompt(file);
  return { system: p.system, user: render(p.template, blocks) };
}

/** The one prompt string of a codex call: the system text, then the user text. */
export function codexPrompt(m: Message): string {
  return `${m.system.trimEnd()}\n\n${m.user}`;
}

/** What a blind review sees of the pull request. */
export type ReviewInput = { title: string; body: string; changedFiles: string[]; diff: string };

/** The message of one blind review. */
export function reviewMessage(input: ReviewInput): Message {
  return message("pool-review.md", {
    title: block("title", input.title),
    body: block("body", input.body),
    changed_files: block("changed_files", input.changedFiles.join("\n")),
    diff: block("diff", cap(input.diff, POOL_DIFF_LIMIT)),
  });
}

/** The message of one grouping call. The id of each finding is its place in "ids". */
export function groupMessage(findings: readonly PoolFinding[], ids: readonly string[]): Message {
  const items = findings.map((f, n) => ({ id: ids[n], ...sixFields(f) }));
  return message("pool-group.md", { items: block("items", JSON.stringify(items, null, 2)) });
}

/** The message of one adjudication. It holds the six fields of the finding and nothing else of it. */
export function adjudicateMessage(finding: PoolFinding, diff: string): Message {
  return message("pool-adjudicate.md", {
    finding: block("finding", JSON.stringify(sixFields(finding), null, 2)),
    diff: block("diff", cap(diff, POOL_DIFF_LIMIT)),
  });
}
