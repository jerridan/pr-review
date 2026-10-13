// The whole review pipeline for one run: gather, tier and triage, select,
// find with verification per finding, merge, verdict, and the record.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROLE_DEFAULTS, ROLES, resolveModel, type Effort, type Role } from "./config/models.js";
import { runReviewers, type ReviewerRun } from "./find/index.js";
import { gather, type GatherResult } from "./gather/index.js";
import { withHeadWorktree } from "./gather/worktree.js";
import { mergeFindings } from "./merge/index.js";
import { writeRecord } from "./record/write.js";
import {
  loadBuiltinReviewers,
  reviewerOverrides,
  type ReviewerDefinition,
} from "./reviewers/loader.js";
import { selectReviewers } from "./reviewers/select.js";
import type { Finding } from "./schemas/finding.js";
import type { QueryFailure, RunRecord } from "./schemas/record.js";
import type { TriageBrief } from "./schemas/triage.js";
import type { VerifierResult } from "./schemas/verifier.js";
import type { QueryOutcome, QueryRequest, SdkClient } from "./sdk/client.js";
import type { RunOptions } from "./sdk/options.js";
import { createSemaphore } from "./semaphore.js";
import { runTriage } from "./triage/index.js";
import { decideTier, shouldRunTriage, type Tier } from "./triage/tier.js";
import { coverage, decideVerdict, verificationCounts } from "./verdict.js";
import { DEFAULT_VERIFY_CONFIG, verifyFinding, type Verification } from "./verify/index.js";

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

/** The default bound on SDK queries at once. Each query is its own process. */
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

function defaultModels(): Record<Role, { model: string; effort: Effort }> {
  const models = {} as Record<Role, { model: string; effort: Effort }>;
  for (const role of ROLES) {
    models[role] = {
      model: resolveModel(ROLE_DEFAULTS[role].model),
      effort: ROLE_DEFAULTS[role].effort,
    };
  }
  return models;
}

/**
 * The record entry of each selected reviewer, with the model and effort
 * that its queries use after its frontmatter override.
 */
export function describeSelected(
  selected: { def: ReviewerDefinition; trigger: string }[],
): RunRecord["identity"]["selected_reviewers"] {
  return selected.map((s) => ({
    name: s.def.frontmatter.name,
    trigger: s.trigger,
    ...reviewerOverrides(s.def),
  }));
}

// Wrap the client so that each query gives one cost entry, also a query
// that fails or throws.
function recordingClient(inner: SdkClient, entries: CostEntry[]): SdkClient {
  return {
    async query<T>(req: QueryRequest, options: RunOptions): Promise<QueryOutcome<T>> {
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
  const inner = input.client ?? (await import("./sdk/client.js")).createSdkClient();
  const queries: CostEntry[] = [];
  const client = recordingClient(inner, queries);
  const options: RunOptions = { allowApiKey: input.allowApiKey, env: process.env };
  // One semaphore bounds every SDK query of the run.
  const semaphore = createSemaphore(DEFAULT_CONCURRENCY);
  const stageMs: Record<string, number> = {};
  const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      stageMs[stage] = Math.round(performance.now() - start);
    }
  };

  const gathered: GatherResult = await timed("gather", () => gather(repo, input.base, input.head));

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

    const selected = selectReviewers(
      loadBuiltinReviewers(),
      decision.tier,
      gathered.changedFiles.map((f) => f.path),
      brief?.categories ?? [],
    );
    const thresholds = new Map(
      selected.map((s) => [s.def.frontmatter.name, s.def.frontmatter.threshold]),
    );

    // Each finding goes to its verifier as soon as its reviewer pass
    // returns. Merge is the only barrier.
    const pending: Promise<VerificationEntry>[] = [];
    const onFinding = (finding: Finding, reviewer: string): void => {
      const config = {
        ...DEFAULT_VERIFY_CONFIG,
        threshold: thresholds.get(reviewer) ?? DEFAULT_VERIFY_CONFIG.threshold,
      };
      pending.push(
        verifyFinding(client, options, finding, {
          cwd,
          diff: gathered.diff,
          semaphore,
          config,
        }).then((v: Verification) => ({ finding, ...v })),
      );
    };
    const { runs, verifications } = await timed("find_verify", async () => {
      let found: ReviewerRun[];
      try {
        found = await runReviewers(
          client,
          options,
          selected,
          { gathered, brief, cwd, semaphore },
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
      mergeFindings(client, options, verified, { cwd, totalHunks: gathered.totalHunks, semaphore }),
    );

    // A failed or refused verifier call, first or escalation, drops its
    // finding and makes the verdict incomplete.
    const counts = verificationCounts(runs, verifications);
    const verdict = decideVerdict({
      tier: decision.tier,
      reviewerRuns: runs,
      verifierFailures: counts.failedVerifierCalls,
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
        config_hash: null,
        changed_files: gathered.changedFiles,
        excluded_files: gathered.excluded,
        sensitive_files: gathered.sensitive,
        triage: brief,
        tier: decision.tier,
        tier_reason: decision.reason,
        selected_reviewers: describeSelected(selected),
        models: defaultModels(),
      },
      stages: {
        reviewers: runs,
        verifications,
        merges: merged.merges,
        capped: merged.capped,
      },
      posted: {
        verdict,
        coverage: coverage(runs, counts.droppedByFailedVerifier),
        findings: merged.posted,
      },
      cost: {
        queries,
        total_cost_usd: totalCost(queries),
        stage_ms: stageMs,
        errors: collectErrors(triageFailure, runs, verifications, merged.merges),
      },
    };
  });

  const recordPath = await writeRecord(input.outDir, record);
  return { record, recordPath };
}
