// Load and validate the cases of an eval. A case is one directory with
// case.json, repo.bundle, diff.patch and golden.json.
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runGit } from "../gather/worktree.js";
import { CATEGORIES, SEVERITIES, type Category, type Severity } from "../schemas/finding.js";

export type CaseSource = "fixture" | "pr" | "reviewbench" | "martian" | "injection" | "record";

export type GoldenFinding = {
  file: string;
  start_line: number;
  end_line: number;
  category: Category;
  severity: Severity;
  claim: string;
  note?: string;
};

export type Case = {
  dir: string;
  name: string;
  source: CaseSource;
  base: string;
  head: string;
  title: string;
  body: string;
  origin: string;
  language: string;
  golden: GoldenFinding[];
};

/**
 * An invalid case or cases directory. "caseName" is null when the problem
 * is the cases directory itself.
 */
export class CaseError extends Error {
  readonly caseName: string | null;

  constructor(caseName: string | null, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaseError";
    this.caseName = caseName;
  }
}

const CASE_SOURCES = ["fixture", "pr", "reviewbench", "martian", "injection", "record"] as const;

// These schemas never go to the SDK, so they can hold range checks.
// Strict objects make a misspelt field name fail.
const CaseMetaSchema = z.strictObject({
  name: z.string(),
  source: z.enum(CASE_SOURCES),
  base: z.string(),
  head: z.string(),
  title: z.string(),
  body: z.string(),
  origin: z.string(),
  language: z.string(),
});

const GoldenFindingSchema = z
  .strictObject({
    file: z.string(),
    start_line: z.int().min(1),
    end_line: z.int(),
    category: z.enum(CATEGORIES),
    severity: z.enum(SEVERITIES),
    claim: z.string(),
    note: z.string().optional(),
  })
  .refine((f) => f.end_line >= f.start_line, {
    message: "end_line is below start_line",
    path: ["end_line"],
  });

const GoldenSchema = z.strictObject({ findings: z.array(GoldenFindingSchema) });

/** The files that every case holds, apart from case.json. */
const CASE_FILES = ["repo.bundle", "diff.patch", "golden.json"] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Read one JSON file of a case and validate it with "schema". */
async function readJson<T>(
  name: string,
  dir: string,
  file: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(dir, file), "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CaseError(name, `case ${name}: ${file} is not valid JSON: ${reason}`, {
      cause: err,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CaseError(name, `case ${name}: ${file} is invalid: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

async function loadCase(dir: string, name: string): Promise<Case> {
  for (const file of CASE_FILES) {
    if (!(await exists(join(dir, file)))) {
      throw new CaseError(name, `case ${name}: ${file} is missing`);
    }
  }
  const meta = await readJson(name, dir, "case.json", CaseMetaSchema);
  if (meta.name !== name) {
    throw new CaseError(
      name,
      `case ${name}: case.json has the name "${meta.name}", which differs from the directory name`,
    );
  }
  const golden = await readJson(name, dir, "golden.json", GoldenSchema);
  return { dir, ...meta, golden: golden.findings };
}

/**
 * Load every case in "dir", in name order. A subdirectory without
 * case.json is not a case. Throw a CaseError for the first invalid case,
 * and for a cases directory that holds no case.
 */
export async function loadCases(dir: string): Promise<Case[]> {
  const root = resolve(dir);
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CaseError(null, `cannot read the cases directory ${root}: ${reason}`, {
      cause: err,
    });
  }
  // Compare code units, so the order does not depend on the locale.
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const cases: Case[] = [];
  for (const name of names) {
    const caseDir = join(root, name);
    if (!(await exists(join(caseDir, "case.json")))) continue;
    cases.push(await loadCase(caseDir, name));
  }
  if (cases.length === 0) {
    throw new CaseError(null, `the cases directory ${root} holds no case`);
  }
  return cases;
}

/**
 * Give the HEAD sha of "dir" when "dir" is the top level of a git work
 * tree. Give null otherwise, also for a plain directory inside the work
 * tree of another repo.
 */
export async function casesRef(dir: string): Promise<string | null> {
  try {
    const top = (await runGit(dir, ["rev-parse", "--show-toplevel"])).trim();
    if ((await realpath(top)) !== (await realpath(dir))) return null;
    return (await runGit(dir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  } catch {
    return null;
  }
}
