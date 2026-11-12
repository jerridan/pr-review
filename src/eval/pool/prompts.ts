// Build the messages of the pool calls from the prompt files. The data
// goes in tagged untrusted blocks. Each prompt file serves both families:
// the SDK call gets the body as the system prompt, and the codex call gets
// the body and the user message as one prompt.
import { loadPrompt, render } from "../../prompts/load.js";
import { wrapUntrusted } from "../../untrusted.js";
import { sixFields, type PoolFinding } from "./schemas.js";

/**
 * The limits of the text that enters a prompt, in UTF-8 bytes. Linux limits
 * one argv element to 131072 bytes, and the codex prompt is one argument.
 * The sum of the limits, the prompt text and the tags stays well under it.
 */
export const POOL_DIFF_LIMIT = 65536;
export const POOL_TITLE_LIMIT = 1024;
export const POOL_BODY_LIMIT = 16384;
export const POOL_FILES_LIMIT = 8192;
export const POOL_PATH_LIMIT = 1024;
export const POOL_CLAIM_LIMIT = 4096;
export const POOL_EVIDENCE_LIMIT = 8192;

export type Message = { system: string; user: string };

type Prompt = { system: string; template: string; cutText: string | null };

const cache = new Map<string, Prompt>();

function prompt(file: string): Prompt {
  const hit = cache.get(file);
  if (hit) return hit;
  const p = loadPrompt(file);
  const template = p.frontmatter.user_message;
  if (typeof template !== "string") {
    throw new Error(`prompts/${file} has no "user_message" string in its frontmatter.`);
  }
  const cut = p.frontmatter.cut_text;
  const value = { system: p.body, template, cutText: typeof cut === "string" ? cut : null };
  cache.set(file, value);
  return value;
}

function block(label: string, text: string): string {
  return wrapUntrusted(label, text).block;
}

// Keep the first "limit" bytes of the text, cut at a character boundary,
// and add the cut text of the prompt file.
function cap(text: string, limit: number, cutText: string | null): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let end = limit;
  // A byte of the form 10xxxxxx continues a character. Do not cut inside one.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const kept = bytes.subarray(0, end).toString("utf8");
  return cutText === null ? kept : `${kept}\n${render(cutText, { limit: String(limit) })}`;
}

function message(file: string, blocks: Record<string, string>): Message {
  const p = prompt(file);
  return { system: p.system, user: render(p.template, blocks) };
}

// The six fields of a finding, with the long text capped.
function cappedFinding(file: string, f: PoolFinding): PoolFinding {
  const cut = prompt(file).cutText;
  return {
    ...sixFields(f),
    file: cap(f.file, POOL_PATH_LIMIT, cut),
    claim: cap(f.claim, POOL_CLAIM_LIMIT, cut),
    evidence: cap(f.evidence, POOL_EVIDENCE_LIMIT, cut),
  };
}

/** The one prompt string of a codex call: the system text, then the user text. */
export function codexPrompt(m: Message): string {
  return `${m.system.trimEnd()}\n\n${m.user}`;
}

/** What a blind review sees of the pull request. */
export type ReviewInput = { title: string; body: string; changedFiles: string[]; diff: string };

/** The message of one blind review. */
export function reviewMessage(input: ReviewInput): Message {
  const file = "pool-review.md";
  const cut = prompt(file).cutText;
  return message(file, {
    title: block("title", cap(input.title, POOL_TITLE_LIMIT, cut)),
    body: block("body", cap(input.body, POOL_BODY_LIMIT, cut)),
    changed_files: block(
      "changed_files",
      cap(input.changedFiles.join("\n"), POOL_FILES_LIMIT, cut),
    ),
    diff: block("diff", cap(input.diff, POOL_DIFF_LIMIT, cut)),
  });
}

/** The message of one grouping call. The id of each finding is its place in "ids". */
export function groupMessage(findings: readonly PoolFinding[], ids: readonly string[]): Message {
  const items = findings.map((f, n) => ({ id: ids[n], ...cappedFinding("pool-group.md", f) }));
  return message("pool-group.md", { items: block("items", JSON.stringify(items, null, 2)) });
}

/** The message of one adjudication. It holds the six fields of the finding and nothing else of it. */
export function adjudicateMessage(finding: PoolFinding, diff: string): Message {
  const file = "pool-adjudicate.md";
  return message(file, {
    finding: block("finding", JSON.stringify(cappedFinding(file, finding), null, 2)),
    diff: block("diff", cap(diff, POOL_DIFF_LIMIT, prompt(file).cutText)),
  });
}
