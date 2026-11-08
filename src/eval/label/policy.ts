// Read the severity policy that the labeler applies.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This file is at src/eval/label/policy.ts and at dist/eval/label/policy.js.
// In both cases the package root is three levels up.
const POLICY_PATH = fileURLToPath(
  new URL("../../../docs/design/severity-policy.md", import.meta.url),
);

/** The full text of docs/design/severity-policy.md. */
export function readPolicy(): string {
  try {
    return readFileSync(POLICY_PATH, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read the severity policy ${POLICY_PATH}: ${reason}`, { cause: err });
  }
}
