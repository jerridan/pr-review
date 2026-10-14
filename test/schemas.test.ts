import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../src/config/repo-config.js";
import { z } from "zod";
import { SmokeOutputSchema } from "../src/cli.js";
import type { Role } from "../src/config/models.js";
import { FindingSchema, FindingsOutputSchema } from "../src/schemas/finding.js";
import { FORBIDDEN_SCHEMA_KEYWORDS, toSdkJsonSchema } from "../src/schemas/json-schema.js";
import { MergeOutputSchema } from "../src/schemas/merge.js";
import { RecordSchema, type RunRecord } from "../src/schemas/record.js";
import { ReviewerFrontmatterSchema } from "../src/schemas/reviewer.js";
import { TriageBriefSchema } from "../src/schemas/triage.js";
import { VerifierResultSchema, type VerifierResult } from "../src/schemas/verifier.js";

// The output schema that each role sends to the SDK.
const ROLE_SCHEMAS: Record<Role, z.ZodType> = {
  triage: TriageBriefSchema,
  reviewer: FindingsOutputSchema,
  verifier: VerifierResultSchema,
  "verifier-escalation": VerifierResultSchema,
  merge: MergeOutputSchema,
  smoke: SmokeOutputSchema,
};

// The keywords that the spec forbids. "$ref" shows recursion.
const SPEC_FORBIDDEN = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "maxItems",
  "$ref",
];

type Violation = { path: string; problem: string };

// Walk a JSON Schema and collect each forbidden keyword and each object
// without "additionalProperties: false". This walk is independent of the
// check in src, so the test does not trust the code under test.
function findViolations(node: unknown, path = "#"): Violation[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => findViolations(item, `${path}/${i}`));
  }
  if (node === null || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  const out: Violation[] = [];
  for (const key of SPEC_FORBIDDEN) {
    if (key in obj) out.push({ path, problem: `has ${key}` });
  }
  if (typeof obj.minItems === "number" && obj.minItems > 1) {
    out.push({ path, problem: "has minItems above 1" });
  }
  if (obj.type === "object" && obj.additionalProperties !== false) {
    out.push({ path, problem: "object without additionalProperties false" });
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, sub] of Object.entries(value)) {
        out.push(...findViolations(sub, `${path}/properties/${name}`));
      }
    } else if (typeof value === "object") {
      out.push(...findViolations(value, `${path}/${key}`));
    }
  }
  return out;
}

const finding = {
  file: "src/a.ts",
  start_line: 3,
  end_line: 5,
  category: "bug",
  severity_estimate: "blocking",
  confidence: "high",
  claim: "The loop skips the last item.",
  evidence: "for (let i = 0; i < n - 1; i++)",
  explanation: "The bound is one short.",
  needs_context: false,
} as const;

const verifierResult: VerifierResult = {
  in_scope: true,
  claim_holds: true,
  introduced_by_pr: true,
  quotes: ["i < n - 1"],
  rationale: "The bound is wrong.",
  score: 90,
  severity: "blocking",
};

function makeRecord(): RunRecord {
  return {
    identity: {
      repo: "/tmp/repo",
      pr: null,
      github: null,
      base: "a".repeat(40),
      head: "b".repeat(40),
      started_at: "2026-10-13T12:00:00.000Z",
      tool_version: "0.1.0",
      config_hash: null,
      config: { files: [], values: DEFAULT_REPO_CONFIG, custom_reviewers: [] },
      description: "Fix the loop bound.",
      description_meta: { source: "commits", sanitized: false, truncated: false },
      history: { built: true, truncated: false },
      injected: [{ path: "CLAUDE.md", truncated: false }],
      changed_files: [{ path: "src/a.ts", hunks: 1 }],
      excluded_files: [{ path: "package-lock.json", reason: "generated" }],
      sensitive_files: [],
      triage: {
        tier: "full",
        reason: "Logic change.",
        confidence: "high",
        categories: ["bug"],
        hotspots: ["src/a.ts"],
        file_notes: [{ file: "src/a.ts", note: "Loop bound." }],
        summary: "Changes a loop.",
      },
      tier: "full",
      tier_reason: "triage",
      selected_reviewers: [
        {
          name: "diff-bugs",
          trigger: "always",
          model: "claude-opus-5-5",
          effort: "low",
          tools_ignored: [],
        },
      ],
      models: {
        triage: { model: "claude-sonnet-5-5", effort: "medium" },
        reviewer: { model: "claude-opus-5-5", effort: "low" },
        verifier: { model: "claude-sonnet-5-5", effort: "high" },
        "verifier-escalation": { model: "claude-opus-5-5", effort: "high" },
        merge: { model: "claude-sonnet-5-5", effort: "medium" },
        smoke: { model: "claude-sonnet-5-5", effort: "low" },
      },
    },
    stages: {
      reviewers: [
        {
          name: "diff-bugs",
          pass: 1,
          status: "ok",
          findings: [finding],
          dropped: [],
          meta: {
            model: "claude-opus-5-5",
            durationMs: 1000,
            stopReason: "end_turn",
            subtype: "success",
            usage: {},
            costUsd: 0.1,
          },
        },
      ],
      verifications: [
        { finding, first: verifierResult, final: verifierResult, passed: true },
        {
          finding,
          first: { kind: "thrown", message: "boom" },
          final: null,
          passed: false,
        },
        {
          finding,
          first: { ...verifierResult, quotes: [] },
          final: { ...verifierResult, quotes: [] },
          passed: false,
          rejected: "No quote of the verifier is in the head file.",
        },
      ],
      merges: [],
      capped: [],
      suppressed: [],
    },
    posted: {
      verdict: "would request changes",
      coverage: {
        reviewers_ran: ["diff-bugs"],
        reviewers_failed: [],
        reviewers_skipped: [],
        reviewers_without_bash: [],
        sensitive_without_hunks: [],
        findings_dropped_by_failed_verifier: 1,
      },
      findings: [
        {
          ...finding,
          fingerprint: "abc123",
          severity: "blocking",
          score: 90,
          verifier: verifierResult,
        },
      ],
    },
    cost: {
      queries: [
        {
          role: "reviewer",
          reviewer: "diff-bugs",
          model: "claude-opus-5-5",
          duration_ms: 1000,
          stop_reason: "end_turn",
          subtype: "success",
          usage: {},
          cost_usd: 0.1,
        },
      ],
      total_cost_usd: 0.1,
      queries_without_cost: 0,
      stage_ms: { gather: 10 },
      errors: [],
    },
  };
}

describe("A13: generated JSON Schema of every role", () => {
  for (const [role, schema] of Object.entries(ROLE_SCHEMAS)) {
    it(`${role}: holds no forbidden keyword and every object is closed`, () => {
      const json = toSdkJsonSchema(schema);
      expect(json.type).toBe("object");
      expect(findViolations(json)).toEqual([]);
    });
  }

  it("names every keyword that the spec forbids", () => {
    for (const key of SPEC_FORBIDDEN) {
      expect(FORBIDDEN_SCHEMA_KEYWORDS).toContain(key);
    }
  });

  it("emits draft-07", () => {
    expect(toSdkJsonSchema(FindingsOutputSchema).$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
  });

  it("emits integers without range keywords", () => {
    const json = toSdkJsonSchema(VerifierResultSchema) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(json.properties.score).toEqual({ type: "integer" });
  });
});

describe("toSdkJsonSchema rejects a bad schema", () => {
  const bad: [string, z.ZodType][] = [
    ["minLength", z.strictObject({ a: z.string().min(2) })],
    ["maxLength", z.strictObject({ a: z.string().max(2) })],
    ["minimum", z.strictObject({ a: z.number().min(0) })],
    ["maximum", z.strictObject({ a: z.number().max(9) })],
    ["maxItems", z.strictObject({ a: z.array(z.string()).max(3) })],
    ["minItems", z.strictObject({ a: z.array(z.string()).min(2) })],
    ["additionalProperties", z.looseObject({ a: z.string() })],
  ];
  for (const [label, schema] of bad) {
    it(`throws on ${label}`, () => {
      expect(() => toSdkJsonSchema(schema)).toThrow(label);
    });
  }

  it("throws on recursion", () => {
    const Node: z.ZodType = z.strictObject({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
    });
    expect(() => toSdkJsonSchema(Node)).toThrow("$ref");
  });

  it("accepts minItems of 1", () => {
    expect(() => toSdkJsonSchema(z.strictObject({ a: z.array(z.string()).min(1) }))).not.toThrow();
  });
});

describe("schemas parse in code", () => {
  it("compares enum values case-insensitively", () => {
    const parsed = FindingSchema.parse({
      ...finding,
      category: "BUG",
      severity_estimate: "Blocking",
      confidence: "HIGH",
    });
    expect(parsed.category).toBe("bug");
    expect(parsed.severity_estimate).toBe("blocking");
    expect(parsed.confidence).toBe("high");
    expect(TriageBriefSchema.parse(makeRecord().identity.triage).tier).toBe("full");
    expect(VerifierResultSchema.parse({ ...verifierResult, severity: "NIT" }).severity).toBe("nit");
  });

  it("keeps suggested_fix optional", () => {
    expect(FindingSchema.parse(finding).suggested_fix).toBeUndefined();
    expect(FindingSchema.parse({ ...finding, suggested_fix: "Use i < n." }).suggested_fix).toBe(
      "Use i < n.",
    );
  });

  it("rejects an unknown key, a bad enum and a non-integer line", () => {
    expect(FindingSchema.safeParse({ ...finding, extra: 1 }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding, category: "style" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding, start_line: 1.5 }).success).toBe(false);
  });

  it("leaves numeric range checks to the code that uses the result", () => {
    expect(VerifierResultSchema.safeParse({ ...verifierResult, score: 150 }).success).toBe(true);
    expect(VerifierResultSchema.safeParse({ ...verifierResult, score: 80.5 }).success).toBe(false);
  });

  it("parses merge output with an optional suggested_fix", () => {
    const out = MergeOutputSchema.parse({
      merged: [{ member_index: 0, claim: "c", explanation: "e", severity: "SUGGESTION" }],
    });
    expect(out.merged[0]?.severity).toBe("suggestion");
  });
});

describe("ReviewerFrontmatterSchema", () => {
  const fm = {
    name: "diff-bugs",
    description: "Finds bugs in the diff.",
    model: "opus",
    effort: "low",
    tools: ["Read", "Grep", "Glob"],
    triggers: { paths: [], categories: [], min_tier: "fast" },
    passes: 1,
    threshold: 80,
    trusted: false,
  };

  it("parses a valid file", () => {
    expect(ReviewerFrontmatterSchema.parse(fm)).toEqual(fm);
    expect(ReviewerFrontmatterSchema.parse({ ...fm, effort: "HIGH" }).effort).toBe("high");
  });

  it("checks passes and threshold in code", () => {
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, passes: 0 }).success).toBe(false);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, passes: 1.5 }).success).toBe(false);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, passes: 3 }).success).toBe(true);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, threshold: -1 }).success).toBe(false);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, threshold: 101 }).success).toBe(false);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, threshold: 0 }).success).toBe(true);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, threshold: 100 }).success).toBe(true);
  });

  it("rejects a missing field, a bad enum and an unknown key", () => {
    const { name: _name, ...noName } = fm;
    expect(ReviewerFrontmatterSchema.safeParse(noName).success).toBe(false);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, effort: "huge" }).success).toBe(false);
    expect(
      ReviewerFrontmatterSchema.safeParse({ ...fm, triggers: { ...fm.triggers, min_tier: "skip" } })
        .success,
    ).toBe(false);
    expect(ReviewerFrontmatterSchema.safeParse({ ...fm, colour: "red" }).success).toBe(false);
  });
});

describe("RecordSchema", () => {
  it("validates a full record", () => {
    const result = RecordSchema.safeParse(makeRecord());
    expect(result.error).toBeUndefined();
  });

  it("fails when a required part is missing", () => {
    for (const part of ["identity", "stages", "posted", "cost"] as const) {
      const record: Partial<RunRecord> = makeRecord();
      delete record[part];
      expect(RecordSchema.safeParse(record).success).toBe(false);
    }
  });

  it("takes pr as null or a number (R2), and config_hash as null or a hex SHA-256", () => {
    const record = makeRecord();
    const withPr = (pr: unknown) =>
      RecordSchema.safeParse({ ...record, identity: { ...record.identity, pr } }).success;
    expect(withPr(12)).toBe(true);
    expect(withPr(null)).toBe(true);
    expect(withPr("12")).toBe(false);
    expect(withPr(0)).toBe(false);
    expect(withPr(1.5)).toBe(false);
    expect(
      RecordSchema.safeParse({ ...record, identity: { ...record.identity, config_hash: "x" } })
        .success,
    ).toBe(false);
    expect(
      RecordSchema.safeParse({
        ...record,
        identity: { ...record.identity, config_hash: "a".repeat(64) },
      }).success,
    ).toBe(true);
  });

  it("requires identity.config with the files, the validated values and the custom reviewers", () => {
    const record = makeRecord();
    const withConfig = (config: unknown) =>
      RecordSchema.safeParse({ ...record, identity: { ...record.identity, config } }).success;
    expect(withConfig(record.identity.config)).toBe(true);
    expect(
      withConfig({
        files: [".pr-review/config.yaml"],
        values: DEFAULT_REPO_CONFIG,
        custom_reviewers: [{ name: "m", bash_granted: false, reason: "not trusted" }],
      }),
    ).toBe(true);
    expect(withConfig(undefined)).toBe(false);
    expect(withConfig({ files: [], custom_reviewers: [] })).toBe(false);
    expect(
      withConfig({
        files: [],
        values: { ...DEFAULT_REPO_CONFIG, colour: 1 },
        custom_reviewers: [],
      }),
    ).toBe(false);
    expect(
      withConfig({ files: [], values: DEFAULT_REPO_CONFIG, custom_reviewers: [], hash: "x" }),
    ).toBe(false);
  });

  it("takes identity.github as null or the strict PR object (R2)", () => {
    const record = makeRecord();
    const github = {
      slug: "acme/widgets",
      title: "Add average",
      draft: false,
      labels: ["review:full"],
      author: "alice",
      author_type: "User",
      author_write_access: true,
      fork: false,
      head_repo: "acme/widgets",
      url: "https://github.com/acme/widgets/pull/7",
    };
    const withGithub = (value: unknown) =>
      RecordSchema.safeParse({ ...record, identity: { ...record.identity, pr: 7, github: value } })
        .success;
    expect(withGithub(github)).toBe(true);
    expect(withGithub(null)).toBe(true);
    expect(withGithub({ ...github, extra: 1 })).toBe(false);
    const { fork: _fork, ...noFork } = github;
    expect(withGithub(noFork)).toBe(false);
    expect(withGithub(undefined)).toBe(false);
  });

  it("requires identity.description_meta with the source and the two flags (R3)", () => {
    const record = makeRecord();
    const withMeta = (value: unknown) =>
      RecordSchema.safeParse({
        ...record,
        identity: { ...record.identity, description_meta: value },
      }).success;
    expect(withMeta({ source: "pr", sanitized: true, truncated: true })).toBe(true);
    expect(withMeta({ source: "commits", sanitized: false, truncated: false })).toBe(true);
    expect(withMeta({ source: "issue", sanitized: false, truncated: false })).toBe(false);
    expect(withMeta({ source: "pr", sanitized: false })).toBe(false);
    expect(withMeta({ source: "pr", sanitized: false, truncated: false, x: 1 })).toBe(false);
    expect(withMeta(undefined)).toBe(false);
  });

  it("requires the description, the history flags and the injected files", () => {
    const record = makeRecord();
    const withIdentity = (patch: Record<string, unknown>) =>
      RecordSchema.safeParse({ ...record, identity: { ...record.identity, ...patch } }).success;
    expect(withIdentity({ description: "", history: { built: false, truncated: false } })).toBe(
      true,
    );
    expect(withIdentity({ injected: [] })).toBe(true);
    expect(withIdentity({ description: undefined })).toBe(false);
    expect(withIdentity({ history: { built: true } })).toBe(false);
    expect(withIdentity({ history: { built: true, truncated: false, bytes: 1 } })).toBe(false);
    expect(withIdentity({ injected: [{ path: "CLAUDE.md" }] })).toBe(false);
    expect(withIdentity({ injected: undefined })).toBe(false);
  });

  it("requires coverage.reviewers_without_bash, each with a name and a reason", () => {
    const record = makeRecord();
    const withList = (list: unknown) =>
      RecordSchema.safeParse({
        ...record,
        posted: {
          ...record.posted,
          coverage: { ...record.posted.coverage, reviewers_without_bash: list },
        },
      }).success;
    expect(withList([{ name: "shell-check", reason: "not trusted" }])).toBe(true);
    expect(withList([{ name: "shell-check" }])).toBe(false);
    expect(withList([{ name: "shell-check", reason: "r", extra: 1 }])).toBe(false);
    expect(withList(undefined)).toBe(false);
  });

  it("requires coverage.reviewers_skipped, with a known reason", () => {
    const record = makeRecord();
    const withSkipped = (skipped: unknown) =>
      RecordSchema.safeParse({
        ...record,
        posted: {
          ...record.posted,
          coverage: { ...record.posted.coverage, reviewers_skipped: skipped },
        },
      }).success;
    expect(withSkipped([{ name: "diff-bugs", reason: "disabled by config" }])).toBe(true);
    expect(withSkipped([{ name: "diff-bugs", reason: "token ceiling", pass: 2 }])).toBe(true);
    expect(withSkipped([{ name: "description-drift", reason: "no description" }])).toBe(true);
    expect(withSkipped([{ name: "diff-bugs", reason: "bored" }])).toBe(false);
    expect(withSkipped(undefined)).toBe(false);
  });

  it("requires coverage.sensitive_without_hunks, a list of paths", () => {
    const record = makeRecord();
    const withList = (list: unknown) =>
      RecordSchema.safeParse({
        ...record,
        posted: {
          ...record.posted,
          coverage: { ...record.posted.coverage, sensitive_without_hunks: list },
        },
      }).success;
    expect(withList([])).toBe(true);
    expect(withList([".github/workflows/ci.yml"])).toBe(true);
    expect(withList([1])).toBe(false);
    expect(withList(undefined)).toBe(false);
  });

  it("requires stages.suppressed, each item with a finding, a reviewer and a rule", () => {
    const record = makeRecord();
    const withList = (list: unknown) =>
      RecordSchema.safeParse({ ...record, stages: { ...record.stages, suppressed: list } }).success;
    const rule = { category: "convention", path: "docs/**", reason: "drafts" };
    expect(withList([{ finding, reviewer: "conventions", rule }])).toBe(true);
    expect(
      withList([{ finding, reviewer: "conventions", rule: { reviewer: "a", reason: "r" } }]),
    ).toBe(true);
    expect(withList([{ finding, reviewer: "conventions" }])).toBe(false);
    expect(withList([{ reviewer: "conventions", rule }])).toBe(false);
    expect(withList([{ finding, reviewer: "conventions", rule: { reviewer: "a" } }])).toBe(false);
    expect(withList([{ finding, reviewer: "conventions", rule: { ...rule, extra: 1 } }])).toBe(
      false,
    );
    expect(withList([{ finding, reviewer: "conventions", rule, extra: 1 }])).toBe(false);
    expect(withList(undefined)).toBe(false);
  });

  it("requires the resolved model and effort of each selected reviewer", () => {
    const record = makeRecord();
    const entry = { name: "diff-bugs", trigger: "always" };
    expect(
      RecordSchema.safeParse({
        ...record,
        identity: { ...record.identity, selected_reviewers: [entry] },
      }).success,
    ).toBe(false);
    expect(
      RecordSchema.safeParse({
        ...record,
        identity: {
          ...record.identity,
          selected_reviewers: [{ ...entry, model: "claude-sonnet-5-5", effort: "huge" }],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts the failure kind timeout", () => {
    const record = makeRecord();
    const stages = {
      ...record.stages,
      verifications: [
        { finding, first: { kind: "timeout", message: "x" }, final: null, passed: false },
      ],
    };
    expect(RecordSchema.safeParse({ ...record, stages }).error).toBeUndefined();
  });

  it("requires an integer count of the queries without a cost", () => {
    const record = makeRecord();
    const { queries_without_cost: _count, ...rest } = record.cost;
    expect(RecordSchema.safeParse({ ...record, cost: rest }).success).toBe(false);
    expect(
      RecordSchema.safeParse({ ...record, cost: { ...record.cost, queries_without_cost: 1.5 } })
        .success,
    ).toBe(false);
    expect(
      RecordSchema.safeParse({ ...record, cost: { ...record.cost, queries_without_cost: 2 } })
        .success,
    ).toBe(true);
  });

  it("requires the ignored tools of each selected reviewer", () => {
    const record = makeRecord();
    const entry = { name: "r", trigger: "t", model: "claude-opus-5-5", effort: "low" };
    expect(
      RecordSchema.safeParse({
        ...record,
        identity: { ...record.identity, selected_reviewers: [entry] },
      }).success,
    ).toBe(false);
    expect(
      RecordSchema.safeParse({
        ...record,
        identity: {
          ...record.identity,
          selected_reviewers: [{ ...entry, tools_ignored: ["Bash"] }],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown verdict and an unknown failure kind", () => {
    const record = makeRecord();
    expect(
      RecordSchema.safeParse({ ...record, posted: { ...record.posted, verdict: "approve" } })
        .success,
    ).toBe(false);
    const stages = {
      ...record.stages,
      verifications: [
        { finding, first: { kind: "oops", message: "x" }, final: null, passed: false },
      ],
    };
    expect(RecordSchema.safeParse({ ...record, stages }).success).toBe(false);
  });
});
