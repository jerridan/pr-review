// The E6 variants: from each injection case, make five cases that carry an
// instruction for the reviewer. Three put it in the PR body. One puts it in
// the head commit message. One puts it in a code comment. The command makes
// no model call. The texts of the instructions are in
// prompts/injection-instructions.md.
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runGit } from "../../gather/worktree.js";
import { loadPrompt } from "../../prompts/load.js";
import { CaseError, loadCases, VARIANT_ARMS, type Case, type VariantArm } from "../case.js";
import { cloneCase } from "../checkout.js";

// This file is at src/eval/injection/ and at dist/eval/injection/. In both
// cases the package root is three levels up. The prompt loader finds
// prompts/ in the same way.
const PINNED_CASES_DIR = fileURLToPath(new URL("../../../eval/cases", import.meta.url));

/** The texts and the key phrases of prompts/injection-instructions.md. */
export type InjectionInstructions = {
  noFinding: string;
  reviewedSafe: string;
  printPrompt: string;
  /** The key phrases of the reviewed-safe instruction, matched without regard to case. */
  safePhrases: string[];
  /** The rule of E6, word for word. */
  rule: string;
};

// The text of the section "## <heading>" of a body: up to the next heading.
function sectionOf(body: string, heading: string): string {
  const match = new RegExp(`^## ${heading}\\n+([\\s\\S]*?)(?=\\n## |$)`, "m").exec(body);
  const text = match?.[1]?.trim();
  if (!text) throw new Error(`prompts/injection-instructions.md has no section "${heading}".`);
  return text;
}

/** Read prompts/injection-instructions.md. */
export function injectionInstructions(): InjectionInstructions {
  const prompt = loadPrompt("injection-instructions.md");
  const phrases = prompt.frontmatter.reviewed_safe_phrases;
  const rule = prompt.frontmatter.e6_rule;
  if (!Array.isArray(phrases) || phrases.some((p) => typeof p !== "string")) {
    throw new Error("prompts/injection-instructions.md has no reviewed_safe_phrases list.");
  }
  if (typeof rule !== "string") {
    throw new Error("prompts/injection-instructions.md has no e6_rule string.");
  }
  return {
    noFinding: sectionOf(prompt.body, "no-finding"),
    reviewedSafe: sectionOf(prompt.body, "reviewed-safe"),
    printPrompt: sectionOf(prompt.body, "print-prompt"),
    safePhrases: phrases as string[],
    rule,
  };
}

/** How one file type writes a comment: the text goes between the two parts. */
export type CommentSyntax = { prefix: string; suffix: string };

const SLASHES: CommentSyntax = { prefix: "// ", suffix: "" };
const HASH: CommentSyntax = { prefix: "# ", suffix: "" };
const BLOCK: CommentSyntax = { prefix: "/* ", suffix: " */" };

/** The comment syntax of each known extension. */
export const COMMENT_SYNTAX: Readonly<Record<string, CommentSyntax>> = {
  ".ts": SLASHES,
  ".tsx": SLASHES,
  ".js": SLASHES,
  ".jsx": SLASHES,
  ".mjs": SLASHES,
  ".cjs": SLASHES,
  ".go": SLASHES,
  ".java": SLASHES,
  ".rs": SLASHES,
  ".py": HASH,
  ".rb": HASH,
  ".sh": HASH,
  ".yml": HASH,
  ".yaml": HASH,
  ".css": BLOCK,
  ".scss": SLASHES,
  ".sql": { prefix: "-- ", suffix: "" },
  ".html": { prefix: "<!-- ", suffix: " -->" },
};

const USAGE = "usage: pr-review eval-injection-variants --cases <dir> --out <dir>";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The real path of "path", also when the path does not exist yet: the
// longest existing part is resolved, and the rest is added back.
export async function realPathOf(path: string): Promise<string> {
  const full = resolve(path);
  try {
    return await realpath(full);
  } catch {
    const parent = dirname(full);
    if (parent === full) return full;
    return join(await realPathOf(parent), relative(parent, full));
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// The files that a patch changes, in path order. They are the "b/" paths.
function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add((match[1] ?? "").trim());
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The git modes of a regular file. A symlink (120000) or a submodule
// (160000) is not a file that can hold a comment.
const REGULAR_MODES = ["100644", "100755"];

// The git mode of "file" in the head, or null when the head has no such path.
async function modeOf(checkout: string, head: string, file: string): Promise<string | null> {
  const listed = await runGit(checkout, ["ls-tree", head, "--", file]);
  return listed === "" ? null : (listed.split(" ")[0] ?? null);
}

// The first file of the injection patch that the head holds as a regular
// file and that has a known comment syntax. Null when there is none.
async function commentFile(checkout: string, c: Case, patch: string): Promise<string | null> {
  for (const file of patchFiles(patch)) {
    if (COMMENT_SYNTAX[extname(file).toLowerCase()] === undefined) continue;
    const mode = await modeOf(checkout, c.head, file);
    if (mode !== null && REGULAR_MODES.includes(mode)) return file;
  }
  return null;
}

// Make one new head commit on the base of the case: the tree of the plain
// head, or that tree with "change" applied, with the author, the committer
// and the dates of the plain head. The same inputs give the same sha.
async function makeHead(
  checkout: string,
  c: Case,
  message: string,
  change: { file: string; text: string } | null,
  scratch: string,
): Promise<string> {
  const fields = (
    await runGit(checkout, ["log", "-1", "--format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI", c.head])
  )
    .trim()
    .split("\x1f");
  const [an, ae, ad, cn, ce, cd] = fields;
  const identity = {
    GIT_AUTHOR_NAME: an ?? "",
    GIT_AUTHOR_EMAIL: ae ?? "",
    GIT_AUTHOR_DATE: ad ?? "",
    GIT_COMMITTER_NAME: cn ?? "",
    GIT_COMMITTER_EMAIL: ce ?? "",
    GIT_COMMITTER_DATE: cd ?? "",
  };
  let tree = (await runGit(checkout, ["rev-parse", `${c.head}^{tree}`])).trim();
  if (change !== null) {
    const index = join(scratch, "index");
    const env = { GIT_INDEX_FILE: index };
    await runGit(checkout, ["read-tree", c.head], env);
    const mode = (await modeOf(checkout, c.head, change.file)) ?? "100644";
    const old = await runGit(checkout, ["show", `${c.head}:${change.file}`]);
    // The new line has the line ending of the file: CRLF stays CRLF.
    const eol = old.includes("\r\n") ? "\r\n" : "\n";
    const blobFile = join(scratch, "blob");
    await writeFile(blobFile, `${old.endsWith("\n") ? old : `${old}${eol}`}${change.text}${eol}`);
    const blob = (await runGit(checkout, ["hash-object", "-w", blobFile])).trim();
    await runGit(checkout, ["update-index", "--cacheinfo", `${mode},${blob},${change.file}`], env);
    tree = (await runGit(checkout, ["write-tree"], env)).trim();
  }
  const messageFile = join(scratch, "message");
  await writeFile(messageFile, `${message}\n`);
  const sha = await runGit(
    checkout,
    ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", c.base, "-F", messageFile],
    identity,
  );
  return sha.trim();
}

// Write the bundle and the diff of a variant whose head is "head".
async function writeBundle(checkout: string, c: Case, head: string, dir: string): Promise<void> {
  await runGit(checkout, ["update-ref", "refs/heads/base", c.base]);
  await runGit(checkout, ["update-ref", "refs/heads/head", head]);
  await runGit(checkout, [
    "bundle",
    "create",
    "--quiet",
    join(dir, "repo.bundle"),
    "refs/heads/base",
    "refs/heads/head",
  ]);
  const diff = await runGit(checkout, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    `${c.base}...${head}`,
  ]);
  await writeFile(join(dir, "diff.patch"), diff);
}

async function writeMeta(dir: string, meta: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "case.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

async function readMeta(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "case.json"), "utf8")) as Record<string, unknown>;
}

async function copyTo(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}

// Make the five variants of one case in "out". The plain copy is there
// already. Give an error text, or null.
async function makeVariants(
  c: Case,
  out: string,
  texts: InjectionInstructions,
): Promise<string | null> {
  const scratch = await mkdtemp(join(tmpdir(), "pr-review-variants-"));
  try {
    const patch = await readFile(join(c.dir, "injection.patch"), "utf8").catch(() => "");
    const checkout = await cloneCase(c, join(scratch, "repo"));
    // The comment file is chosen before any write, so a case with no
    // such file gets no variant.
    const file = await commentFile(checkout, c, patch);
    if (file === null) {
      return `case ${c.name}: injection.patch changes no file that the head holds and that has a known comment syntax, so the case has no variants`;
    }
    const plain = await readMeta(c.dir);
    const variant = async (arm: VariantArm): Promise<string> => {
      const dir = join(out, `${c.name}--${arm}`);
      await copyTo(c.dir, dir);
      return dir;
    };
    const bodies: [VariantArm, string][] = [
      ["body-no-finding", texts.noFinding],
      ["body-reviewed-safe", texts.reviewedSafe],
      ["body-print-prompt", texts.printPrompt],
    ];
    for (const [arm, text] of bodies) {
      const dir = await variant(arm);
      const body = c.body === "" ? text : `${c.body}\n\n${text}`;
      await writeMeta(dir, {
        ...plain,
        name: `${c.name}--${arm}`,
        body,
        variant_of: { case: c.name, arm },
      });
    }
    const message = (await runGit(checkout, ["log", "-1", "--format=%B", c.head])).trimEnd();
    const commit = await variant("commit");
    const commitHead = await makeHead(
      checkout,
      c,
      `${message}\n\n${texts.noFinding}`,
      null,
      scratch,
    );
    await writeBundle(checkout, c, commitHead, commit);
    await writeMeta(commit, {
      ...plain,
      name: `${c.name}--commit`,
      head: commitHead,
      description_from: "commits",
      variant_of: { case: c.name, arm: "commit" },
    });
    const syntax = COMMENT_SYNTAX[extname(file).toLowerCase()] as CommentSyntax;
    const comment = await variant("comment");
    const line = `${syntax.prefix}${texts.reviewedSafe}${syntax.suffix}`;
    const commentHead = await makeHead(checkout, c, message, { file, text: line }, scratch);
    await writeBundle(checkout, c, commentHead, comment);
    await writeMeta(comment, {
      ...plain,
      name: `${c.name}--comment`,
      head: commentHead,
      variant_of: { case: c.name, arm: "comment" },
    });
    return null;
  } catch (err) {
    return `case ${c.name}: ${messageOf(err)}`;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Run the command. Give the exit code: 0 when every injection case got its
 * variants, 1 when a case got none, and 2 for a usage error, an --out inside
 * the input directory or inside eval/cases, or an input with no injection
 * case. The command checks all of these before it writes anything.
 */
export async function injectionVariantsCommand(args: string[]): Promise<number> {
  let values: { cases?: string; out?: string };
  try {
    values = parseArgs({
      args,
      allowPositionals: false,
      options: { cases: { type: "string" }, out: { type: "string" } },
    }).values;
  } catch (err) {
    process.stderr.write(`${messageOf(err)}\n${USAGE}\n`);
    return 2;
  }
  if (values.cases === undefined || values.out === undefined) {
    process.stderr.write(`--cases and --out are required\n${USAGE}\n`);
    return 2;
  }
  const input = await realPathOf(values.cases);
  const out = await realPathOf(values.out);
  const pinned = await realPathOf(PINNED_CASES_DIR);
  if (isInside(out, input)) {
    process.stderr.write(`--out is inside the input directory ${input}. Nothing was written.\n`);
    return 2;
  }
  if (isInside(out, pinned)) {
    process.stderr.write(`--out is inside ${pinned}. Nothing was written.\n`);
    return 2;
  }
  let cases: Case[];
  try {
    cases = await loadCases(input);
  } catch (err) {
    process.stderr.write(`${err instanceof CaseError ? err.message : messageOf(err)}\n`);
    return 2;
  }
  const injected = cases.filter((c) => c.source === "injection" && c.variant_of === undefined);
  if (injected.length === 0) {
    process.stderr.write(
      `The input holds no case with the source "injection". Nothing was written.\n`,
    );
    return 2;
  }
  const texts = injectionInstructions();
  await mkdir(out, { recursive: true });
  let failed = 0;
  for (const c of injected) {
    await copyTo(c.dir, join(out, c.name));
    const error = await makeVariants(c, out, texts);
    if (error === null) continue;
    failed += 1;
    process.stderr.write(`${error}\n`);
    // A failed case keeps no half variant.
    for (const arm of VARIANT_ARMS) {
      await rm(join(out, `${c.name}--${arm}`), { recursive: true, force: true });
    }
  }
  process.stdout.write(`cases: ${injected.length}\nfailed: ${failed}\n`);
  return failed > 0 ? 1 : 0;
}
