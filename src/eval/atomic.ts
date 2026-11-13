// Write a file in one step: a temp file in the same directory, then a rename.
// A kill leaves the old file or the new file, never half of one.
import { rename, writeFile } from "node:fs/promises";

/** Write "text" to "path". The temp name holds the pid, so two processes do not share it. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, text);
  await rename(temp, path);
}
