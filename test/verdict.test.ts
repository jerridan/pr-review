import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { runReviewers, type ReviewerRun } from "../src/find/index.js";
import type { GatherResult } from "../src/gather/index.js";
import { mergeFindings } from "../src/merge/index.js";
import type { ReviewerDefinition } from "../src/reviewers/loader.js";
import type { Finding, Severity } from "../src/schemas/finding.js";
import type { PostedFinding, QueryFailure } from "../src/schemas/record.js";
import type { VerifierResult } from "../src/schemas/verifier.js";
import type { QueryMeta, QueryOutcome } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import type { RunOptions } from "../src/sdk/options.js";
import { createSemaphore } from "../src/semaphore.js";
import { runTriage } from "../src/triage/index.js";
import { decideTier } from "../src/triage/tier.js";
import { coverage, decideVerdict, verificationCounts } from "../src/verdict.js";
import { DEFAULT_VERIFY_CONFIG, verifyFinding } from "../src/verify/index.js";

const FILE_TEXT = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,4 @@",
  "+const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  "+const d = 4;",
  "",
].join("\n");

const head = mkdtempSync(join(tmpdir(), "pr-review-verdict-"));
mkdirSync(join(head, "src"));
writeFileSync(join(head, "src/a.ts"), FILE_TEXT);
afterAll(() => rmSync(head, { recursive: true, force: true }));

const OPTIONS: RunOptions = { allowApiKey: false, env: {} };
const META: QueryMeta = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0,
};
const GATHERED: GatherResult = {
  base: "a".repeat(40),
  head: "b".repeat(40),
  changedFiles: [{ path: "src/a.ts", hunks: 1 }],
  excluded: [],
  sensitive: [],
  diff: DIFF,
  totalHunks: 1,
  mergeBase: "c".repeat(40),
  description: "",
  history: null,
};

function finding(line: number): Finding {
  return {
    file: "src/a.ts",
    start_line: line,
    end_line: line,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: `claim ${line}`,
    evidence: FILE_TEXT.split("\n")[line - 1] ?? "",
    explanation: "e",
    needs_context: false,
  };
}

function vresult(score: number, severity: Severity = "blocking"): VerifierResult {
  return {
    in_scope: true,
    claim_holds: true,
    introduced_by_pr: true,
    quotes: [],
    rationale: "r",
    score,
    severity,
  };
}

function posted(severity: Severity): PostedFinding {
  return { ...finding(1), fingerprint: "fp", severity, score: 90, verifier: vresult(90, severity) };
}

function run(name: string, status: "ok" | "failed", pass = 1, failure?: QueryFailure): ReviewerRun {
  return {
    name,
    pass,
    status,
    ...(failure ? { failure } : {}),
    findings: [],
    dropped: [],
    meta: null,
  };
}

const thrown: QueryFailure = { kind: "thrown", message: "x" };

describe("decideVerdict (A8)", () => {
  const base = {
    tier: "full" as const,
    reviewerRuns: [run("diff-bugs", "ok")],
    verifierFailures: 0,
    refusals: 0,
    posted: [] as PostedFinding[],
  };

  it("is skipped for the skip tier, also when a stage failed", () => {
    expect(decideVerdict({ ...base, tier: "skip" })).toBe("skipped");
    expect(
      decideVerdict({
        ...base,
        tier: "skip",
        reviewerRuns: [run("diff-bugs", "failed", 1, thrown)],
        verifierFailures: 2,
        refusals: 1,
        posted: [posted("blocking")],
      }),
    ).toBe("skipped");
  });

  it("is incomplete when a reviewer failed, a verifier call failed or a call was refused", () => {
    expect(
      decideVerdict({
        ...base,
        reviewerRuns: [run("diff-bugs", "ok"), run("diff-bugs", "failed", 2, thrown)],
      }),
    ).toBe("incomplete");
    expect(decideVerdict({ ...base, verifierFailures: 1 })).toBe("incomplete");
    expect(decideVerdict({ ...base, refusals: 1 })).toBe("incomplete");
  });

  it("is incomplete when the token ceiling stopped a reviewer pass (R8)", () => {
    expect(decideVerdict({ ...base, ceilingSkips: 1 })).toBe("incomplete");
    expect(decideVerdict({ ...base, ceilingSkips: 1, posted: [posted("blocking")] })).toBe(
      "incomplete",
    );
    expect(decideVerdict({ ...base, ceilingSkips: 0 })).toBe("would approve");
    expect(decideVerdict({ ...base, tier: "skip", ceilingSkips: 1 })).toBe("skipped");
  });

  it("puts incomplete before would request changes", () => {
    expect(decideVerdict({ ...base, verifierFailures: 1, posted: [posted("blocking")] })).toBe(
      "incomplete",
    );
  });

  it("would request changes with one or more blocking findings", () => {
    expect(decideVerdict({ ...base, posted: [posted("nit"), posted("blocking")] })).toBe(
      "would request changes",
    );
  });

  it("would approve otherwise", () => {
    expect(decideVerdict(base)).toBe("would approve");
    expect(decideVerdict({ ...base, posted: [posted("suggestion"), posted("nit")] })).toBe(
      "would approve",
    );
    expect(decideVerdict({ ...base, tier: "fast" })).toBe("would approve");
  });
});

describe("coverage (A8)", () => {
  it("lists the reviewers that ran, the reviewers that failed and the dropped count", () => {
    const runs = [
      run("diff-bugs", "ok", 1),
      run("diff-bugs", "ok", 2),
      run("security", "ok", 1),
      run("security", "failed", 2, thrown),
      run("tests", "failed", 1, thrown),
    ];
    expect(coverage(runs, 3)).toEqual({
      reviewers_ran: ["diff-bugs"],
      reviewers_failed: ["security", "tests"],
      reviewers_skipped: [],
      reviewers_without_bash: [],
      sensitive_without_hunks: [],
      findings_dropped_by_failed_verifier: 3,
    });
    expect(coverage([], 0)).toEqual({
      reviewers_ran: [],
      reviewers_failed: [],
      reviewers_skipped: [],
      reviewers_without_bash: [],
      sensitive_without_hunks: [],
      findings_dropped_by_failed_verifier: 0,
    });
    const skipped = [{ name: "docs", reason: "disabled by config" as const }];
    expect(coverage(runs, 0, skipped).reviewers_skipped).toEqual(skipped);
    const withoutBash = [{ name: "shell-check", reason: "not trusted" }];
    expect(coverage(runs, 0, [], withoutBash).reviewers_without_bash).toEqual(withoutBash);
    expect(coverage(runs, 0, [], [], [".github/workflows/ci.yml"]).sensitive_without_hunks).toEqual(
      [".github/workflows/ci.yml"],
    );
  });

  it("counts verifier failures and refusals from the verifications", () => {
    const refusal: QueryFailure = { kind: "refusal", message: "r" };
    const counts = verificationCounts(
      [run("diff-bugs", "ok"), run("security", "failed", 1, refusal)],
      [
        { first: vresult(90), final: vresult(90), passed: true },
        { first: thrown, final: null, passed: false },
        { first: refusal, final: null, passed: false },
        { first: vresult(70), escalated: thrown, final: vresult(70), passed: false },
        { first: vresult(70), escalated: refusal, final: vresult(70), passed: false },
      ],
    );
    // A failed or refused escalation drops its finding too.
    expect(counts).toEqual({
      droppedByFailedVerifier: 4,
      failedVerifierCalls: 4,
      rejectedResults: 0,
      refusals: 3,
    });
  });

  it("counts a result that code rejected as a dropped finding, and the verdict is incomplete", () => {
    const runs = [run("diff-bugs", "ok")];
    const rejected = {
      first: vresult(90),
      final: vresult(90),
      passed: false,
      rejected: "No quote of the verifier is in the head file of the finding.",
    };
    const counts = verificationCounts(runs, [
      { first: vresult(90), final: vresult(90), passed: true },
      rejected,
      { ...rejected, first: vresult(70), escalated: vresult(90) },
    ]);
    expect(counts).toEqual({
      droppedByFailedVerifier: 2,
      failedVerifierCalls: 0,
      rejectedResults: 2,
      refusals: 0,
    });
    expect(coverage(runs, counts.droppedByFailedVerifier).findings_dropped_by_failed_verifier).toBe(
      2,
    );
    expect(
      decideVerdict({
        tier: "full",
        reviewerRuns: runs,
        verifierFailures: counts.failedVerifierCalls + counts.rejectedResults,
        refusals: counts.refusals,
        posted: [],
      }),
    ).toBe("incomplete");
  });
});

const FAILURE_KINDS: QueryFailure["kind"][] = [
  "subtype",
  "no-structured-output",
  "refusal",
  "max_tokens",
  "out-of-range",
  "thrown",
  "limit",
];

function def(name: string): ReviewerDefinition {
  return {
    source: "builtin",
    path: `/x/${name}.md`,
    systemPrompt: "s",
    frontmatter: {
      name,
      description: "d",
      model: "opus",
      effort: "low",
      tools: [],
      triggers: { paths: [], categories: [], min_tier: "fast" },
      passes: 1,
      threshold: 80,
      trusted: true,
    },
  };
}

describe("the query failure rule: each condition and each stage outcome (A8)", () => {
  for (const kind of FAILURE_KINDS) {
    const failure: QueryFailure = { kind, message: `failed: ${kind}` };
    const failed: QueryOutcome<unknown> = {
      ok: false,
      failure,
      raw: kind === "thrown" ? null : META,
    };

    it(`${kind}: triage routes to full`, async () => {
      const out = await runTriage(
        createFakeSdkClient(() => failed),
        OPTIONS,
        GATHERED,
        head,
      );
      expect(out.failure).toEqual(failure);
      expect(
        decideTier({
          totalHunks: 1,
          sensitive: [],
          brief: out.brief,
          triageFailed: out.failure !== null,
          skip: DEFAULT_REPO_CONFIG.skip,
        }).tier,
      ).toBe("full");
    });

    it(`${kind}: a reviewer fails and the verdict is incomplete`, async () => {
      const runs = await runReviewers(
        createFakeSdkClient(() => failed),
        OPTIONS,
        [{ def: def("diff-bugs"), trigger: "t" }],
        {
          gathered: GATHERED,
          brief: null,
          cwd: head,
          semaphore: createSemaphore(2),
          config: DEFAULT_REPO_CONFIG,
        },
        () => {},
      );
      expect(runs[0]?.status).toBe("failed");
      expect(runs[0]?.failure).toEqual(failure);
      const counts = verificationCounts(runs, []);
      expect(
        decideVerdict({
          tier: "full",
          reviewerRuns: runs,
          verifierFailures: counts.failedVerifierCalls,
          refusals: counts.refusals,
          posted: [],
        }),
      ).toBe("incomplete");
      expect(coverage(runs, 0).reviewers_failed).toEqual(["diff-bugs"]);
    });

    it(`${kind}: a failed verifier drops the finding into the coverage count`, async () => {
      const out = await verifyFinding(
        createFakeSdkClient(() => failed),
        OPTIONS,
        finding(1),
        {
          cwd: head,
          diff: DIFF,
          semaphore: createSemaphore(2),
          config: DEFAULT_VERIFY_CONFIG,
        },
      );
      expect(out).toEqual({ first: failure, final: null, passed: false });
      const counts = verificationCounts([run("diff-bugs", "ok")], [out]);
      expect(counts.droppedByFailedVerifier).toBe(1);
      expect(
        coverage([run("diff-bugs", "ok")], counts.droppedByFailedVerifier)
          .findings_dropped_by_failed_verifier,
      ).toBe(1);
      expect(
        decideVerdict({
          tier: "full",
          reviewerRuns: [run("diff-bugs", "ok")],
          verifierFailures: counts.failedVerifierCalls,
          refusals: counts.refusals,
          posted: [],
        }),
      ).toBe("incomplete");
    });

    it(`${kind}: a failed escalation drops the finding and the verdict is incomplete`, async () => {
      const fake = createFakeSdkClient((req) =>
        req.role === "verifier" ? { ok: true, output: vresult(84), raw: META } : failed,
      );
      const out = await verifyFinding(fake, OPTIONS, finding(1), {
        cwd: head,
        diff: DIFF,
        semaphore: createSemaphore(2),
        config: DEFAULT_VERIFY_CONFIG,
      });
      expect(out).toEqual({
        first: vresult(84),
        escalated: failure,
        final: null,
        passed: false,
      });
      const runs = [run("diff-bugs", "ok")];
      const counts = verificationCounts(runs, [out]);
      expect(counts.droppedByFailedVerifier).toBe(1);
      expect(counts.failedVerifierCalls).toBe(1);
      expect(
        coverage(runs, counts.droppedByFailedVerifier).findings_dropped_by_failed_verifier,
      ).toBe(1);
      expect(
        decideVerdict({
          tier: "full",
          reviewerRuns: runs,
          verifierFailures: counts.failedVerifierCalls,
          refusals: counts.refusals,
          posted: [],
        }),
      ).toBe("incomplete");
    });

    it(`${kind}: a failed merge posts the group unmerged`, async () => {
      const out = await mergeFindings(
        createFakeSdkClient(() => failed),
        OPTIONS,
        [
          { finding: { ...finding(1), end_line: 2 }, result: vresult(90) },
          { finding: { ...finding(2), end_line: 3 }, result: vresult(85) },
        ],
        { cwd: head, totalHunks: 1, semaphore: createSemaphore(2) },
      );
      expect(out.posted).toHaveLength(2);
      expect(out.merges).toEqual([{ group: [0, 1], result: failure }]);
    });
  }
});
