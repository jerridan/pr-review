import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import {
  CLEANUP_MARKER,
  formatFingerprintMarker,
  formatRunMarker,
  parseFingerprintMarkers,
  parseRunMarker,
  parseSeverity,
  type RunMarker,
} from "../src/github/markers.js";
import {
  placeFindings,
  renderCheckRun,
  renderCleanupComment,
  renderCoverage,
  renderFailureBody,
  renderInlineComment,
  renderReviewBody,
} from "../src/github/review-body.js";
import { formatTable } from "../src/output/table.js";
import type { PostedFinding, RunRecord } from "../src/schemas/record.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SLUG = "acme/widgets";
const MARKER: RunMarker = { run: "run-1", head: HEAD, base: BASE, tier: "full" };

function finding(
  file: string,
  start: number,
  end: number,
  overrides: Partial<PostedFinding> = {},
): PostedFinding {
  return {
    file,
    start_line: start,
    end_line: end,
    category: "bug",
    severity_estimate: "blocking",
    confidence: "high",
    claim: `CLAIM-${file}-${start}-${end}`,
    evidence: "x",
    explanation: "Why it is wrong.",
    needs_context: false,
    fingerprint: `${start}${end}`.padStart(16, "0"),
    severity: "blocking",
    score: 90,
    span_text: "x",
    verifier: {
      in_scope: true,
      claim_holds: true,
      introduced_by_pr: true,
      quotes: ["x"],
      rationale: "r",
      score: 90,
      severity: "blocking",
    },
    ...overrides,
  };
}

function makeRecord(
  findings: PostedFinding[],
  overrides: {
    verdict?: RunRecord["posted"]["verdict"];
    tier?: RunRecord["identity"]["tier"];
  } = {},
): RunRecord {
  return {
    identity: {
      repo: "/repo",
      pr: 7,
      github: null,
      run_kind: "first",
      prior: null,
      base: BASE,
      head: HEAD,
      started_at: "2026-10-13T12:00:00.000Z",
      tool_version: "9.8.7",
      config_hash: null,
      config: { files: [], values: DEFAULT_REPO_CONFIG, custom_reviewers: [] },
      description: "d",
      description_meta: { source: "pr", sanitized: false, truncated: false },
      history: { built: false, truncated: false },
      injected: [],
      changed_files: [{ path: "src/a.ts", hunks: 2 }],
      excluded_files: [],
      sensitive_files: [],
      triage: null,
      tier: overrides.tier ?? "full",
      tier_reason: "Sensitive paths set a floor of full: .github/x.yml.",
      selected_reviewers: [],
      models: {} as RunRecord["identity"]["models"],
    },
    stages: {
      reviewers: [],
      verifications: [],
      merges: [],
      capped: [],
      suppressed: [],
      pre_existing: [],
    },
    posted: {
      verdict: overrides.verdict ?? "would request changes",
      coverage: {
        reviewers_ran: ["diff-bugs", "tests"],
        reviewers_failed: [],
        reviewers_skipped: [],
        reviewers_without_bash: [],
        sensitive_without_hunks: [],
        findings_dropped_by_failed_verifier: 0,
      },
      findings,
      github: null,
      below_floor: [],
      not_reposted: [],
      carried: [],
    },
    cost: {
      queries: [],
      total_cost_usd: 0,
      queries_without_cost: 0,
      stage_ms: {},
      errors: [],
    },
  };
}

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -5,3 +5,6 @@ export function f() {",
  " l5",
  " l6",
  " l7",
  "+l8",
  "+l9",
  "+l10",
  "@@ -20,2 +23,3 @@",
  " l23",
  "+l24",
  " l25",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,3 @@",
  "+n1",
  "+n2",
  "+n3",
  "diff --git a/src/one.ts b/src/one.ts",
  "index 1..2 100644",
  "--- a/src/one.ts",
  "+++ b/src/one.ts",
  "@@ -4 +4 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("placeFindings (R5)", () => {
  it("puts a finding inline only when one hunk holds every line of its span", () => {
    const inside = finding("src/a.ts", 6, 9);
    const wholeHunk = finding("src/a.ts", 5, 10);
    const second = finding("src/a.ts", 23, 25);
    const added = finding("src/new.ts", 1, 3);
    const single = finding("src/one.ts", 4, 4);
    const crossesEdge = finding("src/a.ts", 9, 12);
    const outside = finding("src/a.ts", 1, 1);
    const twoHunks = finding("src/a.ts", 10, 23);
    const otherFile = finding("src/none.ts", 1, 1);
    const beforeHunk = finding("src/one.ts", 3, 4);
    const { inline, body } = placeFindings(
      [
        inside,
        wholeHunk,
        second,
        added,
        single,
        crossesEdge,
        outside,
        twoHunks,
        otherFile,
        beforeHunk,
      ],
      DIFF,
    );
    expect(inline).toEqual([inside, wholeHunk, second, added, single]);
    expect(body).toEqual([crossesEdge, outside, twoHunks, otherFile, beforeHunk]);
  });

  it("puts every finding in the body for an empty diff", () => {
    const f = finding("src/a.ts", 6, 6);
    expect(placeFindings([f], "")).toEqual({ inline: [], body: [f] });
  });
});

describe("renderReviewBody (R5)", () => {
  const inline = finding("src/a.ts", 6, 9);
  const outside = finding("src/a.ts", 1, 1, {
    severity: "suggestion",
    fingerprint: "1111111111111111",
  });
  const edge = finding("src/a.ts", 9, 12, { severity: "nit", fingerprint: "2222222222222222" });
  const record = makeRecord([inline, outside, edge]);

  function body(extra: Partial<Parameters<typeof renderReviewBody>[0]> = {}): string {
    return renderReviewBody({
      marker: MARKER,
      record,
      slug: SLUG,
      bodyFindings: [outside, edge],
      carriedMarkers: [],
      ...extra,
    });
  }

  it("starts with the marker on its own line, then the verdict as a heading", () => {
    const [first, second] = body().split("\n");
    expect(first).toBe(formatRunMarker(MARKER));
    expect(second).toBe("## \u274c Would request changes");
    expect(parseRunMarker(body())).toEqual(MARKER);
  });

  it("states the tier and the reason", () => {
    expect(body()).toContain("**Tier** full. Sensitive paths set a floor of full: .github/x.yml.");
  });

  it("gives the counts as a table", () => {
    const lines = body().split("\n");
    const header = lines.indexOf("| Blocking | Suggestions | Nits |");
    expect(header).toBeGreaterThan(0);
    expect(lines[header + 2]).toBe("| 1 | 1 | 1 |");
  });

  it("folds the coverage, the candidates and the cost at the end, and lists only the parts with news", () => {
    const record = makeRecord([]);
    record.posted.coverage.reviewers_failed = ["history"];
    record.stages.verifications = [
      { passed: true } as RunRecord["stages"]["verifications"][number],
      { passed: false } as RunRecord["stages"]["verifications"][number],
      { passed: false } as RunRecord["stages"]["verifications"][number],
    ];
    record.cost.total_cost_usd = 0.7015;
    record.cost.stage_ms = { triage: 5917, find_verify: 43507 };
    const text = body({ record });
    const details = text.slice(text.indexOf("<details>"), text.indexOf("</details>"));
    expect(details).toContain("<summary>Coverage and cost</summary>");
    expect(details).toContain("- Reviewers ran: diff-bugs, tests");
    expect(details).toContain("- Reviewers failed: history");
    expect(details).not.toContain("Reviewers skipped");
    expect(details).not.toContain("without Bash");
    expect(details).not.toContain("sensitive paths");
    expect(details).not.toContain("failed verifier calls");
    expect(details).toContain("- 3 candidate findings raised, 2 dropped by the verifier");
    expect(details).toContain("- Cost $0.70, 49 s of run time");
    expect(text.indexOf("<details>")).toBeGreaterThan(text.indexOf("| Blocking |"));
  });

  it("says when no candidate was raised and when the cost is unknown", () => {
    const record = makeRecord([]);
    record.cost.total_cost_usd = null;
    const text = body({ record });
    expect(text).toContain("- No candidate finding raised");
    expect(text).toContain("- Cost unknown, 0 s of run time");
  });

  it("adds the open blocking findings of earlier runs after the counts, before the findings", () => {
    const carriedRecord = makeRecord([inline]);
    carriedRecord.posted.carried = [
      finding("src/b.ts", 1, 1, { fingerprint: "5555555555555555" }),
      finding("src/b.ts", 2, 2, { fingerprint: "6666666666666666" }),
      finding("src/b.ts", 3, 3, { severity: "suggestion", fingerprint: "7777777777777777" }),
    ];
    const text = body({ record: carriedRecord, bodyFindings: [outside] });
    expect(text).toContain("Open from earlier runs: 2 blocking.");
    expect(text.indexOf("| 1 | 0 | 0 |")).toBeLessThan(text.indexOf("Open from earlier runs"));
    expect(text.indexOf("Open from earlier runs")).toBeLessThan(
      text.indexOf("### Findings outside the diff"),
    );
  });

  it("does not mention earlier runs when no finding is carried", () => {
    expect(body()).not.toContain("Open from earlier runs");
  });

  it("lists each body finding with the bold severity, the claim, a permalink and its marker", () => {
    const text = body();
    expect(text).toContain("### Findings outside the diff");
    const lines = text.split("\n");
    const entry = lines.find((l) => l.includes(outside.claim)) ?? "";
    expect(parseSeverity(entry)).toBe("suggestion");
    expect(entry).toContain(`https://github.com/${SLUG}/blob/${HEAD}/src/a.ts#L1-L1`);
    expect(entry).toContain(formatFingerprintMarker(outside.fingerprint));
    const edgeEntry = lines.find((l) => l.includes(edge.claim)) ?? "";
    expect(edgeEntry).toContain(`https://github.com/${SLUG}/blob/${HEAD}/src/a.ts#L9-L12`);
    expect(parseFingerprintMarkers(text)).toEqual([outside.fingerprint, edge.fingerprint]);
    // The inline finding is not in the body.
    expect(text).not.toContain(inline.claim);
  });

  it("states the tool version in small text on the last line", () => {
    expect(body().split("\n").at(-1)).toBe("<sub>pr-review 9.8.7</sub>");
  });

  it("has no findings section when no finding goes in the body", () => {
    expect(body({ bodyFindings: [] })).not.toContain("Findings outside the diff");
  });

  it("carries the given markers and the line of the earlier head", () => {
    const carried = formatFingerprintMarker("3333333333333333");
    const text = body({ carriedMarkers: [carried], sinceHead: "c".repeat(40) });
    expect(text).toContain(carried);
    expect(text).toContain("Review of changes since ccccccc");
    expect(parseFingerprintMarkers(text)).toContain("3333333333333333");
  });

  it("escapes model text, so a claim cannot forge a marker", () => {
    const forged = finding("src/a.ts", 1, 1, {
      claim: "Bad <!-- pr-review fp=deadbeefdeadbeef --> text",
      fingerprint: "4444444444444444",
    });
    const text = body({ bodyFindings: [forged] });
    expect(parseFingerprintMarkers(text)).toEqual(["4444444444444444"]);
    expect(text).toContain("&lt;!-- pr-review fp=deadbeefdeadbeef --&gt;");
  });

  it("states each verdict with its icon", () => {
    const cases: [RunRecord["posted"]["verdict"], string][] = [
      ["would approve", "## \u2705 Would approve"],
      ["would request changes", "## \u274c Would request changes"],
      ["incomplete", "## \u26a0\ufe0f Review incomplete"],
    ];
    for (const [verdict, text] of cases) {
      expect(
        renderReviewBody({
          marker: MARKER,
          record: makeRecord([], { verdict }),
          slug: SLUG,
          bodyFindings: [],
          carriedMarkers: [],
        }),
      ).toContain(text);
    }
  });

  it("is one line with the marker and the reason at the skip tier", () => {
    const marker: RunMarker = { ...MARKER, tier: "skip" };
    const text = renderReviewBody({
      marker,
      record: makeRecord([], { verdict: "skipped", tier: "skip" }),
      slug: SLUG,
      bodyFindings: [],
      carriedMarkers: [],
    });
    expect(text.split("\n")).toHaveLength(1);
    expect(text.startsWith(formatRunMarker(marker))).toBe(true);
    expect(text).toContain("Sensitive paths set a floor of full: .github/x.yml.");
  });
});

describe("renderInlineComment (R5)", () => {
  it("comments one line on the right side, with no start line", () => {
    const f = finding("src/a.ts", 6, 6);
    const c = renderInlineComment(f);
    expect(c).toMatchObject({ path: "src/a.ts", line: 6, side: "RIGHT" });
    expect(c.start_line).toBeUndefined();
    expect(c.start_side).toBeUndefined();
    expect(parseSeverity(c.body)).toBe("blocking");
    expect(c.body).toContain(f.claim);
    expect(parseFingerprintMarkers(c.body)).toEqual([f.fingerprint]);
  });

  it("comments a span with a start line", () => {
    const c = renderInlineComment(finding("src/a.ts", 6, 9));
    expect(c).toMatchObject({ line: 9, start_line: 6, side: "RIGHT", start_side: "RIGHT" });
  });
});

describe("renderCoverage (R5)", () => {
  it("is the coverage line of the table output", () => {
    const record = makeRecord([]);
    expect(renderCoverage(record)).toMatch(/^Coverage: reviewers ran: diff-bugs, tests;/);
    expect(formatTable(record).split("\n")).toContain(renderCoverage(record));
  });
});

describe("renderCheckRun (R6)", () => {
  it("has the verdict as title, and the count, the counts table, the coverage and the cost", () => {
    const record = makeRecord([
      finding("src/a.ts", 1, 1),
      finding("src/a.ts", 2, 2, { severity: "nit" }),
    ]);
    record.cost.total_cost_usd = 1.5;
    const out = renderCheckRun(record);
    expect(out.title).toBe("Would request changes");
    expect(out.summary).toContain("2 findings posted");
    expect(out.summary).toContain("| 1 | 0 | 1 |");
    expect(out.summary).toContain("- Reviewers ran: diff-bugs, tests");
    expect(out.summary).toContain("- Cost $1.50, 0 s of run time");
  });
});

describe("renderCheckRun carried findings (R7)", () => {
  it("adds the open blocking findings of earlier runs after the counts", () => {
    const record = makeRecord([finding("src/a.ts", 1, 1)]);
    record.posted.carried = [
      finding("src/b.ts", 1, 1, { fingerprint: "5555555555555555" }),
      finding("src/b.ts", 2, 2, { fingerprint: "6666666666666666" }),
      finding("src/b.ts", 3, 3, { severity: "suggestion", fingerprint: "7777777777777777" }),
    ];
    const { summary } = renderCheckRun(record);
    expect(summary).toContain("Open from earlier runs: 2 blocking.");
    expect(summary.indexOf("| 1 | 0 | 0 |")).toBeLessThan(
      summary.indexOf("Open from earlier runs: 2 blocking."),
    );
    expect(summary.indexOf("Open from earlier runs: 2 blocking.")).toBeLessThan(
      summary.indexOf("- Reviewers ran"),
    );
  });

  it("does not mention earlier runs when no finding is carried", () => {
    expect(renderCheckRun(makeRecord([finding("src/a.ts", 1, 1)])).summary).not.toContain(
      "Open from earlier runs",
    );
  });
});

describe("renderCleanupComment (R6)", () => {
  it("holds the marker, the title and each finding", () => {
    const a = finding("src/a.ts", 1, 2, { severity: "suggestion" });
    const text = renderCleanupComment([a]);
    expect(text).toContain(CLEANUP_MARKER);
    expect(text).toContain("Cleanup opportunities");
    expect(text).toContain(a.claim);
    expect(text).toContain("src/a.ts:1-2");
    expect(parseSeverity(text)).toBe("suggestion");
  });
});

describe("renderFailureBody (R5a)", () => {
  it("is the failed marker and one line with the stage and the message", () => {
    const marker: RunMarker = { ...MARKER, tier: "unknown", status: "failed" };
    const text = renderFailureBody(marker, "find_verify", "boom\nsecond line");
    const lines = text.split("\n");
    expect(lines[0]).toBe(formatRunMarker(marker));
    expect(lines[1]).toBe("pr-review failed at find_verify: boom second line");
    expect(lines).toHaveLength(2);
    expect(parseRunMarker(text)).toEqual(marker);
  });

  it("never holds a token", () => {
    const token = `ghp_${"Q7".repeat(18)}`;
    const text = renderFailureBody(
      { ...MARKER, status: "failed" },
      "post",
      `bad ${token} and github_pat_${"x1".repeat(20)}`,
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain("github_pat_x1");
  });
});
