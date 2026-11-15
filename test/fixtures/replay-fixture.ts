// Helpers for the replay tests (D4c S2): two cases, the findings of each
// reviewer, a fake for the eval that makes the --from directory, and a
// fake for the replay verifier.
import { join } from "node:path";
import type { GoldenFinding } from "../../src/eval/case.js";
import {
  classifyResult,
  type QueryMeta,
  type QueryOutcome,
  type QueryRequest,
} from "../../src/sdk/client.js";
import { createFakeSdkClient } from "../../src/sdk/fake.js";
import { captured, casesFrom, exitCodeOf, makeTemplate, output, tempDir } from "./eval-fixture.js";
import { createProgram } from "../../src/cli.js";

const golden = (
  file: string,
  line: number,
  category: GoldenFinding["category"],
  severity: GoldenFinding["severity"],
  claim: string,
): GoldenFinding => ({ file, start_line: line, end_line: line, category, severity, claim });

/** The goldens of a-case: one of each kind that its candidates match. */
export const A_GOLDEN: GoldenFinding[] = [
  golden("src/stats.ts", 11, "bug", "blocking", "GA"),
  golden("src/stats.ts", 14, "bug", "suggestion", "GP1"),
  golden(".github/workflows/ci.yml", 8, "security", "dont_post", "GP2"),
  golden("README.md", 3, "docs", "not_real", "GF"),
];
/** The goldens of b-case. NEAR matches the first one through the judge. */
export const B_GOLDEN: GoldenFinding[] = [
  golden("src/stats.ts", 11, "bug", "blocking", "GA"),
  golden("src/stats.ts", 14, "bug", "unsure", "GU"),
];

export const finding = (
  file: string,
  line: number,
  category: string,
  claim: string,
  evidence: string,
  needsContext = false,
) => ({
  file,
  start_line: line,
  end_line: line,
  category,
  severity_estimate: "blocking",
  confidence: "high",
  claim,
  evidence,
  explanation: "e",
  needs_context: needsContext,
});
export type TestFinding = ReturnType<typeof finding>;

export const ALPHA = finding(
  "src/stats.ts",
  11,
  "bug",
  "CLAIM-ALPHA",
  "for (let i = 0; i <= values.length; i++) {",
);
export const P1 = finding("src/stats.ts", 14, "bug", "CLAIM-P1", "return total / values.length;");
export const P2 = finding(".github/workflows/ci.yml", 8, "security", "CLAIM-P2", "- run: npm test");
export const F = finding("README.md", 3, "docs", "CLAIM-F", "A small repo for pr-review tests.");
// NEAR is next to the golden GA with no overlap: the pair goes to the judge.
export const NEAR = finding("src/stats.ts", 12, "bug", "CLAIM-NEAR", "total += values[i];");
export const U = finding("src/stats.ts", 14, "bug", "CLAIM-U", "return total / values.length;");

// The findings of each eval run (one run per case, in case order):
// diff-bugs pass 1, diff-bugs pass 2, security pass 1.
const RUNS: [TestFinding[], TestFinding[], TestFinding[]][] = [
  [[ALPHA, P1], [ALPHA], [P2, F]],
  [[NEAR], [], [U]],
];

export const meta = (costUsd: number, model = "m"): QueryMeta => ({
  model,
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd,
});

export const QUOTES = [
  "i <= values.length",
  "return total / values.length",
  "run: npm test",
  "A small repo",
  "total += values[i]",
];

/** The claim of the finding that a verifier or severity message names. */
export const claimIn = (message: string): string => /CLAIM-[A-Z0-9]+/.exec(message)?.[0] ?? "none";

const verdict = (score: number, holds: boolean, severity: string) => ({
  in_scope: true,
  claim_holds: holds,
  introduced_by_pr: true,
  quotes: QUOTES,
  rationale: "r",
  score,
  severity,
});

/**
 * The first verifier results of the eval run. P1, P2 and U are in the
 * middle band, so they escalate. Escalation: P1 and U do not hold, P2
 * holds. So P1 passes alone and fails at the end, and P2 fails alone and
 * passes at the end: two escalations change the decision.
 */
export const EVAL_FIRST: Record<string, ReturnType<typeof verdict>> = {
  "CLAIM-ALPHA": verdict(95, true, "blocking"),
  "CLAIM-P1": verdict(85, true, "suggestion"),
  "CLAIM-P2": verdict(70, true, "suggestion"),
  "CLAIM-F": verdict(20, false, "not_real"),
  "CLAIM-NEAR": verdict(95, true, "blocking"),
  "CLAIM-U": verdict(70, true, "suggestion"),
};
const EVAL_ESCALATED: Record<string, ReturnType<typeof verdict>> = {
  "CLAIM-P1": verdict(10, false, "not_real"),
  "CLAIM-P2": verdict(95, true, "suggestion"),
  "CLAIM-U": verdict(10, false, "not_real"),
};
export const ESCALATION_COST = 0.2;

const triage = {
  tier: "full",
  reason: "r",
  confidence: "high",
  categories: ["bug"],
  hotspots: [],
  file_notes: [],
  summary: "s",
};

/** The fake of the eval that makes the --from directory. */
export function evalFake() {
  let runs = 0;
  let calls = new Map<string, number>();
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const ok = (out: unknown, cost = 0): QueryOutcome<unknown> => ({
      ok: true,
      output: out,
      raw: meta(cost),
    });
    switch (req.role) {
      case "triage":
        runs += 1;
        calls = new Map();
        return ok(triage);
      case "reviewer": {
        const name = req.reviewerName ?? "";
        const pass = (calls.get(name) ?? 0) + 1;
        calls.set(name, pass);
        const run = RUNS[runs - 1];
        if (name === "diff-bugs") return ok({ findings: run?.[pass - 1] ?? [] });
        if (name === "security") return ok({ findings: run?.[2] ?? [] });
        return ok({ findings: [] });
      }
      case "verifier":
        return ok(EVAL_FIRST[claimIn(req.userMessage)], 0.1);
      case "verifier-escalation":
        return ok(EVAL_ESCALATED[claimIn(req.userMessage)], ESCALATION_COST);
      case "merge":
        return ok({ groups: [] });
      case "judge":
        return ok({ same_issue: "yes", reason: "r" });
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
}

export type Made = { cases: string; full: string; stage1: string };

/** Make the two cases, a full eval directory and a stage 1 eval directory. */
export async function makeReplayInputs(
  made: string[],
  fx: { repo: string; base: string; head: string },
): Promise<Made> {
  const root = tempDir("replay", made);
  const template = await makeTemplate(fx, root);
  const cases = casesFrom(template, join(root, "cases"), [
    { name: "a-case", golden: A_GOLDEN },
    { name: "b-case", golden: B_GOLDEN },
  ]);
  const evalInto = async (extra: string[]): Promise<string> => {
    const out = tempDir("replay-from", made);
    const code = await captured(() =>
      exitCodeOf(
        createProgram({ client: evalFake() }).parseAsync([
          "node",
          "pr-review",
          "eval",
          "--cases",
          cases,
          "--out",
          out,
          "--repeat",
          "1",
          "--no-extras",
          "--format",
          "json",
          "--reviewers",
          "diff-bugs,security",
          "--passes",
          "diff-bugs=2,security=1",
          ...extra,
        ]),
      ),
    );
    if (code !== 0) throw new Error(`the eval exited ${code}: ${output.stderr}`);
    return out;
  };
  return { cases, full: await evalInto([]), stage1: await evalInto(["--stage1"]) };
}

export type ReplayForm = "score" | "truth" | "bands";

/**
 * The replay results of each candidate, by claim, in the score form. The
 * truth form drops the severity; the bands form gives the band of the score.
 */
export const REPLAY: Record<string, ReturnType<typeof verdict>> = {
  "CLAIM-ALPHA": verdict(95, true, "blocking"),
  "CLAIM-P1": verdict(75, true, "suggestion"),
  "CLAIM-P2": verdict(90, true, "dont_post"),
  "CLAIM-F": verdict(20, false, "not_real"),
  "CLAIM-NEAR": verdict(95, true, "blocking"),
  "CLAIM-U": verdict(50, true, "unsure"),
};

const BAND_OF: Record<number, string> = {
  95: "certain",
  90: "certain",
  75: "likely",
  50: "possible",
  20: "unlikely",
};

export type ReplayFakeOptions = {
  form?: ReplayForm;
  verifierCost?: number;
  judgeCost?: number;
  /** The result of the verifier by claim, in the score form. Default REPLAY. */
  results?: Record<string, ReturnType<typeof verdict>>;
  /** The label of the severity step by claim. Default: the verifier severity. */
  labels?: Record<string, string>;
  severityCost?: number;
  /** The claims whose verifier call fails. */
  failVerifier?: string[];
  /** The claims whose verifier call stops on its dollar limit. */
  limitVerifier?: string[];
  /** The claims whose severity call (finding mode) fails. */
  failSeverity?: string[];
  /** The claims that a pr-mode answer leaves out. */
  omit?: string[];
};

/** The fake of the replay: the verifier of each form, the judge, and the severity step. */
export function replayFake(opts: ReplayFakeOptions = {}) {
  const results = opts.results ?? REPLAY;
  return createFakeSdkClient((req: QueryRequest): QueryOutcome<unknown> => {
    const ok = (out: unknown, cost = 0): QueryOutcome<unknown> => ({
      ok: true,
      output: out,
      raw: meta(cost, req.overrides?.model ?? "m"),
    });
    const labelOf = (claim: string): string =>
      opts.labels?.[claim] ?? results[claim]?.severity ?? "nit";
    switch (req.role) {
      case "verifier": {
        if (opts.failVerifier?.includes(claimIn(req.userMessage))) {
          return { ok: false, failure: { kind: "thrown", message: "down" }, raw: null };
        }
        if (opts.limitVerifier?.includes(claimIn(req.userMessage))) {
          // The real client classifies a result with this subtype, and keeps its cost.
          return classifyResult(
            {
              subtype: "error_max_budget_usd",
              duration_ms: 3,
              stop_reason: null,
              total_cost_usd: 0.7,
            },
            req.overrides?.model ?? "m",
            req.schema,
          );
        }
        const r = results[claimIn(req.userMessage)];
        if (!r) throw new Error(`no replay result for ${claimIn(req.userMessage)}`);
        const cost = opts.verifierCost ?? 0.1;
        if (opts.form === "truth") {
          const { severity: _severity, ...truth } = r;
          return ok(truth, cost);
        }
        if (opts.form === "bands") {
          const { score, ...rest } = r;
          return ok({ ...rest, band: BAND_OF[score] ?? "possible" }, cost);
        }
        return ok(r, cost);
      }
      case "judge":
        return ok({ same_issue: "yes", reason: "r" }, opts.judgeCost ?? 0);
      case "severity-finding":
        if (opts.failSeverity?.includes(claimIn(req.userMessage))) {
          return { ok: false, failure: { kind: "thrown", message: "down" }, raw: null };
        }
        return ok(
          { severity: labelOf(claimIn(req.userMessage)), rationale: "r" },
          opts.severityCost ?? 0.05,
        );
      case "severity-pr": {
        // The message lists the candidates in index order.
        const claims = [...req.userMessage.matchAll(/CLAIM-[A-Z0-9]+/g)].map((m) => m[0]);
        const unique = [...new Set(claims)];
        return ok(
          {
            labels: unique.flatMap((claim, index) =>
              opts.omit?.includes(claim)
                ? []
                : [{ index, severity: labelOf(claim), rationale: "r" }],
            ),
          },
          opts.severityCost ?? 0.05,
        );
      }
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
}

/** Run "pr-review replay" with the flags, and give the exit code. */
export async function replay(
  client: ReturnType<typeof createFakeSdkClient>,
  args: string[],
): Promise<number> {
  output.stdout = "";
  output.stderr = "";
  return exitCodeOf(createProgram({ client }).parseAsync(["node", "pr-review", "replay", ...args]));
}
