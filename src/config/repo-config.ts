// The repo config: the files under .pr-review/ on the base commit. The
// loader reads them from the git objects, never from a working tree, so a
// PR cannot change the config that reviews it.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { listFilesAt, readBlobBytesAt, readEntryModeAt } from "../gather/blob.js";
import {
  loadBuiltinReviewers,
  parseReviewer,
  ReviewerLoadError,
  type ReviewerDefinition,
} from "../reviewers/loader.js";
import { CATEGORIES, type Category } from "../schemas/finding.js";
import { ciEnum, integer } from "../schemas/json-schema.js";
import { EFFORTS, resolveModel, type Effort, type Role } from "./models.js";

/** The roles that models.<role> can set. The smoke query is not part of a run. */
export type ConfigRole = Exclude<Role, "smoke">;

export const CONFIG_ROLES: readonly ConfigRole[] = [
  "triage",
  "reviewer",
  "verifier",
  "verifier-escalation",
  "merge",
];

export type RepoConfig = {
  thresholds: { default: number; middle_band: [number, number] };
  reviewers: Record<
    string,
    { enabled: boolean; passes?: number; threshold?: number; model?: string; effort?: Effort }
  >;
  suppressions: { reviewer?: string; category?: Category; path?: string; reason: string }[];
  sensitive_globs: string[];
  generated_globs: string[];
  skip: { draft: boolean; title_keywords: string[]; labels: string[]; bot_authors: string[] };
  caps: { non_blocking_base: number; non_blocking_per_hunks: number; non_blocking_max: number };
  models: Partial<Record<ConfigRole, { model?: string; effort?: Effort }>>;
  pre_existing: "off" | "comment";
  concurrency: number;
  /** The most tokens that the run may use. Null means no ceiling. */
  token_ceiling: number | null;
};

export type Suppression = RepoConfig["suppressions"][number];

export type LoadedRepoConfig = {
  config: RepoConfig;
  /** The repo-relative paths of the loaded .pr-review/ files, in hash order. */
  files: string[];
  /** The SHA-256 of the loaded .pr-review/ files (spec R4), or null when none loaded. */
  hash: string | null;
  rulesMd: string | null;
  claudeMd: string | null;
  customReviewers: ReviewerDefinition[];
};

export const CONFIG_DIR = ".pr-review";
export const CONFIG_FILE = `${CONFIG_DIR}/config.yaml`;
export const RULES_FILE = `${CONFIG_DIR}/rules.md`;
export const REVIEWERS_DIR = `${CONFIG_DIR}/reviewers`;
export const CLAUDE_FILE = "CLAUDE.md";

/** The field name of an error that is about the whole file. */
export const ROOT_FIELD = "(root)";

/** A config file that does not parse or validate. The run stops and writes no record. */
export class RepoConfigError extends Error {
  readonly file: string;
  readonly field: string;

  constructor(file: string, field: string, detail: string) {
    super(`Invalid repo config in ${file}: ${field}: ${detail}`);
    this.name = "RepoConfigError";
    this.file = file;
    this.field = field;
  }
}

const percent = () =>
  integer().refine((value) => value >= 0 && value <= 100, {
    message: "must be an integer from 0 to 100",
  });

const atLeast = (min: number) =>
  integer().refine((value) => value >= min, { message: `must be an integer of ${min} or more` });

const modelName = () =>
  z.string().superRefine((value, ctx) => {
    try {
      resolveModel(value);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) });
    }
  });

const effort = () => ciEnum(EFFORTS as readonly [Effort, ...Effort[]]);

const ReviewerEntrySchema = z.strictObject({
  enabled: z.boolean().default(true),
  passes: atLeast(1).optional(),
  threshold: percent().optional(),
  model: modelName().optional(),
  effort: effort().optional(),
});

const RoleEntrySchema = z.strictObject({
  model: modelName().optional(),
  effort: effort().optional(),
});

const SuppressionSchema = z
  .strictObject({
    reviewer: z.string().optional(),
    category: ciEnum(CATEGORIES).optional(),
    path: z.string().optional(),
    reason: z.string().refine((value) => value.trim() !== "", { message: "must not be empty" }),
  })
  .refine(
    (item) => item.reviewer !== undefined || item.category !== undefined || item.path !== undefined,
    { message: "a suppression needs at least one of reviewer, category and path" },
  );

const DEFAULT_BAND: [number, number] = [60, 85];

/**
 * The schema of config.yaml, with every default. An unknown key is an
 * error. The record uses the same schema for its copy of the values.
 */
export const RepoConfigSchema: z.ZodType<RepoConfig, unknown> = z
  .strictObject({
    thresholds: z
      .strictObject({
        default: percent().default(80),
        middle_band: z
          .tuple([percent(), percent()])
          .refine(([low, high]) => low <= high, { message: "low must not be above high" })
          .default(DEFAULT_BAND),
      })
      .default({ default: 80, middle_band: DEFAULT_BAND }),
    reviewers: z.record(z.string(), ReviewerEntrySchema).default({}),
    suppressions: z.array(SuppressionSchema).default([]),
    sensitive_globs: z.array(z.string()).default([]),
    generated_globs: z.array(z.string()).default([]),
    skip: z
      .strictObject({
        draft: z.boolean().default(false),
        title_keywords: z.array(z.string()).default([]),
        labels: z.array(z.string()).default([]),
        bot_authors: z.array(z.string()).default([]),
      })
      .default({ draft: false, title_keywords: [], labels: [], bot_authors: [] }),
    caps: z
      .strictObject({
        non_blocking_base: atLeast(0).default(3),
        non_blocking_per_hunks: atLeast(1).default(4),
        non_blocking_max: atLeast(1).default(20),
      })
      .default({ non_blocking_base: 3, non_blocking_per_hunks: 4, non_blocking_max: 20 }),
    models: z
      .strictObject({
        triage: RoleEntrySchema.optional(),
        reviewer: RoleEntrySchema.optional(),
        verifier: RoleEntrySchema.optional(),
        "verifier-escalation": RoleEntrySchema.optional(),
        merge: RoleEntrySchema.optional(),
      })
      .default({}),
    pre_existing: z.enum(["off", "comment"]).default("off"),
    concurrency: atLeast(1).default(5),
    token_ceiling: atLeast(1).nullable().default(null),
  })
  .superRefine((config, ctx) => {
    // A reviewer threshold can be stricter than the repo floor, never looser.
    for (const [name, entry] of Object.entries(config.reviewers)) {
      if (entry.threshold !== undefined && entry.threshold < config.thresholds.default) {
        ctx.addIssue({
          code: "custom",
          path: ["reviewers", name, "threshold"],
          message: `${entry.threshold} is below thresholds.default (${config.thresholds.default})`,
        });
      }
    }
  });

/** The config of a repo with no .pr-review/config.yaml. */
export const DEFAULT_REPO_CONFIG: RepoConfig = RepoConfigSchema.parse({});

function fieldOf(path: readonly PropertyKey[], extra?: string): string {
  const parts = path.map((p) => String(p));
  if (extra !== undefined) parts.push(extra);
  return parts.length > 0 ? parts.join(".") : ROOT_FIELD;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse and check the text of config.yaml. "reviewerNames" holds every
 * built-in and custom reviewer name. Throw RepoConfigError on the first
 * problem, with the file and the field.
 */
export function parseRepoConfig(
  text: string,
  file: string,
  reviewerNames: readonly string[],
): RepoConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new RepoConfigError(file, ROOT_FIELD, `the YAML does not parse: ${messageOf(err)}`);
  }
  // An empty file gives the defaults.
  if (raw === null || raw === undefined) raw = {};

  const result = RepoConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) throw new RepoConfigError(file, ROOT_FIELD, "the config is not valid");
    if (issue.code === "unrecognized_keys") {
      const key = issue.keys[0] ?? "";
      throw new RepoConfigError(file, fieldOf(issue.path, key), "is not a known key");
    }
    throw new RepoConfigError(file, fieldOf(issue.path), issue.message);
  }

  const known = new Set(reviewerNames);
  for (const name of Object.keys(result.data.reviewers)) {
    if (!known.has(name)) {
      throw new RepoConfigError(
        file,
        fieldOf(["reviewers", name]),
        "is not a built-in or a custom reviewer",
      );
    }
  }
  // A suppression for a reviewer that does not exist would never match.
  // It is most likely a typo, so reject it.
  for (const [i, item] of result.data.suppressions.entries()) {
    if (item.reviewer !== undefined && !known.has(item.reviewer)) {
      throw new RepoConfigError(
        file,
        fieldOf(["suppressions", i, "reviewer"]),
        `"${item.reviewer}" is not a built-in or a custom reviewer`,
      );
    }
  }
  return result.data;
}

function byPathBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The config hash of spec R4: each entry is the path, one newline, then
 * the file bytes; the entries are in UTF-8 path byte order, joined with
 * one NUL byte; the result is the hex SHA-256. Null when there is no file.
 */
export function configHash(files: ReadonlyMap<string, Buffer>): string | null {
  if (files.size === 0) return null;
  const hash = createHash("sha256");
  [...files.keys()].sort(byPathBytes).forEach((path, i) => {
    if (i > 0) hash.update(Buffer.from([0]));
    hash.update(Buffer.from(`${path}\n`, "utf8"));
    hash.update(files.get(path) as Buffer);
  });
  return hash.digest("hex");
}

function loadCustomReviewer(path: string, bytes: Buffer): ReviewerDefinition {
  try {
    return parseReviewer(bytes.toString("utf8"), path, "custom");
  } catch (err) {
    if (!(err instanceof ReviewerLoadError)) throw err;
    const first = err.issues[0];
    const field = first ? fieldOf(first.path) : ROOT_FIELD;
    const detail = err.issues.map((i) => `${fieldOf(i.path)}: ${i.message}`).join("; ");
    throw new RepoConfigError(path, field, detail);
  }
}

// A symlink and a submodule are not files that the run reads.
const NON_REGULAR_MODES = new Set(["120000", "160000"]);

/**
 * Read a config file at the commit. Give null when it is absent. Throw
 * RepoConfigError when the entry is a symlink or a submodule, so a config
 * file that git does not store as a file never passes as an absent one.
 */
async function readConfigFile(repo: string, commit: string, path: string): Promise<Buffer | null> {
  const mode = await readEntryModeAt(repo, commit, path);
  if (mode !== null && NON_REGULAR_MODES.has(mode)) {
    const kind = mode === "120000" ? "a symlink" : "a submodule";
    throw new RepoConfigError(
      path,
      ROOT_FIELD,
      `is ${kind} (mode ${mode}) at the base commit, not a regular file`,
    );
  }
  return readBlobBytesAt(repo, commit, path);
}

/**
 * Load the repo config from the git objects of "commit": config.yaml,
 * rules.md and reviewers/*.md under .pr-review/, and the root CLAUDE.md.
 * Use the defaults for a file that is absent. Throw RepoConfigError when
 * a file does not parse or validate.
 */
export async function loadRepoConfig(repo: string, commit: string): Promise<LoadedRepoConfig> {
  const loaded = new Map<string, Buffer>();

  const builtinNames = loadBuiltinReviewers().map((d) => d.frontmatter.name);
  const builtins = new Set(builtinNames);
  const customReviewers: ReviewerDefinition[] = [];
  const customPaths = new Map<string, string>();
  const reviewerFiles = (await listFilesAt(repo, commit, REVIEWERS_DIR))
    .filter((path) => path.endsWith(".md"))
    .sort(byPathBytes);
  for (const path of reviewerFiles) {
    const bytes = await readConfigFile(repo, commit, path);
    if (bytes === null) continue;
    const def = loadCustomReviewer(path, bytes);
    const name = def.frontmatter.name;
    if (builtins.has(name)) {
      throw new RepoConfigError(path, "name", `"${name}" is the name of a built-in reviewer`);
    }
    const first = customPaths.get(name);
    if (first !== undefined) {
      throw new RepoConfigError(path, "name", `"${name}" is also the name of ${first}`);
    }
    customPaths.set(name, path);
    customReviewers.push(def);
    loaded.set(path, bytes);
  }

  let config = DEFAULT_REPO_CONFIG;
  const configBytes = await readConfigFile(repo, commit, CONFIG_FILE);
  if (configBytes !== null) {
    config = parseRepoConfig(configBytes.toString("utf8"), CONFIG_FILE, [
      ...builtinNames,
      ...customPaths.keys(),
    ]);
    loaded.set(CONFIG_FILE, configBytes);
  }

  const rulesBytes = await readConfigFile(repo, commit, RULES_FILE);
  if (rulesBytes !== null) loaded.set(RULES_FILE, rulesBytes);

  // CLAUDE.md is injected into the prompts, but it is not part of the hash.
  const claudeBytes = await readBlobBytesAt(repo, commit, CLAUDE_FILE);

  return {
    config,
    files: [...loaded.keys()].sort(byPathBytes),
    hash: configHash(loaded),
    rulesMd: rulesBytes === null ? null : rulesBytes.toString("utf8"),
    claudeMd: claudeBytes === null ? null : claudeBytes.toString("utf8"),
    customReviewers,
  };
}
