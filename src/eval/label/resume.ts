// Resume a stopped label run. The labels.json of a case keeps a digest of
// the labeling input. A later run with --resume reuses the entry of each
// finding whose runs all completed, when the digest and the finding text
// are the same.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveModel, roleConfig } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load.js";
import { CATEGORIES } from "../../schemas/finding.js";
import { LABEL_SEVERITIES } from "../../schemas/label.js";
import { CODEX_EFFORT, CODEX_MODEL } from "./codex.js";
import type { FindingEntry } from "./loop.js";

/**
 * A digest of what the runs of the labeler depend on, apart from the
 * finding: the run count, the case head and diff, the model ids, the
 * severity policy, and the prompt files of the scorer and the judge.
 */
export function labelDigest(runs: number, policy: string, head: string, diff: string): string {
  const input = {
    runs,
    head,
    diff: createHash("sha256").update(diff).digest("hex"),
    scorer: resolveModel(roleConfig("labeler").model),
    judge: `${CODEX_MODEL}:${CODEX_EFFORT}`,
    policy,
    prompts: ["label-scorer.md", "label-judge.md"].map((file) => {
      const p = loadPrompt(file);
      return [p.frontmatter, p.body];
    }),
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * The key of a finding: its text and its category, which the scorer sees.
 * The severity is not in the key, because the labeler writes it.
 */
export function findingKey(f: {
  file: string;
  start_line: number;
  end_line: number;
  claim: string;
  category: string;
}): string {
  return JSON.stringify([f.file, f.start_line, f.end_line, f.claim, f.category]);
}

const CallSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scorer"),
    severity: z.enum(LABEL_SEVERITIES).nullable(),
    category: z.enum(CATEGORIES).nullable(),
    policy_section: z.string().nullable(),
    rationale: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal("judge"),
    accept: z.boolean().nullable(),
    policy_section: z.string().nullable(),
    reason: z.string().optional(),
    stderr: z.string(),
    error: z.string().optional(),
  }),
]);

const RunSchema = z.object({
  converged: z.boolean(),
  failed: z.boolean(),
  severity: z.enum(LABEL_SEVERITIES).nullable(),
  category: z.enum(CATEGORIES).nullable(),
  first_pass_accepted: z.boolean(),
  calls: z.array(CallSchema),
  error: z.string().optional(),
});

const EntrySchema = z.object({
  file: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  claim: z.string(),
  category: z.enum(CATEGORIES),
  runs: z.array(RunSchema),
});

const FileSchema = z.object({ digest: z.string().optional(), findings: z.array(z.unknown()) });

/** The entries to reuse, by finding key, and a message when the file gives no reuse. */
export type Kept = { entries: Map<string, FindingEntry>; message: string | null };

/**
 * Read the labels.json in "dir". The entries are those whose runs are as
 * many as "runs" and none failed. A missing file gives no entry and no
 * message. A file with no digest, with another digest, or that is not valid
 * gives no entry and a message.
 */
export async function readKept(dir: string, digest: string, runs: number): Promise<Kept> {
  const none = (message: string | null): Kept => ({ entries: new Map(), message });
  let text: string;
  try {
    text = await readFile(join(dir, "labels.json"), "utf8");
  } catch {
    return none(null);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return none("labels.json is not JSON, so nothing is reused.");
  }
  const file = FileSchema.safeParse(value);
  if (!file.success) return none("labels.json is not a labels file, so nothing is reused.");
  if (file.data.digest === undefined)
    return none("labels.json has no digest, so nothing is reused.");
  if (file.data.digest !== digest) {
    return none(
      "labels.json has another digest (the input of the labeler changed), so nothing is reused.",
    );
  }
  const entries = new Map<string, FindingEntry>();
  for (const raw of file.data.findings) {
    const entry = EntrySchema.safeParse(raw);
    if (!entry.success) continue;
    if (entry.data.runs.length !== runs || entry.data.runs.some((r) => r.failed)) continue;
    entries.set(findingKey(entry.data), raw as FindingEntry);
  }
  return { entries, message: null };
}
