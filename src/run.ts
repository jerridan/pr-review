// The whole review pipeline for one run: gather, tier and triage, select,
// find with verification per finding, merge, verdict, and the record.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withRepoGlobs } from "./config/globs.js";
import { ROLE_DEFAULTS, ROLES, resolveModel, type Effort, type Role } from "./config/models.js";
import { loadRepoConfig, type ConfigRole, type RepoConfig } from "./config/repo-config.js";
import { injectedRuleFiles, runReviewers, type ReviewerRun } from "./find/index.js";
import { diffSections } from "./gather/diff.js";
import { gather, resolveCommit, type GatherResult } from "./gather/index.js";
import { withHeadWorktree } from "./gather/worktree.js";
import { mergeFindings } from "./merge/index.js";
import { writeRecord } from "./record/write.js";
import {
  effectiveModel,
  effectiveThreshold,
  loadBuiltinReviewers,
  reviewerEntry,
  reviewerTools,
  type ReviewerDefinition,
} from "./reviewers/loader.js";
import { selectReviewers } from "./reviewers/select.js";
import type { Finding } from "./schemas/finding.js";
import type { QueryFailure, RunRecord, SkippedReviewer } from "./schemas/record.js";
import type { TriageBrief } from "./schemas/triage.js";
import type { VerifierResult } from "./schemas/verifier.js";
import type { QueryOutcome, QueryRequest, SdkClient } from "./sdk/client.js";
import type { RunOptions } from "./sdk/options.js";
import { createSemaphore } from "./semaphore.js";
import { runTriage } from "./triage/index.js";
import { decideTier, shouldRunTriage, type Tier } from "./triage/tier.js";
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
  base: string;
  head: string;
  tierOverride?: Tier;
  outDir: string;
  allowApiKey: boolean;
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
): RunRecord["identity"]["selected_reviewers"] {
  return selected.map((s) => ({
    name: s.def.frontmatter.name,
    trigger: s.trigger,
    ...effectiveModel(s.def, config),
    tools_ignored: reviewerTools(s.def).ignored,
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
function recordingClient(inner: SdkClient, entries: CostEntry[], config: RepoConfig): SdkClient {
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

/** Run one review and write its record. Throw when the run cannot write a record. */
export async function runReview(
  input: RunInput,
): Promise<{ record: RunRecord; recordPath: string }> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const repo = resolve(input.repo);
  const stageMs: Record<string, number> = {};
  const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      stageMs[stage] = Math.round(performance.now() - start);
    }
  };

  // The config loads from the base commit before any model call and
  // before gather, because its globs change the exclusions. A config that
  // does not validate throws here, so the run writes no record.
  const baseSha = await resolveCommit(repo, input.base);
  const loaded = await timed("config", () => loadRepoConfig(repo, baseSha));
  const config = loaded.config;

  const inner = input.client ?? (await import("./sdk/client.js")).createSdkClient();
  const queries: CostEntry[] = [];
  const client = recordingClient(inner, queries, config);
  const options: RunOptions = { allowApiKey: input.allowApiKey, env: process.env };
  // One semaphore bounds every SDK query of the run.
  const semaphore = createSemaphore(config.concurrency);

  const gathered: GatherResult = await timed("gather", () =>
    gather(repo, baseSha, input.head, withRepoGlobs(config)),
  );

  // The head checkout lives for the whole review and is the cwd of every
  // query. withHeadWorktree removes it at the end, also on failure.
  const record = await withHeadWorktree(repo, gathered.head, async (cwd): Promise<RunRecord> => {
    let brief: TriageBrief | null = null;
    let triageFailure: QueryFailure | null = null;
    if (shouldRunTriage({ override: input.tierOverride, totalHunks: gathered.totalHunks })) {
      const triage = await timed("triage", () =>
        semaphore(() => runTriage(client, options, gathered, cwd)),
      );
      brief = triage.brief;
      triageFailure = triage.failure;
    }
    const decision = decideTier({
      override: input.tierOverride,
      totalHunks: gathered.totalHunks,
      sensitive: gathered.sensitive,
      brief,
      triageFailed: triageFailure !== null,
    });

    // The tier and the triggers select from the built-in and the custom
    // reviewers. A selected reviewer that the config disables does not
    // run, and coverage names it.
    const candidates = selectReviewers(
      [...loadBuiltinReviewers(), ...loaded.customReviewers],
      decision.tier,
      gathered.changedFiles.map((f) => f.path),
      brief?.categories ?? [],
    );
    const skipped: SkippedReviewer[] = [];
    const selected = candidates.filter((s) => {
      const name = s.def.frontmatter.name;
      if (reviewerEntry(config, name)?.enabled === false) {
        skipped.push({ name, reason: "disabled by config" });
        return false;
      }
      return true;
    });
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
    const onFinding = (finding: Finding, reviewer: string): void => {
      const verifyConfig = verifyConfigFor(
        thresholds.get(reviewer) ?? config.thresholds.default,
        config,
      );
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
          (v: Verification): VerificationEntry => ({ finding, ...v }),
          (err: unknown): VerificationEntry => ({
            finding,
            first: { kind: "thrown", message: messageOf(err) },
            final: null,
            passed: false,
          }),
        );
      pending.push(verification);
    };
    const { runs, verifications } = await timed("find_verify", async () => {
      let found: ReviewerRun[];
      try {
        found = await runReviewers(
          client,
          options,
          selected,
          { gathered, brief, cwd, semaphore, sections, config, rules },
          onFinding,
        );
      } catch (err) {
        // Let started verifications end before the checkout goes away.
        await Promise.allSettled(pending);
        throw err;
      }
      return { runs: found, verifications: await settleAll(pending) };
    });

    const verified = verifications.flatMap((v) =>
      v.passed && v.final ? [{ finding: v.finding, result: v.final }] : [],
    );
    const merged = await timed("merge", () =>
      mergeFindings(client, options, verified, {
        cwd,
        totalHunks: gathered.totalHunks,
        semaphore,
        caps: config.caps,
      }),
    );

    // A failed or refused verifier call, first or escalation, drops its
    // finding and makes the verdict incomplete. So does a result that code
    // rejected after the verifier passed it.
    const counts = verificationCounts(runs, verifications);
    const verdict = decideVerdict({
      tier: decision.tier,
      reviewerRuns: runs,
      verifierFailures: counts.failedVerifierCalls + counts.rejectedResults,
      refusals: counts.refusals,
      posted: merged.posted,
    });

    return {
      identity: {
        repo,
        pr: null,
        base: gathered.base,
        head: gathered.head,
        started_at: startedAt.toISOString(),
        tool_version: toolVersion(),
        config_hash: loaded.hash,
        config: { files: loaded.files, values: config, custom_reviewers: [] },
        description: gathered.description,
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
        selected_reviewers: describeSelected(selected, config),
        models: roleModels(config),
      },
      stages: {
        reviewers: runs,
        verifications,
        merges: merged.merges,
        capped: merged.capped,
      },
      posted: {
        verdict,
        coverage: coverage(runs, counts.droppedByFailedVerifier, skipped),
        findings: merged.posted,
      },
      cost: {
        queries,
        total_cost_usd: totalCost(queries),
        queries_without_cost: queries.filter((q) => q.cost_usd === null).length,
        stage_ms: stageMs,
        errors: collectErrors(triageFailure, runs, verifications, merged.merges),
      },
    };
  });

  const recordPath = await writeRecord(input.outDir, record);
  return { record, recordPath };
}
