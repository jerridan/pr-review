// Suppressions: rules from the repo config that remove a verified finding
// before the merge groups form. Each finding is checked with the name of
// the reviewer that reported it.
import { matchesAny } from "../config/globs.js";
import type { Suppression } from "../config/repo-config.js";
import type { Finding } from "../schemas/finding.js";

// A finding matches a rule when it matches every key that the rule gives.
function matches(item: { finding: Finding; reviewer: string }, rule: Suppression): boolean {
  if (rule.reviewer !== undefined && rule.reviewer !== item.reviewer) return false;
  if (rule.category !== undefined && rule.category !== item.finding.category) return false;
  if (rule.path !== undefined && !matchesAny(item.finding.file, [rule.path])) return false;
  return true;
}

/**
 * Split the findings into those that stay and those that a rule removes.
 * The first rule that matches a finding is the rule that the record names.
 * Both lists keep the order of the input.
 */
export function applySuppressions<T extends { finding: Finding; reviewer: string }>(
  findings: T[],
  rules: Suppression[],
): { kept: T[]; suppressed: (T & { rule: Suppression })[] } {
  const kept: T[] = [];
  const suppressed: (T & { rule: Suppression })[] = [];
  for (const item of findings) {
    const rule = rules.find((r) => matches(item, r));
    if (rule === undefined) kept.push(item);
    else suppressed.push({ ...item, rule });
  }
  return { kept, suppressed };
}
