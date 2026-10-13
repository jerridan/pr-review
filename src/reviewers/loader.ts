// Load reviewer files. A reviewer is one markdown file: the frontmatter
// sets its model, effort and triggers, and the body is its system prompt.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveModel, type Effort } from "../config/models.js";
import { parseFrontmatter, promptPath } from "../prompts/load.js";
import { narrowReadOnlyTools } from "../sdk/options.js";
import { ReviewerFrontmatterSchema, type ReviewerFrontmatter } from "../schemas/reviewer.js";

export interface ReviewerDefinition {
  frontmatter: ReviewerFrontmatter;
  systemPrompt: string;
  path: string;
}

type Issue = { path: (string | number)[]; message: string };

export class ReviewerLoadError extends Error {
  path: string;
  issues: unknown[];

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
export function loadReviewer(path: string): ReviewerDefinition {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ReviewerLoadError(path, [
      { path: [], message: `cannot read the file: ${messageOf(err)}` },
    ]);
  }

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
  try {
    resolveModel(result.data.model);
  } catch (err) {
    issues.push({ path: ["model"], message: messageOf(err) });
  }
  const systemPrompt = parsed.body.replace(/^(?:\r?\n)+/, "");
  if (systemPrompt.trim() === "") {
    issues.push({ path: ["body"], message: "the body is empty; it is the system prompt" });
  }
  if (issues.length > 0) throw new ReviewerLoadError(path, issues);

  return { frontmatter: result.data, systemPrompt, path };
}

/** Load every reviewer under prompts/reviewers, in name order of the files. */
export function loadBuiltinReviewers(): ReviewerDefinition[] {
  const dir = promptPath("reviewers");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const defs = files.map((name) => loadReviewer(join(dir, name)));
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

/**
 * The query overrides for a reviewer: its model as a pinned ID, and its
 * effort. They apply to the queries of this reviewer only.
 */
export function reviewerOverrides(def: ReviewerDefinition): { model: string; effort: Effort } {
  return { model: resolveModel(def.frontmatter.model), effort: def.frontmatter.effort };
}

/**
 * The tools of a reviewer: the read-only tools that its frontmatter names,
 * and the names that are not read-only tools. The query never gets an
 * ignored tool. The "trusted" field is parsed but not used in D1.
 */
export function reviewerTools(def: ReviewerDefinition): { granted: string[]; ignored: string[] } {
  return narrowReadOnlyTools(def.frontmatter.tools);
}
