// The whole review pipeline for one run: gather, tier and triage, select,
// find with verification per finding, merge, verdict, and the record.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withRepoGlobs } from "./config/globs.js";
import { ROLE_DEFAULTS, ROLES, resolveModel, type Effort, type Role } from "./config/models.js";
import {
  loadRepoConfig,
  type ConfigRole,
  type RepoConfig,
  type Suppression,
} from "./config/repo-config.js";
import { readHeadFile } from "./find/evidence.js";
import { injectedRuleFiles, runReviewers, type ReviewerRun } from "./find/index.js";
import { diffSections } from "./gather/diff.js";
import { gather, resolveCommit, type GatherResult } from "./gather/index.js";
import type { GitHubClient } from "./github/client.js";
import type { RunMarker } from "./github/markers.js";
import { loadPrContext, prDescription, type PrContext } from "./github/metadata.js";
import { postFailure, postRun, skipReviewAlreadyPosted } from "./github/post.js";
import { sanitizeGitHubText } from "./github/sanitize.js";
import { withHeadWorktree } from "./gather/worktree.js";
import { mergeFindings, toPostedFinding } from "./merge/index.js";
import { applySuppressions } from "./merge/suppress.js";
import { recordFileName, recordRunId, writeRecord } from "./record/write.js";
import {
  effectiveModel,
  effectiveThreshold,
  loadBuiltinReviewers,
  reviewerTools,
  type ReviewerDefinition,
} from "./reviewers/loader.js";
import { selectReviewers, skipSelected } from "./reviewers/select.js";
import type { Finding } from "./schemas/finding.js";
import type {
  PostedFinding,
  PostedGitHub,
  QueryFailure,
  RunRecord,
  SkippedReviewer,
} from "./schemas/record.js";
import type { TriageBrief } from "./schemas/triage.js";
import type { VerifierResult } from "./schemas/verifier.js";
import { usageTokens, type QueryOutcome, type QueryRequest, type SdkClient } from "./sdk/client.js";
import type { RunOptions } from "./sdk/options.js";
import { createSemaphore } from "./semaphore.js";
import { runTriage } from "./triage/index.js";
import {
  decideTier,
  preTier,
  shouldRunTriage,
  type PreTierInput,
  type Tier,
} from "./triage/tier.js";
import { coverage, decideVerdict, verificationCounts } from "./verdict.js";
import {
  loadVerifierPrompt,
  verifyConfigFor,
  verifyFinding,
  type Verification,
  type VerifierPrompt,
} from "./verify/index.js";

export interface RunInput {
  repo: string;
  /** The base commit. With "pr", it defaults to the base sha of the pull request. */
  base?: string;
  /** The head commit. With "pr", it defaults to the head sha of the pull request. */
  head?: string;
  /** The pull request number. The run reads the pull request through "github". */
  pr?: number;
  /** The owner/repo of the pull request. It replaces the slug of the checkout. */
  githubRepo?: string;
  /**
   * The GitHub client. Absent means the real gh client, which loads only
   * when "pr" is set.
   */
  github?: GitHubClient;
  /** The output format. "github" needs "pr". */
  format: "json" | "table" | "github";
  tierOverride?: Tier;
  outDir: string;
  allowApiKey: boolean;
  /**
   * True when the PR author has write access. With "trusted: true", a
   * custom reviewer then gets Bash. Absent means false. With "pr", the
   * permission of the author can also give write access, and a fork never
   * gets it.
   */
  authorWriteAccess?: boolean;
  client?: SdkClient;
  now?: () => Date;
}

/**
 * The default bound on SDK queries at once. Each query is its own process.
 * The repo config key "concurrency" replaces it.
 */
export const DEFAULT_CONCURRENCY = 5;

type CostEntry = RunRecord["cost"]["queries"][number];
type VerificationEntry = RunRecord["stages"]["verifications"][number];

function toolVersion(): string {
  // This file is at src/run.ts and at dist/run.js; package.json is one level up.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

function isConfigRole(role: Role): role is ConfigRole {
  return role !== "smoke";
}

/** The model, as a pinned ID, and the effort of each role, after the repo config. */
export function roleModels(config: RepoConfig): Record<Role, { model: string; effort: Effort }> {
  const models = {} as Record<Role, { model: string; effort: Effort }>;
  for (const role of ROLES) {
    const set = isConfigRole(role) ? config.models[role] : undefined;
    models[role] = {
      model: resolveModel(set?.model ?? ROLE_DEFAULTS[role].model),
      effort: set?.effort ?? ROLE_DEFAULTS[role].effort,
    };
  }
  return models;
}

/**
 * The record entry of each selected reviewer, with the model and effort
 * that its queries use after the repo config and the frontmatter, and the
 * tools of its frontmatter that the run did not grant.
 */
export function describeSelected(
  selected: { def: ReviewerDefinition; trigger: string }[],
  config: RepoConfig,
  authorWriteAccess = false,
): RunRecord["identity"]["selected_reviewers"] {
  return selected.map((s) => ({
    name: s.def.frontmatter.name,
    trigger: s.trigger,
    ...effectiveModel(s.def, config),
    tools_ignored: reviewerTools(s.def, authorWriteAccess).ignored,
  }));
}

// The roles whose model and effort the recording client sets from the
// repo config. The reviewer role is not here: find sends the overrides of
// each reviewer itself.
const CLIENT_OVERRIDE_ROLES: ReadonlySet<Role> = new Set<Role>([
  "triage",
  "verifier",
  "verifier-escalation",
  "merge",
]);

// Add the repo config's model and effort for the role of the request.
// An override that the request sets itself wins.
function withRoleOverrides(req: QueryRequest, config: RepoConfig): QueryRequest {
  if (!CLIENT_OVERRIDE_ROLES.has(req.role) || !isConfigRole(req.role)) return req;
  const set = config.models[req.role];
  if (!set || (set.model === undefined && set.effort === undefined)) return req;
  return {
    ...req,
    overrides: {
      ...(set.model !== undefined ? { model: resolveModel(set.model) } : {}),
      ...(set.effort !== undefined ? { effort: set.effort } : {}),
      ...req.overrides,
    },
  };
}

// Wrap the client so that each query gives one cost entry, also a query
// that fails or throws. The wrapper also applies the role overrides of
// the repo config.
// The tokens of every finished query of the run, for the token ceiling.
type TokenCounter = { tokens: number };

function recordingClient(
  inner: SdkClient,
  entries: CostEntry[],
  config: RepoConfig,
  counter: TokenCounter,
): SdkClient {
  return {
    async query<T>(original: QueryRequest, options: RunOptions): Promise<QueryOutcome<T>> {
      const req = withRoleOverrides(original, config);
      const start = performance.now();
      let outcome: QueryOutcome<T> | null = null;
      try {
        outcome = await inner.query<T>(req, options);
        return outcome;
      } finally {
        const raw = outcome?.raw ?? null;
        const subtype = raw?.subtype ?? (outcome && !outcome.ok ? outcome.failure.kind : "thrown");
        // The count goes up before the query's promise resolves, so before
        // its semaphore slot is free for the next query.
        counter.tokens += usageTokens(raw?.usage);
        entries.push({
          role: req.role,
          ...(req.reviewerName !== undefined ? { reviewer: req.reviewerName } : {}),
          model: raw?.model ?? resolveModel(req.overrides?.model ?? ROLE_DEFAULTS[req.role].model),
          duration_ms: raw?.durationMs ?? Math.round(performance.now() - start),
          stop_reason: raw?.stopReason ?? null,
          subtype,
          usage: raw?.usage ?? null,
          cost_usd: raw?.costUsd ?? null,
        });
      }
    },
  };
}

// The sensitive paths with no text hunk, such as a mode flip or a binary.
// They stay in sensitive_files, and the tier does not change for them.
function sensitiveWithoutHunks(gathered: GatherResult): string[] {
  const hunks = new Map(gathered.changedFiles.map((f) => [f.path, f.hunks]));
  return gathered.sensitive.filter((path) => (hunks.get(path) ?? 0) === 0);
}

// Wait for every promise, also when one rejects, then throw the first error.
async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeFailure(failure: QueryFailure): string {
  return `${failure.kind}: ${failure.message}`;
}

function isFailure(value: VerifierResult | QueryFailure | undefined): value is QueryFailure {
  return value !== undefined && "kind" in value;
}

function collectErrors(
  triageFailure: QueryFailure | null,
  runs: ReviewerRun[],
  verifications: VerificationEntry[],
  merges: RunRecord["stages"]["merges"],
): RunRecord["cost"]["errors"] {
  const errors: RunRecord["cost"]["errors"] = [];
  if (triageFailure) errors.push({ stage: "triage", message: describeFailure(triageFailure) });
  for (const run of runs) {
    if (run.failure) {
      errors.push({
        stage: "find",
        message: `${run.name} pass ${run.pass}: ${describeFailure(run.failure)}`,
      });
    }
  }
  for (const v of verifications) {
    const where = `${v.finding.file}:${v.finding.start_line}`;
    if (isFailure(v.first)) {
      errors.push({ stage: "verify", message: `${where} verifier: ${describeFailure(v.first)}` });
    }
    if (isFailure(v.escalated)) {
      errors.push({
        stage: "verify",
        message: `${where} escalation: ${describeFailure(v.escalated)}`,
      });
    }
    // Code failed a result that the verifier passed, so show it, as a
    // rejected merge is shown.
    if (v.rejected) errors.push({ stage: "verify", message: `${where} rejected: ${v.rejected}` });
  }
  for (const merge of merges) {
    if ("kind" in merge.result) {
      errors.push({
        stage: "merge",
        message: `group ${merge.group.join(",")}: ${describeFailure(merge.result)}`,
      });
    } else if (merge.rejected) {
      errors.push({
        stage: "merge",
        message: `group ${merge.group.join(",")} rejected: ${merge.rejected}`,
      });
    }
  }
  return errors;
}

// The sum of the known costs. A query with no cost is not in the sum, so
// the record also holds the count of those queries.
function totalCost(entries: CostEntry[]): number | null {
  const known = entries.map((e) => e.cost_usd).filter((c): c is number => c !== null);
  if (entries.length > 0 && known.length === 0) return null;
  return known.reduce((sum, c) => sum + c, 0);
}

/** The result of a run that wrote its record. */
export type RunResult = {
  record: RunRecord;
  recordPath: string;
  /** The url of the review that the run posted, or null. */
  reviewUrl: string | null;
  /**
   * 1 when the review that --format github asked for did not post: both
   * create-review calls failed, or the run failed and posted a failure
   * review (R5a). Else 0.
   */
  exitCode: 0 | 1;
  /** Why the exit code is 1, or null. */
  error: string | null;
};

/**
 * Run one review and write its record. With --format github, post the
 * review, the check run and the cleanup comment before the record is
 * written. Throw when the run cannot write a record.
 */
export async function runReview(input: RunInput): Promise<RunResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const repo = resolve(input.repo);
  const stageMs: Record<string, number> = {};
  // The stage that runs now, and the tier once it is decided. A failure
  // review (R5a) names them. They are objects, because closures set them.
  const progress: { stage: string; tier: Tier | null } = { stage: "config", tier: null };
  const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    progress.stage = stage;
    const start = performance.now();
    try {
      return await fn();
    } finally {
      stageMs[stage] = Math.round(performance.now() - start);
    }
  };

  if (input.format === "github" && input.pr === undefined) {
    throw new Error("--format github needs --pr.");
  }
  // With a pull request, the run reads it first, because the base and the
  // head default to its shas. The real gh client loads only when no fake
  // is given.
  let prContext: PrContext | null = null;
  let github: GitHubClient | null = null;
  if (input.pr !== undefined) {
    github = input.github ?? (await import("./github/gh.js")).createGhClient();
    prContext = await loadPrContext(github, {
      repo,
      number: input.pr,
      ...(input.githubRepo !== undefined ? { githubRepo: input.githubRepo } : {}),
      authorWriteAccessFlag: input.authorWriteAccess === true,
    });
  }
  const baseRev = input.base ?? prContext?.pr.base_sha;
  const headRev = input.head ?? prContext?.pr.head_sha;
  if (baseRev === undefined || headRev === undefined) {
    throw new Error("Give --base and --head, or give --pr.");
  }

  // With --format github, the run posts to the pull request.
  const post = input.format === "github" && prContext && github ? { ctx: prContext, github } : null;
  // Post the failure review of R5a. Its own error does not hide the error
  // of the run, so the caller gets it as text.
  const postFailureReview = async (
    marker: Omit<RunMarker, "status">,
    message: string,
  ): Promise<string | null> => {
    if (!post) return null;
    try {
      await postFailure(post.github, {
        ctx: post.ctx,
        marker: { ...marker, status: "failed" },
        stage: progress.stage,
        message,
      });
      return null;
    } catch (err) {
      return messageOf(err);
    }
  };
  // The failure of a stage after the tier, for a run that posts. The run
  // then writes a record, posts a failure review and exits with code 1.
  const failed: { value: { stage: string; message: string } | null } = { value: null };
  let diff: string;
  let record: RunRecord;
  try {
    // The config loads from the base commit before any model call and
    // before gather, because its globs change the exclusions. A config that
    // does not validate throws here, so the run writes no record.
    const baseSha = await resolveCommit(repo, baseRev);
    const loaded = await timed("config", () => loadRepoConfig(repo, baseSha));
    const config = loaded.config;

    const inner = input.client ?? (await import("./sdk/client.js")).createSdkClient();
    const queries: CostEntry[] = [];
    const counter: TokenCounter = { tokens: 0 };
    const client = recordingClient(inner, queries, config, counter);
    const authorWriteAccess = prContext
      ? prContext.authorWriteAccess
      : input.authorWriteAccess === true;
    // The PR text goes through the sanitizer before any rule or prompt
    // reads it.
    const prTitle = prContext ? sanitizeGitHubText(prContext.pr.title).text : "";
    const tierInput: PreTierInput = {
      ...(input.tierOverride ? { override: input.tierOverride } : {}),
      labels: prContext?.pr.labels ?? [],
      pr: prContext
        ? { draft: prContext.pr.draft, title: prTitle, author: prContext.pr.author }
        : null,
      skip: config.skip,
    };
    const options: RunOptions = { allowApiKey: input.allowApiKey, env: process.env };
    // One semaphore bounds every SDK query of the run.
    const semaphore = createSemaphore(config.concurrency);

    const commitsGathered: GatherResult = await timed("gather", () =>
      gather(repo, baseSha, headRev, {
        ...withRepoGlobs(config),
        // The history block exists only for the history reviewer. The skip
        // tier runs no reviewer, so it builds no block. The rules before the
        // diff (--tier, a label, a skip rule) can already give skip.
        history: config.reviewers.history?.enabled !== false && preTier(tierInput)?.tier !== "skip",
      }),
    );
    // With a pull request, the description is its sanitized title and body.
    // Else it is the sanitized commit messages that gather gives. Every
    // reviewer and verifier wraps it as untrusted text.
    const prText = prContext ? prDescription(prContext.pr) : null;
    const gathered: GatherResult = prText
      ? { ...commitsGathered, description: prText.text }
      : commitsGathered;
    const descriptionMeta: RunRecord["identity"]["description_meta"] = prText
      ? { source: "pr", sanitized: prText.sanitized, truncated: prText.truncated }
      : {
          source: "commits",
          sanitized: commitsGathered.descriptionMeta?.sanitized ?? false,
          truncated: commitsGathered.descriptionMeta?.truncated ?? false,
        };

    // The head checkout lives for the whole review and is the cwd of every
    // query. withHeadWorktree removes it at the end, also on failure.
    diff = gathered.diff;
    record = await withHeadWorktree(repo, gathered.head, async (cwd): Promise<RunRecord> => {
      let brief: TriageBrief | null = null;
      let triageFailure: QueryFailure | null = null;
      if (shouldRunTriage({ ...tierInput, totalHunks: gathered.totalHunks })) {
        const triage = await timed("triage", () =>
          semaphore(() => runTriage(client, options, gathered, cwd)),
        );
        brief = triage.brief;
        triageFailure = triage.failure;
      }
      const decision = decideTier({
        ...tierInput,
        skip: config.skip,
        totalHunks: gathered.totalHunks,
        sensitive: gathered.sensitive,
        brief,
        triageFailed: triageFailure !== null,
      });
      progress.tier = decision.tier;

      // The tier and the triggers select from the built-in and the custom
      // reviewers. A selected reviewer that the config disables does not
      // run, nor does the description reviewer when the description is
      // empty. Coverage names each of them.
      const candidates = selectReviewers(
        [...loadBuiltinReviewers(), ...loaded.customReviewers],
        decision.tier,
        gathered.changedFiles.map((f) => f.path),
        brief?.categories ?? [],
      );
      const { run: selected, skipped } = skipSelected(candidates, {
        config,
        description: gathered.description,
      });
      // A selected custom reviewer whose tools name Bash, and that does not
      // get it, runs with read-only tools. Coverage names it with the reason.
      const withoutBash = selected.flatMap(({ def }) => {
        const reason = reviewerTools(def, authorWriteAccess).bashReason;
        return reason === null ? [] : [{ name: def.frontmatter.name, reason }];
      });
      // No new reviewer pass starts once the tokens of the finished queries
      // reach the ceiling. Verification of returned findings still runs.
      const ceiling = config.token_ceiling;
      const canStartPass = (): boolean => ceiling === null || counter.tokens < ceiling;
      const ceilingSkipped: SkippedReviewer[] = [];
      // The rules block of every reviewer holds the base commit's CLAUDE.md
      // and rules.md, which the config loader already read.
      const rules = { claudeMd: loaded.claudeMd, rulesMd: loaded.rulesMd };
      const thresholds = new Map(
        selected.map((s) => [s.def.frontmatter.name, effectiveThreshold(s.def, config)]),
      );

      // The run splits the diff per file once. Find and verify use the map.
      const sections = diffSections(gathered.diff);
      // The verifier prompt loads once, at the first finding. A load that
      // fails is tried again at the next finding.
      let verifierPrompt: VerifierPrompt | undefined;

      // Each finding goes to its verifier as soon as its reviewer pass
      // returns. Merge is the only barrier.
      const pending: Promise<VerificationEntry>[] = [];
      // The pre-existing flag of each verification, in the order of
      // "pending". The verification entry of the record does not hold it.
      const preExistingFlags: boolean[] = [];
      // The reviewer name of each verification, in the order of "pending".
      // Suppressions match it, and the verification entry does not hold it.
      const reviewerNames: string[] = [];
      const onFinding = (finding: Finding, reviewer: string): void => {
        const verifyConfig = verifyConfigFor(
          thresholds.get(reviewer) ?? config.thresholds.default,
          config,
        );
        const index = pending.length;
        // The rejection handler is attached here, when the promise is made.
        // Other reviewer passes can run for a long time before the run waits
        // for this promise, and a rejection with no handler stops the
        // process. So an error (a prompt that does not load, for example)
        // becomes a failed verification here.
        const verification = Promise.resolve()
          .then(() => {
            verifierPrompt ??= loadVerifierPrompt();
            return verifyFinding(client, options, finding, {
              cwd,
              sections,
              prompt: verifierPrompt,
              semaphore,
              config: verifyConfig,
              description: gathered.description,
            });
          })
          .then(
            ({ pre_existing, ...v }: Verification): VerificationEntry => {
              preExistingFlags[index] = pre_existing;
              return { finding, ...v };
            },
            (err: unknown): VerificationEntry => ({
              finding,
              first: { kind: "thrown", message: messageOf(err) },
              final: null,
              passed: false,
            }),
          );
        pending.push(verification);
        reviewerNames.push(reviewer);
      };
      let runs: ReviewerRun[] = [];
      let verifications: VerificationEntry[] = [];
      let suppressed: { finding: Finding; reviewer: string; rule: Suppression }[] = [];
      let merged: Awaited<ReturnType<typeof mergeFindings>> = {
        posted: [],
        capped: [],
        merges: [],
      };
      try {
        ({ runs, verifications } = await timed("find_verify", async () => {
          let found: ReviewerRun[];
          try {
            found = await runReviewers(
              client,
              options,
              selected,
              {
                gathered,
                brief,
                cwd,
                semaphore,
                sections,
                config,
                rules,
                tier: decision.tier,
                authorWriteAccess,
                canStartPass,
                onPassSkipped: (name, pass) =>
                  ceilingSkipped.push({ name, reason: "token ceiling", pass }),
              },
              onFinding,
            );
          } catch (err) {
            // Let started verifications end before the checkout goes away.
            await Promise.allSettled(pending);
            throw err;
          }
          return { runs: found, verifications: await settleAll(pending) };
        }));

        // A suppression removes a verified finding before the merge groups
        // form. The record keeps the removed finding with its rule.
        const applied = applySuppressions(
          verifications.flatMap((v, i) =>
            v.passed && v.final
              ? [{ finding: v.finding, result: v.final, reviewer: reviewerNames[i] ?? "" }]
              : [],
          ),
          config.suppressions,
        );
        suppressed = applied.suppressed;
        merged = await timed("merge", () =>
          mergeFindings(client, options, applied.kept, {
            cwd,
            totalHunks: gathered.totalHunks,
            semaphore,
            caps: config.caps,
          }),
        );
      } catch (err) {
        // A run that posts keeps going: it writes a record with the error and
        // posts a failure review (R5a). Any other run fails here.
        if (!post) throw err;
        failed.value = { stage: progress.stage, message: messageOf(err) };
      }

      // The verified pre-existing findings (R6), in a stable order.
      const preExisting: PostedFinding[] = verifications
        .flatMap((v, i) =>
          preExistingFlags[i] === true && !isFailure(v.first) && v.first !== undefined
            ? [toPostedFinding(v.finding, v.first, readHeadFile(cwd, v.finding.file))]
            : [],
        )
        .sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

      // A failed or refused verifier call, first or escalation, drops its
      // finding and makes the verdict incomplete. So does a result that code
      // rejected after the verifier passed it.
      const counts = verificationCounts(
        runs,
        verifications.map((v, i) => ({ ...v, pre_existing: preExistingFlags[i] === true })),
      );
      const verdict = failed.value
        ? "incomplete"
        : decideVerdict({
            tier: decision.tier,
            reviewerRuns: runs,
            verifierFailures: counts.failedVerifierCalls + counts.rejectedResults,
            refusals: counts.refusals,
            posted: merged.posted,
            ceilingSkips: ceilingSkipped.length,
          });
      // The ceiling skips come in the order the passes reached their slots,
      // so they are sorted for a stable record.
      const allSkipped = [
        ...skipped,
        ...[...ceilingSkipped].sort(
          (a, b) => a.name.localeCompare(b.name) || (a.pass ?? 0) - (b.pass ?? 0),
        ),
      ];

      return {
        identity: {
          repo,
          pr: input.pr ?? null,
          github: prContext
            ? {
                slug: prContext.slug,
                title: prTitle,
                draft: prContext.pr.draft,
                labels: prContext.pr.labels,
                author: prContext.pr.author,
                author_type: prContext.pr.author_type,
                author_write_access: prContext.authorWriteAccess,
                fork: prContext.pr.fork,
                head_repo: prContext.pr.head_repo,
                url: prContext.pr.url,
              }
            : null,
          base: gathered.base,
          head: gathered.head,
          started_at: startedAt.toISOString(),
          tool_version: toolVersion(),
          config_hash: loaded.hash,
          config: {
            files: loaded.files,
            values: config,
            custom_reviewers: loaded.customReviewers.map((def) => {
              const tools = reviewerTools(def, authorWriteAccess);
              return {
                name: def.frontmatter.name,
                bash_granted: tools.bashGranted,
                reason: tools.bashReason,
              };
            }),
          },
          description: gathered.description,
          description_meta: descriptionMeta,
          history: {
            built: gathered.history !== null,
            truncated: gathered.history?.truncated ?? false,
          },
          // A skip run starts no reviewer, so it injects no file.
          injected:
            selected.length > 0
              ? injectedRuleFiles(rules).map((f) => ({ path: f.path, truncated: f.truncated }))
              : [],
          changed_files: gathered.changedFiles,
          excluded_files: gathered.excluded,
          sensitive_files: gathered.sensitive,
          triage: brief,
          tier: decision.tier,
          tier_reason: decision.reason,
          selected_reviewers: describeSelected(selected, config, authorWriteAccess),
          models: roleModels(config),
        },
        stages: {
          reviewers: runs,
          verifications,
          merges: merged.merges,
          capped: merged.capped,
          suppressed: suppressed.map(({ finding, reviewer, rule }) => ({
            finding,
            reviewer,
            rule,
          })),
          pre_existing: preExisting,
        },
        posted: {
          verdict,
          coverage: coverage(
            runs,
            counts.droppedByFailedVerifier,
            allSkipped,
            withoutBash,
            sensitiveWithoutHunks(gathered),
          ),
          findings: merged.posted,
          github: null,
        },
        cost: {
          queries,
          total_cost_usd: totalCost(queries),
          queries_without_cost: queries.filter((q) => q.cost_usd === null).length,
          stage_ms: stageMs,
          errors: [
            // Config and gather run first, so their errors come first.
            ...loaded.warnings.map((message) => ({ stage: "config", message })),
            ...(gathered.historyError
              ? [{ stage: "gather", message: `history: ${gathered.historyError}` }]
              : []),
            ...collectErrors(triageFailure, runs, verifications, merged.merges),
            ...(failed.value ? [failed.value] : []),
          ],
        },
      };
    });
  } catch (err) {
    // R5a: the run failed after it read the pull request and before the
    // review posted. No record exists, so the run posts a failure review
    // and fails.
    const marker = {
      run: recordFileName(startedAt, headRev).replace(/\.json$/, ""),
      head: headRev,
      base: baseRev,
      tier: progress.tier ?? ("unknown" as const),
    };
    await postFailureReview(marker, messageOf(err));
    throw err;
  }

  if (!post) {
    const recordPath = await writeRecord(input.outDir, record);
    return { record, recordPath, reviewUrl: null, exitCode: 0, error: null };
  }

  // The run id is the stem of the record file name, so the name comes first.
  const runId = recordRunId(record);
  const { identity } = record;
  const marker = { run: runId, head: identity.head, base: identity.base, tier: identity.tier };
  if (failed.value) {
    const postError = await postFailureReview(marker, failed.value.message);
    if (postError !== null) {
      record.cost.errors.push({ stage: "post", message: `failure review: ${postError}` });
    }
    const recordPath = await writeRecord(input.outDir, record);
    const error = `The run failed at ${failed.value.stage}: ${failed.value.message}`;
    return { record, recordPath, reviewUrl: null, exitCode: 1, error };
  }

  let posted: PostedGitHub | null = null;
  progress.stage = "post";
  try {
    // A skip run posts its one-line review once per reason.
    const already =
      identity.tier === "skip" &&
      skipReviewAlreadyPosted(
        await post.github.listReviews({ slug: post.ctx.slug, number: post.ctx.pr.number }),
        post.ctx.viewerLogin,
        identity.tier_reason,
      );
    if (!already) {
      posted = await postRun(post.github, {
        ctx: post.ctx,
        record,
        runId,
        diff,
        carriedMarkers: [],
      });
    }
  } catch (err) {
    // R5a: the run failed before the review posted.
    const message = messageOf(err);
    record.cost.errors.push({ stage: progress.stage, message });
    await postFailureReview(marker, message);
    const recordPath = await writeRecord(input.outDir, record);
    return {
      record,
      recordPath,
      reviewUrl: null,
      exitCode: 1,
      error: `The run failed at ${progress.stage}: ${message}`,
    };
  }
  record.posted.github = posted;
  const recordPath = await writeRecord(input.outDir, record);
  const error = posted?.error ?? null;
  return {
    record,
    recordPath,
    reviewUrl: posted?.review_url ?? null,
    exitCode: error === null ? 0 : 1,
    error,
  };
}
