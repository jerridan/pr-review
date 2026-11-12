// The kept results of the model calls of one pool case. The file calls.json
// in the output directory of the case holds each call that succeeded. A
// resumed run reuses a kept result when the key of the call is the same. A
// failed call is never kept. The file belongs to one case head: a file of
// another head is dropped.
import { readFileSync, writeFileSync } from "node:fs";
import type { z } from "zod";

/** The kinds of call that the file keeps. */
export type MemoKind = "review" | "group" | "adjudication";

const KINDS: readonly MemoKind[] = ["review", "group", "adjudication"];

type Store = Record<MemoKind, Record<string, unknown>>;

function emptyStore(): Store {
  return { review: {}, group: {}, adjudication: {} };
}

// Read the file. Give an empty store for a missing, damaged or other-head file.
function readStore(path: string, head: string): Store {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (value.head !== head) return emptyStore();
    const store = emptyStore();
    for (const kind of KINDS) {
      const part = value[kind];
      if (part !== null && typeof part === "object" && !Array.isArray(part)) {
        store[kind] = { ...(part as Record<string, unknown>) };
      }
    }
    return store;
  } catch {
    return emptyStore();
  }
}

export class CallMemo {
  private readonly store: Store;
  private reused = 0;
  private made = 0;

  /**
   * "reuse" tells if a kept result may serve a call. Without it, the memo
   * still keeps new results and the results of an earlier run of the same head.
   */
  constructor(
    private readonly path: string,
    private readonly head: string,
    private readonly reuse: boolean,
  ) {
    this.store = readStore(path, head);
  }

  /**
   * The kept result for "key", or undefined when the call must be made. A
   * kept value that "schema" rejects counts as missing.
   */
  get<T>(kind: MemoKind, key: string, schema: z.ZodType<T>): T | undefined {
    const kept = this.reuse ? this.store[kind][key] : undefined;
    const parsed = kept === undefined ? undefined : schema.safeParse(kept);
    if (parsed?.success) {
      this.reused += 1;
      return parsed.data;
    }
    this.made += 1;
    return undefined;
  }

  /** Keep the result of a call that succeeded, and write the file. */
  set(kind: MemoKind, key: string, value: unknown): void {
    this.store[kind][key] = value;
    writeFileSync(this.path, `${JSON.stringify({ head: this.head, ...this.store }, null, 2)}\n`);
  }

  /** The number of calls that a kept result served, and the number of calls made. */
  counts(): { reused: number; made: number } {
    return { reused: this.reused, made: this.made };
  }
}
