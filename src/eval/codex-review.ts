// The Codex arm of the general-review test: run the general-review prompt
// through Codex on each case of a cases directory, and write the findings as
// outside candidates, one file per case. The prompt texts are in prompts/.
// The command reads no credential. Codex finds its own login.
import { mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { withRepoGlobs } from "../config/globs.js";
import { loadRepoConfig } from "../config/repo-config.js";
import { buildReviewerMessage, buildReviewerSystemPrompt, reviewerTexts } from "../find/index.js";
import { gather, resolveCommit } from "../gather/index.js";
import { sanitizeGitHubText } from "../github/sanitize.js";
import { loadPrompt, render } from "../prompts/load.js";
import { loadBuiltinReviewers } from "../reviewers/loader.js";
import { FindingSchema, findingShape, type Finding } from "../schemas/finding.js";
import { writeFileAtomic } from "./atomic.js";
import { CaseError, loadCases, type Case } from "./case.js";
import { cloneCase } from "./checkout.js";
import { codexQuotaError, runCodex, TERRA_MODEL, type CodexEffort } from "./codex.js";

const REVIEWER = "general-review";
const EFFORTS: readonly CodexEffort[] = ["low", "medium", "high", "xhigh"];

/** What the command line holds. */
export type CodexReviewOptions = {
  cases: string;
  out: string;
  model: string;
  effort: CodexEffort;
  /** The "source" of each file. The default names the model and the effort. */
  source: string;
  /** Run again the cases that already have a file. */
  force: boolean;
};

// Codex checks the output schema in strict mode: each property is required.
// So the Codex schema holds "suggested_fix" as a string, and an empty string
// means that the reviewer knows no fix. The command drops the empty string.
const CodexFindingSchema = z.strictObject({ ...findingShape, suggested_fix: z.string() });
const CodexOutputSchema = z.strictObject({ findings: z.array(CodexFindingSchema) });

const USAGE =
  "usage: pr-review eval-codex-review --cases <dir> --out <dir> [--model <id>] [--effort low|medium|high|xhigh] [--source <name>] [--force]";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse the command line. Give an error text for a usage error. */
export function parseCodexReviewArgs(
  args: string[],
): { ok: true; options: CodexReviewOptions } | { ok: false; error: string } {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      allowPositionals: false,
      options: {
        cases: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        source: { type: "string" },
        force: { type: "boolean" },
      },
    }).values;
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
  const { cases, out } = values;
  if (typeof cases !== "string" || typeof out !== "string") {
    return { ok: false, error: "--cases and --out are required" };
  }
  const effort = typeof values.effort === "string" ? values.effort : "high";
  if (!EFFORTS.includes(effort as CodexEffort)) {
    return { ok: false, error: `--effort must be one of ${EFFORTS.join(", ")}` };
  }
  const model = typeof values.model === "string" ? values.model : TERRA_MODEL;
  const source =
    typeof values.source === "string" ? values.source : `codex-general-review-${model}-${effort}`;
  return {
    ok: true,
    options: {
      cases,
      out: resolve(out),
      model,
      effort: effort as CodexEffort,
      source,
      force: values.force === true,
    },
  };
}

// The Codex prompt of one case: the system prompt of a pipeline reviewer and
// its user message, with no triage brief and no history, in the wrapper of
// prompts/codex-review.md.
async function promptOf(c: Case, checkout: string): Promise<string> {
  const baseSha = await resolveCommit(checkout, c.base);
  const loaded = await loadRepoConfig(checkout, baseSha);
  // The exclusions are those of the repo config, as in an eval run. The
  // prompt holds no history block, so gather builds none.
  const gathered = await gather(checkout, baseSha, c.head, {
    ...withRepoGlobs(loaded.config),
    history: false,
    fileHistory: false,
  });
  // The description is the sanitized title and body, as src/run.ts builds it.
  // A case with description_from "commits" gets no such description, as in an
  // eval run. Gather then holds the sanitized commit messages of base..head
  // (commitMessages and sanitizeCommitMessages), and the command keeps them.
  const description =
    c.description_from === "commits"
      ? gathered.description
      : `${sanitizeGitHubText(c.title).text}\n\n${sanitizeGitHubText(c.body).text}`;
  const def = loadBuiltinReviewers().find((d) => d.frontmatter.name === REVIEWER);
  if (!def) throw new Error(`The built-in reviewer ${REVIEWER} is missing.`);
  const system = buildReviewerSystemPrompt(def.systemPrompt, {
    claudeMd: loaded.claudeMd,
    rulesMd: loaded.rulesMd,
  }).prompt;
  const message = buildReviewerMessage(
    reviewerTexts(loadPrompt("reviewer-user.md")),
    { ...gathered, description },
    null,
  );
  return render(loadPrompt("codex-review.md").body, { system, message });
}

type CaseResult =
  | { kind: "done"; tokens: number | null }
  | { kind: "failed"; error: string; tokens: number | null }
  | { kind: "quota"; error: string; tokens: number | null };

async function reviewCase(c: Case, options: CodexReviewOptions): Promise<CaseResult> {
  const tmp = await mkdtemp(join(tmpdir(), "pr-review-codex-review-"));
  try {
    const checkout = await cloneCase(c, join(tmp, "repo"));
    const prompt = await promptOf(c, checkout);
    const outcome = await runCodex(prompt, checkout, CodexOutputSchema, "findings", {
      model: options.model,
      effort: options.effort,
    });
    if (!outcome.ok) {
      const kind = codexQuotaError(outcome.stderr) ? "quota" : "failed";
      return { kind, error: outcome.error, tokens: outcome.tokens };
    }
    const findings: Finding[] = [];
    for (const raw of outcome.output.findings) {
      const { suggested_fix: fix, ...rest } = raw;
      const parsed = FindingSchema.safeParse(fix === "" ? rest : { ...rest, suggested_fix: fix });
      if (!parsed.success) {
        return {
          kind: "failed",
          error: `a finding fails the finding schema: ${parsed.error.message}`,
          tokens: outcome.tokens,
        };
      }
      findings.push(parsed.data);
    }
    // A stop leaves no half file.
    await writeFileAtomic(
      join(options.out, `${c.name}.json`),
      `${JSON.stringify({ source: options.source, findings }, null, 2)}\n`,
    );
    return { kind: "done", tokens: outcome.tokens };
  } catch (err) {
    return { kind: "failed", error: messageOf(err), tokens: null };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// A dot file, so no case name can collide with it.
const TOKENS_FILE = ".tokens.json";

const TokenEntrySchema = z.strictObject({
  tokens: z.number().nullable(),
  model: z.string(),
  effort: z.string(),
});
type TokenEntry = z.infer<typeof TokenEntrySchema>;
const TokenMapSchema = z.record(z.string(), TokenEntrySchema);

// The token entries of the earlier runs. A missing file gives no entries. A
// file that does not parse, or fails the schema, is moved aside, never
// deleted, and the command starts a new map.
async function readTokens(out: string): Promise<Record<string, TokenEntry>> {
  const file = join(out, TOKENS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    process.stderr.write(`warning: cannot read ${file}: ${messageOf(err)}\n`);
    return {};
  }
  let problem: string;
  try {
    const parsed = TokenMapSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    problem = "it fails the schema";
  } catch {
    problem = "it does not parse";
  }
  const aside = `${file}.bad-${Date.now()}`;
  try {
    await rename(file, aside);
    process.stderr.write(
      `warning: ${file}: ${problem}. Moved it to ${aside}. Starting a new map.\n`,
    );
  } catch (err) {
    process.stderr.write(`warning: ${file}: ${problem}. Cannot move it aside: ${messageOf(err)}\n`);
  }
  return {};
}

async function writeTokens(out: string, tokens: Record<string, TokenEntry>): Promise<void> {
  const file = join(out, TOKENS_FILE);
  try {
    await writeFileAtomic(file, `${JSON.stringify(tokens, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`warning: cannot write ${file}: ${messageOf(err)}\n`);
  }
}

async function finished(out: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(out)).filter((n) => n.endsWith(".json") && !n.startsWith(".")));
  } catch {
    return new Set();
  }
}

/**
 * Run the command with its arguments. Give the exit code: 0 when every case
 * is done or skipped, 1 when a case failed or the quota is out, and 2 for a
 * usage error or a cases directory that is not valid.
 */
export async function codexReviewCommand(args: string[]): Promise<number> {
  const parsed = parseCodexReviewArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const { options } = parsed;
  let cases: Case[];
  try {
    cases = await loadCases(options.cases);
  } catch (err) {
    process.stderr.write(`${err instanceof CaseError ? err.message : messageOf(err)}\n`);
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  const have = await finished(options.out);
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let tokens = 0;
  let quotaOut = false;
  const perCase = await readTokens(options.out);
  for (const c of cases) {
    if (!options.force && have.has(`${c.name}.json`)) {
      skipped += 1;
      continue;
    }
    const result = await reviewCase(c, options);
    tokens += result.tokens ?? 0;
    process.stdout.write(`case ${c.name}: ${result.kind} tokens ${result.tokens ?? "unknown"}\n`);
    if (result.kind === "done") {
      perCase[c.name] = { tokens: result.tokens, model: options.model, effort: options.effort };
      await writeTokens(options.out, perCase);
      done += 1;
      continue;
    }
    failed += 1;
    process.stderr.write(`case ${c.name} failed: ${result.error}\n`);
    if (result.kind === "quota") {
      quotaOut = true;
      break;
    }
  }
  if (quotaOut) {
    process.stderr.write(
      "The Codex quota is out. The command stopped. Run it again later with the same --out directory to continue.\n",
    );
  }
  process.stdout.write(
    `done: ${done}\nskipped: ${skipped}\nfailed: ${failed}\ntokens: ${tokens}\n`,
  );
  return failed > 0 ? 1 : 0;
}
