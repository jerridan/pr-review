// The replay (D4c S2): verify the stored candidates of an eval again, with
// the first verifier of one arm only, and report the figures of the arm.
// A replay asks no escalation verifier and no merge, and applies no cap, so
// its posted figures compare only with other replays. "--arm stored" is the
// comparison arm: the stored first results, with no verifier call.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_OK, EXIT_STOPPED, EXIT_USAGE } from "../../cli.js";
import { withRepoGlobs } from "../../config/globs.js";
import { JUDGE_DEFAULTS } from "../../config/models.js";
import { loadRepoConfig, type RepoConfig } from "../../config/repo-config.js";
import { readHeadFile } from "../../find/evidence.js";
import { diffSections } from "../../gather/diff.js";
import { gather, type GatherResult } from "../../gather/index.js";
import { sanitizeGitHubText } from "../../github/sanitize.js";
import { isRecordFileName } from "../../record/write.js";
import { toolVersion } from "../../run.js";
import {
  effectiveThreshold,
  loadBuiltinReviewers,
  type ReviewerDefinition,
} from "../../reviewers/loader.js";
import { RecordSchema, type QueryFailure, type RunRecord } from "../../schemas/record.js";
import type { JudgeAnswer } from "../judge-cache.js";
import {
  ResultsFileSchema,
  type ReplayEntry,
  type ReplayResult,
  type ResultsFile,
  type SeverityEntry,
} from "../../schemas/replay.js";
import type { VerifierResult } from "../../schemas/verifier.js";
import type { QueryOutcome, QueryRequest, SdkClient } from "../../sdk/client.js";
import type { RunOptions } from "../../sdk/options.js";
import { createSemaphore } from "../../semaphore.js";
import {
  buildVerifierMessage,
  decideFirst,
  isQueryFailure,
  verifyConfigFor,
  type VerifyConfig,
} from "../../verify/index.js";
import { writeFileAtomic } from "../atomic.js";
import { CaseError, loadCases, type Case, type GoldenFinding } from "../case.js";
import { cloneCase } from "../checkout.js";
import {
  JUDGE_CACHE_FILE,
  readJudgeCache,
  writeJudgeCache,
  type JudgeCache,
} from "../judge-cache.js";
import { columns, ratio, usd } from "../report.js";
import { readResult } from "../run.js";
import { scoreFindings, type ScoreJudge } from "../score.js";
import { backendFor, type VerifierBackend, type VerifierSpec } from "./backend.js";
import {
  candidateId,
  checkExternal,
  drawSample,
  externalCandidates,
  fromReviewers,
  isStage1,
  noDrops,
  readExternal,
  recordCandidates,
  ReplayUsageError,
  type Candidate,
  type Dropped,
  type SampleKind,
} from "./candidates.js";
import { caseFigures, labelOf, sumFigures, type Figures, type PostedFigures } from "./figures.js";
import { loadForm, type LoadedForm, type PromptForm } from "./forms.js";
import {
  labelCase,
  labelFinding,
  specText,
  type SeverityItem,
  type SeveritySpec,
} from "./severity.js";

export type { Figures } from "./figures.js";
export type { ResultsFile } from "../../schemas/replay.js";

/** The arm of a replay: the stored first results, or one verifier with one prompt form. */
export type ReplayArm =
  { kind: "stored" } | { kind: "verifier"; verifier: VerifierSpec; form: PromptForm };

/** The flags of "pr-review replay". */
export type ReplayOptions = {
  cases: string;
  from?: string;
  repeat: number;
  candidates?: string;
  reviewers?: string[];
  arm: ReplayArm;
  severity?: SeveritySpec;
  out: string;
  resume: boolean;
  concurrency: number;
  maxCost?: number;
  sample: SampleKind;
  seed: number;
  format: "table" | "json";
  allowApiKey: boolean;
};

/** The text that the help and the report give about the comparison. */
export const REPLAY_NOTE =
  "Replay figures compare only with other replays: a replay asks the first verifier only, " +
  "with no escalation, no merge and no cap. --arm stored is the comparison arm.";

/** The report of a replay. */
export type ReplayReport = {
  note: string;
  arm: string;
  severity: string | null;
  sample: {
    kind: string;
    seed: number;
    candidates: { case: string; repeat: number | "external"; reviewer: string; key: string }[];
  };
  scopes: { source: string | null; cases: ({ case: string } & Figures)[]; total: Figures }[];
  /** The escalation figures of the stored records (E3). Only the stored arm has them. */
  escalation: {
    cases: { case: string; escalated: number; changed: number; cost_usd: number }[];
    total: { escalated: number; changed: number; cost_usd: number };
  } | null;
  /**
   * "uncached": the judge questions with no answer, because the cost limit
   * refused them. Each counts as no match, so the figures are partial.
   */
  judge: { calls: number; cost_usd: number; uncached: number };
  /**
   * "total_usd" is the spend of this invocation. "stored_usd" is the cost of
   * the stored calls of the original run (the first verifier and the
   * escalation) that the stored arm reads: it is not spend of this run.
   * Null for a verifier arm.
   */
  cost: { total_usd: number; stored_usd: number | null; tokens: number };
  /**
   * The candidates that a resume would still call: no verifier result, a
   * failed one, or no label of the current severity step.
   */
  remaining: number;
  stopped: boolean;
};

function say(message: string): void {
  process.stderr.write(`pr-review replay: ${message}\n`);
}

const armText = (arm: ReplayArm): string =>
  arm.kind === "stored"
    ? "stored"
    : `${arm.verifier.backend}:${arm.verifier.model}:${arm.verifier.effort}/${arm.form}`;

/** The spend of the invocation and the limit. */
class Spend {
  spent = 0;
  stopped = false;
  /** True when the Codex quota stopped the replay. */
  quotaOut = false;
  /** The calls that the limit refused. */
  refused = 0;
  constructor(private readonly limit: number | undefined) {}
  /** True when a new call can start. After the first false, it stays false. */
  canStart(): boolean {
    if (this.limit !== undefined && this.spent >= this.limit) this.stopped = true;
    return !this.stopped;
  }
  add(cost: number | null | undefined): void {
    this.spent += cost ?? 0;
  }
}

class Stopped extends Error {}

// The client of every call of the replay: it starts no call at the limit,
// and adds the cost of each call that ends.
function spendClient(inner: SdkClient, spend: Spend): SdkClient {
  return {
    async query<T>(req: QueryRequest, options: RunOptions): Promise<QueryOutcome<T>> {
      if (!spend.canStart()) {
        spend.refused += 1;
        throw new Stopped("the cost limit stopped the replay");
      }
      const outcome = await inner.query<T>(req, options);
      spend.add(outcome.raw?.costUsd);
      return outcome;
    },
  };
}

// The golden match of every label: each golden goes to scoreFindings as a
// posted golden. The judge does not see the label of a golden, so the
// cache keys are those of the eval.

/** The counts of the judge of a replay. */
type JudgeCounts = { calls: number; costUsd: number; uncached: number };

/**
 * Run one scoring with the judge of a case. After a stop, the judge gets no
 * client: it reads the cache only, and a question with no answer counts as
 * uncached. A question that the limit refused during the scoring adds no
 * "unknown" answer to the cache, and counts as uncached too.
 */
async function withJudge<T extends { judgeCalls: number; judgeCostUsd: number; uncached: number }>(
  state: { cache: JudgeCache; judgeModel: string },
  client: SdkClient,
  options: RunOptions,
  spend: Spend,
  counts: JudgeCounts,
  score: (judge: ScoreJudge) => Promise<T>,
): Promise<T> {
  const before = new Map<string, JudgeAnswer>(state.cache);
  const refused = spend.refused;
  const judge: ScoreJudge = {
    client: spend.stopped ? null : client,
    model: state.judgeModel,
    options,
    cache: state.cache,
    asked: new Set(),
  };
  const result = await score(judge);
  if (spend.refused > refused) {
    for (const [key, answer] of state.cache) {
      if (answer === "unknown" && before.get(key) !== "unknown") {
        if (before.has(key)) state.cache.set(key, before.get(key) as JudgeAnswer);
        else state.cache.delete(key);
      }
    }
  }
  counts.calls += result.judgeCalls - (spend.refused - refused);
  counts.costUsd += result.judgeCostUsd;
  counts.uncached += result.uncached + (spend.refused - refused);
  return result;
}

/** One case of the replay, with its clone and its inputs. */
type CaseState = {
  c: Case;
  clone: string;
  config: RepoConfig;
  defs: ReviewerDefinition[];
  gathered: GatherResult;
  sections: Map<string, string>;
  /** The description of the record, by repeat, and the description of the case. */
  descriptions: Map<number | "external", string>;
  candidates: Candidate[];
  golden: Map<string, { index: number; label: GoldenFinding["severity"] } | null>;
  dropped: Map<string, Dropped>;
  cache: JudgeCache;
  judgeModel: string;
};

// The description that the eval gives a case: its sanitized title and body.
function caseDescription(c: Case): string {
  return `${sanitizeGitHubText(c.title).text}\n\n${sanitizeGitHubText(c.body).text}`;
}

// The record of the --from repeat of a case, or null when the case has none.
async function fromRecord(
  from: string,
  c: Case,
  repeat: number,
): Promise<{ record: RunRecord; judgeModel: string; dir: string } | null> {
  const dir = join(from, c.name, String(repeat));
  if (!existsSync(dir)) return null;
  const result = await readResult(join(dir, "result.json"), repeat);
  const names = (await readdir(dir)).filter(isRecordFileName);
  const name = result?.record ?? (names.length === 1 ? names[0] : undefined);
  if (name === undefined) return null;
  const parsed = RecordSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
  if (!parsed.success) throw new ReplayUsageError(`${join(dir, name)} is not a run record`);
  // A record from before D8 names no sources, so the replay knows no
  // reviewer, and so no threshold, for its candidates.
  if (
    !isStage1(parsed.data) &&
    parsed.data.stages.verifications.some((v) => v.sources === undefined)
  ) {
    throw new ReplayUsageError(
      `${join(dir, name)}: a verification has no sources (a record from before D8), so the replay cannot know its reviewer`,
    );
  }
  return {
    record: parsed.data,
    judgeModel: result?.options.judge_model ?? JUDGE_DEFAULTS.model,
    dir,
  };
}

// The entries of earlier runs that this run can reuse: same arm and tool version.
async function readEntries(
  path: string,
  arm: string,
  version: string,
): Promise<Map<string, ReplayEntry>> {
  const out = new Map<string, ReplayEntry>();
  if (!existsSync(path)) return out;
  const parsed = ResultsFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success || parsed.data.arm !== arm || parsed.data.tool_version !== version)
    return out;
  for (const e of parsed.data.entries) out.set(entryKey(e), e);
  return out;
}

// The identity of a candidate in a case: its repeat, its reviewer and its
// key, so two reviewers with the same file, span and claim stay two.
const entryKey = (c: Pick<Candidate, "repeat" | "reviewer" | "key">): string =>
  JSON.stringify([c.repeat, c.reviewer, c.key]);

// The threshold of a candidate: of its reviewer, from the repo config at
// the case base, as in the run. An external source gets thresholds.default.
function verifyConfigOf(state: CaseState, c: Candidate): VerifyConfig {
  const def =
    c.repeat === "external" ? undefined : state.defs.find((d) => d.frontmatter.name === c.reviewer);
  const threshold = def ? effectiveThreshold(def, state.config) : state.config.thresholds.default;
  return verifyConfigFor(threshold, state.config);
}

// The first-result decision of an entry, with the label of the severity
// step in place of the verifier label when the step ran.
function decide(
  state: CaseState,
  c: Candidate,
  entry: ReplayEntry,
): Pick<ReplayEntry, "decision" | "in_band"> {
  const head = readHeadFile(state.clone, c.finding.file);
  const config = verifyConfigOf(state, c);
  if (isQueryFailure(entry.result)) {
    const d = decideFirst(entry.result, c.finding, head, config);
    return {
      decision: { passed: d.passed, ...(d.unsure ? { unsure: d.unsure } : {}) },
      in_band: false,
    };
  }
  const label = labelOf(entry);
  const r = entry.result;
  const asResult = (severity: VerifierResult["severity"]): VerifierResult => ({
    in_scope: r.in_scope,
    claim_holds: r.claim_holds,
    introduced_by_pr: r.introduced_by_pr,
    quotes: r.quotes,
    rationale: r.rationale,
    score: r.score,
    severity,
  });
  const d = decideFirst(asResult(label ?? "nit"), c.finding, head, config);
  if (label === null) return { decision: null, in_band: d.escalates };
  return {
    decision: {
      passed: d.passed,
      ...(d.rejected !== undefined ? { rejected: d.rejected } : {}),
      ...(d.unsure !== undefined ? { unsure: d.unsure } : {}),
    },
    in_band: d.escalates,
  };
}

/**
 * Run the replay and give its exit code: 0 when it ends, 2 for a usage
 * error found before any call, 4 when --max-cost stopped it.
 */
export async function runReplay(
  opts: ReplayOptions,
  clientOf: () => Promise<SdkClient>,
): Promise<number> {
  try {
    return await replay(opts, clientOf);
  } catch (err) {
    if (err instanceof ReplayUsageError || err instanceof CaseError) {
      say(err.message);
      return EXIT_USAGE;
    }
    throw err;
  }
}

async function replay(opts: ReplayOptions, clientOf: () => Promise<SdkClient>): Promise<number> {
  if (opts.from === undefined && opts.candidates === undefined) {
    throw new ReplayUsageError("give --from, --candidates or both");
  }
  if (opts.arm.kind === "stored" && (opts.from === undefined || opts.candidates !== undefined)) {
    throw new ReplayUsageError(
      "--arm stored needs --from and takes no --candidates: an external candidate has no stored result",
    );
  }
  const version = toolVersion();
  const arm = armText(opts.arm);
  const options: RunOptions = { allowApiKey: opts.allowApiKey, env: process.env };
  const spend = new Spend(opts.maxCost);
  let inner: SdkClient | null = null;
  const lazy: SdkClient = {
    async query<T>(req: QueryRequest, o: RunOptions): Promise<QueryOutcome<T>> {
      inner ??= await clientOf();
      return inner.query<T>(req, o);
    },
  };
  const client = spendClient(lazy, spend);
  let backend: VerifierBackend | null = null;
  let form: LoadedForm | null = null;
  if (opts.arm.kind === "verifier") {
    backend = backendFor(opts.arm.verifier, () => client, options);
    if (backend.unavailable !== null) throw new ReplayUsageError(backend.unavailable);
    form = loadForm(opts.arm.form);
  }

  const cases = await loadCases(opts.cases);
  const out = resolve(opts.out);
  const armPath = join(out, "arm.json");
  if (opts.resume && existsSync(armPath)) {
    const stored = JSON.parse(await readFile(armPath, "utf8")) as { arm?: string };
    if (stored.arm !== arm) {
      throw new ReplayUsageError(
        `${out} holds the arm ${String(stored.arm)}, and this run is the arm ${arm}. One --out directory holds one arm.`,
      );
    }
  }

  // Read every input before any call: the records, and the external files.
  const inputs: {
    c: Case;
    from: Awaited<ReturnType<typeof fromRecord>>;
    external: Awaited<ReturnType<typeof readExternal>>;
  }[] = [];
  for (const c of cases) {
    const from = opts.from === undefined ? null : await fromRecord(opts.from, c, opts.repeat);
    if (from && opts.arm.kind === "stored" && isStage1(from.record)) {
      throw new ReplayUsageError(
        `case ${c.name}: the record of repeat ${opts.repeat} is a stage 1 record, with no verifier result, so --arm stored cannot use it`,
      );
    }
    const external =
      opts.candidates === undefined ? null : await readExternal(opts.candidates, c.name);
    inputs.push({ c, from, external });
  }
  await mkdir(out, { recursive: true });
  await writeFileAtomic(armPath, `${JSON.stringify({ arm, tool_version: version }, null, 2)}\n`);

  const tmp = await mkdtemp(join(tmpdir(), "pr-review-replay-"));
  const counts: JudgeCounts = { calls: 0, costUsd: 0, uncached: 0 };
  try {
    const states: CaseState[] = [];
    const only = opts.reviewers ? new Set(opts.reviewers) : null;
    for (const { c, from, external } of inputs) {
      if (from === null && external === null) continue;
      const clone = await cloneCase(c, join(tmp, c.name));
      const loaded = await loadRepoConfig(clone, c.base);
      const gathered = await gather(clone, c.base, c.head, {
        ...withRepoGlobs(loaded.config),
        history: false,
        fileHistory: true,
      });
      const sections = diffSections(gathered.diff);
      const descriptions = new Map<number | "external", string>();
      let candidates: Candidate[] = [];
      const dropped = new Map<string, Dropped>();
      if (from) {
        descriptions.set(opts.repeat, from.record.identity.description);
        candidates.push(...recordCandidates(from.record, c.name, opts.repeat));
      }
      if (external) {
        descriptions.set("external", caseDescription(c));
        const checked = checkExternal(external.findings, clone, sections);
        dropped.set(external.source, checked.dropped);
        candidates.push(...externalCandidates(c.name, external.source, checked.kept));
      }
      if (only) candidates = candidates.filter((cand) => fromReviewers(cand, only));
      // The cache of the --from repeat, with the answers of an earlier
      // replay into this --out directory.
      const cache: JudgeCache = from
        ? await readJudgeCache(join(from.dir, JUDGE_CACHE_FILE))
        : new Map();
      const outCache = join(out, c.name, JUDGE_CACHE_FILE);
      if (existsSync(outCache))
        for (const [k, v] of await readJudgeCache(outCache)) cache.set(k, v);
      states.push({
        c,
        clone,
        config: loaded.config,
        defs: [...loadBuiltinReviewers(), ...loaded.customReviewers],
        gathered,
        sections,
        descriptions,
        candidates,
        golden: new Map(),
        dropped,
        cache,
        judgeModel: from?.judgeModel ?? JUDGE_DEFAULTS.model,
      });
    }

    // The golden match of every candidate, before any verifier call. The
    // candidates of one record, and the external ones, match apart.
    for (const state of states) {
      for (const group of [...new Set(state.candidates.map((c) => c.repeat))]) {
        const members = state.candidates.filter((c) => c.repeat === group);
        let matches: (number | null)[] = [];
        await withJudge(state, client, options, spend, counts, async (judge) => {
          const all = state.c.golden.map((g) => ({ ...g, severity: "blocking" as const }));
          const s = await scoreFindings(
            members.map((c) => c.finding),
            all,
            state.clone,
            judge,
          );
          matches = members.map(() => null);
          for (const m of s.matched) matches[m.posted] = m.golden;
          return s;
        });
        members.forEach((cand, i) => {
          const index = matches[i] ?? null;
          const g = index === null ? undefined : state.c.golden[index];
          state.golden.set(
            entryKey(cand),
            index === null || !g ? null : { index, label: g.severity },
          );
        });
      }
      await writeJudgeCache(join(out, state.c.name, JUDGE_CACHE_FILE), state.cache);
    }

    // The sample, over all cases at once.
    const all = states.flatMap((s) => s.candidates);
    const matched = (cand: Candidate): boolean =>
      (states.find((s) => s.c.name === cand.case)?.golden.get(entryKey(cand)) ?? null) !== null;
    const chosen = drawSample(all, opts.sample, opts.seed, matched);
    const chosenIds = new Set(chosen.map(candidateId));
    for (const state of states)
      state.candidates = state.candidates.filter((c) => chosenIds.has(candidateId(c)));

    // The entries of each case. An entry gets its decision when it is made,
    // and again when the severity step changes its label.
    const entries = new Map<string, Map<string, ReplayEntry>>();
    const writes = new Map<string, Promise<void>>();
    const writeCase = (state: CaseState): Promise<void> => {
      const done = entries.get(state.c.name) ?? new Map<string, ReplayEntry>();
      const file: ResultsFile = {
        version: 1,
        tool_version: version,
        arm,
        case: state.c.name,
        entries: state.candidates.flatMap((c) => {
          const e = done.get(entryKey(c));
          return e ? [e] : [];
        }),
      };
      const path = join(out, state.c.name, "results.json");
      const next = (writes.get(state.c.name) ?? Promise.resolve()).then(async () => {
        await mkdir(join(out, state.c.name), { recursive: true });
        await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
      });
      writes.set(state.c.name, next);
      return next;
    };
    // Make an entry from its parts, with its decision.
    const make = (
      state: CaseState,
      c: Candidate,
      parts: Pick<ReplayEntry, "result" | "call" | "severity">,
    ): ReplayEntry => {
      const entry: ReplayEntry = {
        repeat: c.repeat,
        key: c.key,
        finding: c.finding,
        sources: c.sources,
        reviewer: c.reviewer,
        golden: state.golden.get(entryKey(c)) ?? null,
        result: parts.result,
        call: parts.call,
        ...(parts.severity ? { severity: parts.severity } : {}),
        decision: null,
        in_band: false,
      };
      return { ...entry, ...decide(state, c, entry) };
    };

    const spec = opts.severity;
    const text = spec ? specText(spec) : null;
    // A label of the current step that a resume keeps: same spec, a label,
    // and no failure.
    const labeled = (e: ReplayEntry): boolean =>
      text !== null &&
      e.severity?.spec === text &&
      e.severity.label !== null &&
      e.severity.failure === undefined;
    const holds = (e: ReplayEntry | undefined): e is ReplayEntry & { result: ReplayResult } =>
      e !== undefined && !isQueryFailure(e.result) && e.result.claim_holds && e.result.in_scope;

    const semaphore = createSemaphore(opts.concurrency);
    const tasks: Promise<void>[] = [];
    for (const state of states) {
      const done = new Map<string, ReplayEntry>();
      entries.set(state.c.name, done);
      const earlier = opts.resume
        ? await readEntries(join(out, state.c.name, "results.json"), arm, version)
        : new Map<string, ReplayEntry>();
      for (const c of state.candidates) {
        const old = earlier.get(entryKey(c));
        // A resume keeps a verifier result that did not fail, and a label of
        // the step that did not fail. It runs every other call again, as
        // eval --resume runs a failed repeat again.
        if (old && (opts.arm.kind === "stored" || !isQueryFailure(old.result))) {
          done.set(
            entryKey(c),
            make(state, c, {
              result: old.result,
              call: old.call,
              ...(old.severity && labeled(old) ? { severity: old.severity } : {}),
            }),
          );
          continue;
        }
        if (opts.arm.kind === "stored") {
          const stored = c.stored;
          if (!stored) continue;
          done.set(entryKey(c), make(state, c, { result: { ...stored.first }, call: stored.call }));
          continue;
        }
        const b = backend as VerifierBackend;
        const f = form as LoadedForm;
        tasks.push(
          semaphore(async () => {
            if (!spend.canStart()) return;
            const userMessage = buildVerifierMessage(
              f.prompt.texts,
              c.finding,
              readHeadFile(state.clone, c.finding.file),
              state.sections.get(c.finding.file) ?? "",
              state.descriptions.get(c.repeat) ?? "",
              state.gathered.fileHistory?.[c.finding.file],
            );
            const outcome = await b.verify({
              system: f.prompt.system,
              userMessage,
              cwd: state.clone,
              schema: f.schema,
            });
            if (outcome.quota) {
              // Keep no result for this candidate, so a rerun calls it again.
              spend.quotaOut = true;
              spend.stopped = true;
              return;
            }
            let result: ReplayResult | QueryFailure;
            if (outcome.failure !== null) result = outcome.failure;
            else {
              const r = f.normalize(outcome.output);
              result =
                Number.isInteger(r.score) && r.score >= 0 && r.score <= 100
                  ? r
                  : { kind: "out-of-range", message: `The score ${r.score} is not from 0 to 100.` };
            }
            done.set(entryKey(c), make(state, c, { result, call: outcome.call }));
            await writeCase(state);
          }),
        );
      }
    }
    await Promise.all(tasks);

    // The severity step, on the results that hold and are in scope.
    if (spec) {
      const severityTasks: Promise<void>[] = [];
      for (const state of states) {
        const done = entries.get(state.c.name) ?? new Map<string, ReplayEntry>();
        const held = state.candidates
          .map((c) => ({ c, e: done.get(entryKey(c)) }))
          .filter((x): x is { c: Candidate; e: ReplayEntry & { result: ReplayResult } } =>
            holds(x.e),
          );
        const description = (c: Candidate) => state.descriptions.get(c.repeat) ?? "";
        const set = (c: Candidate, s: SeverityEntry) => {
          const e = done.get(entryKey(c));
          if (e)
            done.set(entryKey(c), make(state, c, { result: e.result, call: e.call, severity: s }));
        };
        if (spec.mode === "finding") {
          for (const { c, e } of held) {
            if (labeled(e)) continue;
            severityTasks.push(
              semaphore(async () => {
                if (!spend.canStart()) return;
                const item: SeverityItem = { finding: c.finding, quotes: e.result.quotes };
                set(
                  c,
                  await labelFinding(client, options, spec, item, description(c), state.clone),
                );
                await writeCase(state);
              }),
            );
          }
        } else if (held.length > 0 && !held.every(({ e }) => labeled(e))) {
          // By design, a pr-mode call asks for the whole case when one label
          // is missing.
          severityTasks.push(
            semaphore(async () => {
              if (!spend.canStart()) return;
              const items = held.map(({ c, e }) => ({
                finding: c.finding,
                quotes: e.result.quotes,
              }));
              const first = held[0];
              const labels = await labelCase(
                client,
                options,
                spec,
                items,
                first ? description(first.c) : "",
                state.clone,
              );
              held.forEach(({ c }, i) => {
                const s = labels[i];
                if (s) set(c, s);
              });
              await writeCase(state);
            }),
          );
        }
      }
      await Promise.all(severityTasks);
    }

    // The results files.
    for (const state of states) await writeCase(state);
    await Promise.all(writes.values());

    // The remaining candidates: each entry that a resume would still call.
    let remaining = 0;
    for (const state of states) {
      const done = entries.get(state.c.name) ?? new Map<string, ReplayEntry>();
      for (const c of state.candidates) {
        const e = done.get(entryKey(c));
        const verifier =
          e === undefined || (opts.arm.kind === "verifier" && isQueryFailure(e.result));
        const severity = spec !== undefined && holds(e) && !labeled(e);
        if (verifier || severity) remaining += 1;
      }
    }

    // The figures: posted (scoreFindings), and the others from the entries.
    const hasLabels = !(
      opts.arm.kind === "verifier" &&
      opts.arm.form === "truth" &&
      !opts.severity
    );
    const sources = [
      ...new Set(
        states.flatMap((s) =>
          s.candidates.flatMap((c) => [c.reviewer, ...c.sources.map((x) => x.reviewer)]),
        ),
      ),
    ]
      .filter((name) => name !== "")
      .sort();
    const scopes: ReplayReport["scopes"] = [];
    for (const source of [null, ...sources]) {
      const rows: ({ case: string } & Figures)[] = [];
      for (const state of states) {
        const done = entries.get(state.c.name) ?? new Map<string, ReplayEntry>();
        const list = state.candidates
          .filter(
            (c) =>
              source === null ||
              c.reviewer === source ||
              c.sources.some((s) => s.reviewer === source),
          )
          .flatMap((c) => {
            const e = done.get(entryKey(c));
            return e ? [e] : [];
          });
        let posted: PostedFigures | null = null;
        if (hasLabels) {
          const passed = list.filter((e) => e.decision?.passed === true);
          const s = await withJudge(state, client, options, spend, counts, (judge) =>
            scoreFindings(
              passed.map((e) => e.finding),
              state.c.golden,
              state.clone,
              judge,
            ),
          );
          const byLabel = { blocking: 0, suggestion: 0, nit: 0 };
          for (const m of s.matched) {
            const label = state.c.golden[m.golden]?.severity;
            if (label === "blocking" || label === "suggestion" || label === "nit")
              byLabel[label] += 1;
          }
          posted = {
            posted: passed.length,
            goldens: s.matched.length,
            by_label: byLabel,
            false_posted: passed.length - s.matched.length,
            recall: s.postedGoldenCount === 0 ? null : s.matched.length / s.postedGoldenCount,
            precision: passed.length === 0 ? null : s.matched.length / passed.length,
          };
        }
        const dropped = noDrops();
        for (const [name, d] of state.dropped) {
          if (source !== null && name !== source) continue;
          dropped["out-of-range"] += d["out-of-range"];
          dropped["bad-quote"] += d["bad-quote"];
        }
        rows.push({
          case: state.c.name,
          ...caseFigures(list, state.c.golden, posted, hasLabels, dropped),
        });
      }
      scopes.push({ source, cases: rows, total: sumFigures(rows) });
    }
    for (const state of states) {
      await writeJudgeCache(join(out, state.c.name, JUDGE_CACHE_FILE), state.cache);
    }

    // The escalation figures of the stored records (E3), with no model call,
    // and the cost of the stored calls that the stored arm reads.
    let escalation: ReplayReport["escalation"] = null;
    let storedUsd: number | null = null;
    if (opts.arm.kind === "stored") {
      storedUsd = 0;
      const caseRows = states.map((state) => {
        let escalated = 0;
        let changed = 0;
        let cost = 0;
        for (const c of state.candidates) {
          storedUsd =
            (storedUsd ?? 0) + (c.stored?.call?.cost_usd ?? 0) + (c.stored?.escalationCostUsd ?? 0);
          if (!c.stored?.escalated) continue;
          escalated += 1;
          cost += c.stored.escalationCostUsd;
          const first = decideFirst(
            c.stored.first,
            c.finding,
            readHeadFile(state.clone, c.finding.file),
            verifyConfigOf(state, c),
          );
          if (first.passed !== c.stored.passed) changed += 1;
        }
        return { case: state.c.name, escalated, changed, cost_usd: cost };
      });
      escalation = {
        cases: caseRows,
        total: {
          escalated: caseRows.reduce((t, r) => t + r.escalated, 0),
          changed: caseRows.reduce((t, r) => t + r.changed, 0),
          cost_usd: caseRows.reduce((t, r) => t + r.cost_usd, 0),
        },
      };
    }

    const totalAll = scopes[0]?.total;
    const report: ReplayReport = {
      note: REPLAY_NOTE,
      arm,
      severity: opts.severity ? specText(opts.severity) : null,
      sample: {
        kind: typeof opts.sample === "number" ? String(opts.sample) : opts.sample,
        seed: opts.seed,
        candidates: chosen.map((c) => ({
          case: c.case,
          repeat: c.repeat,
          reviewer: c.reviewer,
          key: c.key,
        })),
      },
      scopes,
      escalation,
      judge: { calls: counts.calls, cost_usd: counts.costUsd, uncached: counts.uncached },
      cost: { total_usd: spend.spent, stored_usd: storedUsd, tokens: totalAll?.tokens ?? 0 },
      remaining,
      stopped: spend.stopped,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    await writeFileAtomic(join(out, "report.json"), json);
    process.stdout.write(opts.format === "json" ? json : renderReplay(report));
    if (counts.uncached > 0) {
      say(
        `the posted figures are partial: ${counts.uncached} judge ${counts.uncached === 1 ? "question has" : "questions have"} no answer, ` +
          "and each counts as no match. Run again with --resume to ask them.",
      );
    }
    if (spend.quotaOut) {
      say(
        `the Codex quota is out, so the replay stopped. ${remaining} ${remaining === 1 ? "candidate remains" : "candidates remain"}. ` +
          "Run again with --resume to continue.",
      );
      return EXIT_STOPPED;
    }
    if (spend.stopped) {
      say(
        `the cost limit stopped the replay: the calls of this run cost $${spend.spent.toFixed(4)}, ` +
          `and the limit is $${(opts.maxCost ?? 0).toFixed(4)}. ` +
          `${remaining} ${remaining === 1 ? "candidate remains" : "candidates remain"}. ` +
          "Run again with --resume to continue.",
      );
      return EXIT_STOPPED;
    }
    return EXIT_OK;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const share = (value: number | null): string => ratio(value);

/** Render the report as text: the note, then one table for each scope. */
export function renderReplay(report: ReplayReport): string {
  const lines = [
    report.note,
    `Arm: ${report.arm}. Severity step: ${report.severity ?? "none"}. Sample: ${report.sample.kind}, seed ${report.sample.seed}, ${report.sample.candidates.length} candidates.`,
    "",
  ];
  for (const scope of report.scopes) {
    lines.push(`Source: ${scope.source ?? "all sources"}`);
    const rows = [
      [
        "case",
        "candidates",
        "goldens before",
        "posted",
        "recall",
        "precision",
        "real held",
        "false rejected",
        "severity agreement",
        "in band",
        "unsure",
        "failed",
        "cost",
      ],
    ];
    for (const f of [...scope.cases, { case: "total", ...scope.total }]) {
      rows.push([
        f.case,
        String(f.candidates),
        String(f.before.goldens),
        f.posted === null ? "-" : String(f.posted.posted),
        f.posted === null ? "-" : share(f.posted.recall),
        f.posted === null ? "-" : share(f.posted.precision),
        share(f.truth.real.share),
        share(f.truth.false.share),
        f.severity === null ? "-" : share(f.severity.agreement),
        String(f.in_band),
        String(f.unsure),
        String(f.failed),
        usd(f.cost_usd + f.severity_cost_usd),
      ]);
    }
    lines.push(...columns(rows), "");
  }
  if (report.escalation) {
    const t = report.escalation.total;
    lines.push(
      `Escalation of the stored records: ${t.escalated} escalated, ${t.changed} changed the decision, ${usd(t.cost_usd)}.`,
    );
  }
  lines.push(
    `Judge: ${report.judge.calls} calls, ${usd(report.judge.cost_usd)}. Total cost: ${usd(report.cost.total_usd)}. Tokens: ${report.cost.tokens}.`,
  );
  if (report.remaining > 0) lines.push(`Remaining candidates: ${report.remaining}.`);
  return `${lines.join("\n")}\n`;
}
