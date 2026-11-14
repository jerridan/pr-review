// The judge cache of one eval repeat: every answer of the match judge and
// of the extras judge, keyed by the judge model and the texts that the
// judge saw of the finding and the golden finding. A later scoring of the
// same record reads it and asks the judge only for a pair with no answer.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";

/** An answer of either judge. A failed query is "unknown". */
export type JudgeAnswer = "yes" | "no" | "unknown";

/** The answers by key. The scoring adds each new answer. */
export type JudgeCache = Map<string, JudgeAnswer>;

/** The name of the cache file in "<out>/<case>/<repeat>/". */
export const JUDGE_CACHE_FILE = "judge-cache.json";

const CacheFileSchema = z.strictObject({
  version: z.literal(1),
  answers: z.record(z.string(), z.enum(["yes", "no", "unknown"])),
});

/**
 * The key of one judge answer: a hash of the judge, the judge model and
 * the texts of the question. The match judge gives the posted finding and
 * the golden finding. The extras judge gives the posted finding.
 */
export function judgeKey(judge: "match" | "extras", model: string, texts: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([judge, model, ...texts]))
    .digest("hex");
}

/**
 * Read a cache file. A missing file gives an empty cache. Throw, and name
 * the file, when the file is not JSON or has another shape.
 */
export async function readJudgeCache(path: string): Promise<JudgeCache> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  let parsed;
  try {
    parsed = CacheFileSchema.safeParse(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`the judge cache ${path} is not valid JSON: ${reason}`, { cause: err });
  }
  if (!parsed.success) throw new Error(`the judge cache ${path} has an unknown shape`);
  return new Map(Object.entries(parsed.data.answers));
}

/** Write the cache in one step, with the keys in order. */
export async function writeJudgeCache(path: string, cache: JudgeCache): Promise<void> {
  const answers = Object.fromEntries([...cache.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, answers }, null, 2)}\n`);
}
