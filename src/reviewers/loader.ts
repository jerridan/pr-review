// Load reviewer files. A reviewer is one markdown file: the frontmatter
// sets its model, effort and triggers, and the body is its system prompt.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config/repo-config.js";
import { resolveModel, ROLE_DEFAULTS, type Effort } from "../config/models.js";
import { parseFrontmatter, promptPath } from "../prompts/load.js";
import { narrowReadOnlyTools } from "../sdk/options.js";
import { ReviewerFrontmatterSchema, type ReviewerFrontmatter } from "../schemas/reviewer.js";
import type { Tier } from "../triage/tier.js";

export interface ReviewerDefinition {
  frontmatter: ReviewerFrontmatter;
  systemPrompt: string;
  /**
   * The file of the reviewer: an absolute path for a built-in reviewer,
   * and a repo-relative path in the base commit for a custom reviewer.
   */
  path: string;
  /** "builtin" for a file under prompts/reviewers, "custom" for one under .pr-review/reviewers. */
  source: "builtin" | "custom";
}

export type Issue = { path: (string | number)[]; message: string };

export class ReviewerLoadError extends Error {
  path: string;
  issues: Issue[];

  constructor(path: string, issues: Issue[]) {
    const lines = issues.map(
      (i) => `- ${i.path.length > 0 ? i.path.join(".") : "file"}: ${i.message}`,
    );
    super(`Cannot load reviewer ${path}:\n${lines.join("\n")}`);
    this.name = "ReviewerLoadError";
    this.path = path;
    this.issues = issues;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Load and check one reviewer file. Throw ReviewerLoadError on a bad file. */
export function loadReviewer(
  path: string,
  source: ReviewerDefinition["source"] = "builtin",
): ReviewerDefinition {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ReviewerLoadError(path, [
      { path: [], message: `cannot read the file: ${messageOf(err)}` },
    ]);
  }
  return parseReviewer(text, path, source);
}

/**
 * Check the text of one reviewer file. "path" names the file in errors.
 * Throw ReviewerLoadError on a bad file.
 */
export function parseReviewer(
  text: string,
  path: string,
  source: ReviewerDefinition["source"],
): ReviewerDefinition {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    throw new ReviewerLoadError(path, [{ path: ["frontmatter"], message: messageOf(err) }]);
  }
  if (Object.keys(parsed.frontmatter).length === 0) {
    throw new ReviewerLoadError(path, [
      { path: ["frontmatter"], message: "the file has no frontmatter block" },
    ]);
  }

  const result = ReviewerFrontmatterSchema.safeParse(parsed.frontmatter);
  if (!result.success) {
    throw new ReviewerLoadError(
      path,
      result.error.issues.map((issue) => ({
        path: issue.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
        message: issue.message,
      })),
    );
  }

  const issues: Issue[] = [];
  if (result.data.model !== undefined) {
    try {
      resolveModel(result.data.model);
    } catch (err) {
      issues.push({ path: ["model"], message: messageOf(err) });
    }
  }
  const systemPrompt = parsed.body.replace(/^(?:\r?\n)+/, "");
  if (systemPrompt.trim() === "") {
    issues.push({ path: ["body"], message: "the body is empty; it is the system prompt" });
  }
  if (issues.length > 0) throw new ReviewerLoadError(path, issues);

  return { frontmatter: result.data, systemPrompt, path, source };
}

/** Load every reviewer under prompts/reviewers, in name order of the files. */
export function loadBuiltinReviewers(): ReviewerDefinition[] {
  const dir = promptPath("reviewers");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const defs = files.map((name) => loadReviewer(join(dir, name), "builtin"));
  const seen = new Map<string, string>();
  for (const def of defs) {
    const first = seen.get(def.frontmatter.name);
    if (first) {
      throw new ReviewerLoadError(def.path, [
        { path: ["name"], message: `the name "${def.frontmatter.name}" is also used by ${first}` },
      ]);
    }
    seen.set(def.frontmatter.name, def.path);
  }
  return defs;
}

/** The one tool beyond the read-only set that a reviewer can get. */
export const BASH_TOOL = "Bash";

/**
 * The tools of a reviewer: the read-only tools that its frontmatter names,
 * Bash when the run grants it, and the names that the query does not get.
 * The run grants Bash only to a custom reviewer whose tools name Bash, that
 * sets "trusted: true", and whose PR author has write access. A built-in
 * reviewer never gets Bash. "bashReason" tells why a custom reviewer that
 * names Bash did not get it, and is null in every other case.
 */
export function reviewerTools(
  def: ReviewerDefinition,
  authorWriteAccess: boolean,
): { granted: string[]; ignored: string[]; bashGranted: boolean; bashReason: string | null } {
  const { granted, ignored } = narrowReadOnlyTools(def.frontmatter.tools);
  const isBash = (tool: string) => tool.trim().toLowerCase() === BASH_TOOL.toLowerCase();
  if (def.source !== "custom" || !def.frontmatter.tools.some(isBash)) {
    return { granted, ignored, bashGranted: false, bashReason: null };
  }
  const reasons: string[] = [];
  if (def.frontmatter.trusted !== true) reasons.push("not trusted");
  if (!authorWriteAccess) reasons.push("author has no write access");
  if (reasons.length > 0) {
    return { granted, ignored, bashGranted: false, bashReason: reasons.join(" and ") };
  }
  return {
    granted: [...granted, BASH_TOOL],
    ignored: ignored.filter((tool) => !isBash(tool)),
    bashGranted: true,
    bashReason: null,
  };
}

/**
 * The reviewers.<name> entry of the config, or undefined when the config
 * has none. Only own keys count, so a name such as "constructor" does not
 * read a property of the object prototype.
 */
export function reviewerEntry(
  config: RepoConfig,
  name: string,
): RepoConfig["reviewers"][string] | undefined {
  return Object.hasOwn(config.reviewers, name) ? config.reviewers[name] : undefined;
}

/**
 * The threshold of a reviewer: reviewers.<name>.threshold when the config
 * sets it, else the higher of the frontmatter value and thresholds.default.
 */
export function effectiveThreshold(def: ReviewerDefinition, config: RepoConfig): number {
  const set = reviewerEntry(config, def.frontmatter.name)?.threshold;
  if (set !== undefined) return set;
  return Math.max(def.frontmatter.threshold, config.thresholds.default);
}

/**
 * The model, as a pinned ID, and the effort of a reviewer's queries. Each
 * comes from reviewers.<name> when set, then models.reviewer when set,
 * then the frontmatter when it sets one, then ROLE_DEFAULTS.reviewer. The
 * model and the effort resolve apart.
 */
export function effectiveModel(
  def: ReviewerDefinition,
  config: RepoConfig,
): { model: string; effort: Effort } {
  const own = reviewerEntry(config, def.frontmatter.name);
  const role = config.models.reviewer;
  return {
    model: resolveModel(
      own?.model ?? role?.model ?? def.frontmatter.model ?? ROLE_DEFAULTS.reviewer.model,
    ),
    effort: own?.effort ?? role?.effort ?? def.frontmatter.effort ?? ROLE_DEFAULTS.reviewer.effort,
  };
}

/**
 * The number of passes of a reviewer: 1 at the fast tier, else
 * reviewers.<name>.passes when set, else the frontmatter value.
 */
export function effectivePasses(def: ReviewerDefinition, config: RepoConfig, tier: Tier): number {
  if (tier === "fast") return 1;
  return reviewerEntry(config, def.frontmatter.name)?.passes ?? def.frontmatter.passes;
}
