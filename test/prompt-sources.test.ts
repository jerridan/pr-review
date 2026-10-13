import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { Role } from "../src/config/models.js";
import { runReviewers } from "../src/find/index.js";
import type { GatherResult } from "../src/gather/index.js";
import { loadPrompt, parseFrontmatter } from "../src/prompts/load.js";
import type { ReviewerDefinition } from "../src/reviewers/loader.js";
import { runReview } from "../src/run.js";
import type { Finding } from "../src/schemas/finding.js";
import type { TriageBrief } from "../src/schemas/triage.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";
import { createSemaphore } from "../src/semaphore.js";
import { runTriage } from "../src/triage/index.js";
import { DEFAULT_VERIFY_CONFIG, verifyFinding } from "../src/verify/index.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "src");
const PROMPTS = join(ROOT, "prompts");
const SCRIPT = join(ROOT, "scripts/make-fixture.sh");
const LIMIT = 200;

function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, ext);
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

// Each string literal and template in a source file, with its literal text.
function literals(file: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const out: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
    }
    if (text !== null) {
      out.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const MARK = "\u0000";
const BLOCK = /<([a-z][a-z0-9_]*_[0-9a-f]{16})>\n[\s\S]*?\n<\/\1>/g;
const TOKEN = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/g;

type PromptSources = { systems: Set<string>; templates: Set<string> };

function promptSources(): PromptSources {
  const systems = new Set<string>();
  const templates = new Set<string>();
  for (const file of listFiles(PROMPTS, ".md")) {
    const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const text = body.replace(/^(?:\r?\n)+/, "");
    if (frontmatter.kind === "user") templates.add(text.replace(TOKEN, MARK));
    else systems.add(text);
    if (typeof frontmatter.user_message === "string") {
      templates.add(frontmatter.user_message.replace(TOKEN, MARK));
    }
  }
  return { systems, templates };
}

describe("A13: no prompt text in src", () => {
  it(`has no string in src longer than ${LIMIT} characters`, () => {
    const long = listFiles(SRC, ".ts").flatMap((file) =>
      literals(file)
        .filter((l) => l.text.length > LIMIT)
        .map((l) => `${relative(ROOT, file)}:${l.line} (${l.text.length} characters)`),
    );
    expect(long).toEqual([]);
  });

  it("finds a long string when one exists, so the scan works", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-scan-"));
    try {
      const file = join(dir, "x.ts");
      const long = "a".repeat(LIMIT + 1);
      const text = `const a = "${long}";\nconst b = \`${long}\${a}\`;\n`;
      writeFileSync(file, text);
      expect(literals(file).filter((l) => l.text.length > LIMIT)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const META: QueryMeta = {
  model: "m",
  durationMs: 1,
  stopReason: "end_turn",
  subtype: "success",
  usage: {},
  costUsd: 0,
};

describe("A13: every query takes its prompts from the prompt files", () => {
  let fixture = "";
  const calls: QueryRequest[] = [];

  beforeAll(async () => {
    const { stdout } = await run("bash", [SCRIPT]);
    const value = (key: string) =>
      stdout
        .split("\n")
        .find((l) => l.startsWith(`${key}=`))
        ?.slice(key.length + 1) ?? "";
    fixture = value("FIXTURE");
    const [file, lineText] = value("PLANTED").split(":");
    const line = Number(lineText);
    const finding = (start: number, end: number, claim: string) => ({
      file,
      start_line: start,
      end_line: end,
      category: "bug",
      severity_estimate: "blocking",
      confidence: "high",
      claim,
      evidence: "for (let i = 0; i <= values.length; i++) {",
      explanation: "e",
      needs_context: false,
    });
    let verifierCalls = 0;
    const fake = createFakeSdkClient((req): QueryOutcome<unknown> => {
      const out = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
      switch (req.role) {
        case "triage":
          return out({
            tier: "full",
            reason: "r",
            confidence: "high",
            categories: ["bug"],
            hotspots: ["h"],
            file_notes: [],
            summary: "s",
          });
        case "reviewer":
          return out({ findings: [finding(line, line, "A"), finding(line - 1, line, "B")] });
        case "verifier":
          verifierCalls += 1;
          return out({
            in_scope: true,
            claim_holds: true,
            introduced_by_pr: true,
            quotes: ["i <= values.length"],
            rationale: "r",
            score: 70 + verifierCalls,
            severity: "blocking",
          });
        case "verifier-escalation":
          return out({
            in_scope: true,
            claim_holds: true,
            introduced_by_pr: true,
            quotes: ["i <= values.length"],
            rationale: "r",
            score: 90,
            severity: "blocking",
          });
        case "merge":
          return out({
            merged: [{ member_index: 0, claim: "merged", explanation: "e", severity: "blocking" }],
          });
        default:
          return out({ ok: true, word: "pong" });
      }
    });
    const outDir = mkdtempSync(join(tmpdir(), "pr-review-sources-"));
    try {
      await runReview({
        repo: fixture,
        base: value("BASE"),
        head: value("HEAD"),
        outDir,
        allowApiKey: false,
        client: fake,
      });
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await createProgram({ client: fake }).parseAsync(["node", "pr-review", "smoke"]);
      } finally {
        write.mockRestore();
        process.exitCode = undefined;
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
    calls.push(...fake.calls);
  }, 30_000);

  afterAll(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it("covers every role", () => {
    const roles: Role[] = [
      "triage",
      "reviewer",
      "verifier",
      "verifier-escalation",
      "merge",
      "smoke",
    ];
    expect(new Set(calls.map((c) => c.role))).toEqual(new Set(roles));
  });

  it("sends a system prompt that is the body of a prompt file", () => {
    const { systems } = promptSources();
    for (const call of calls) {
      expect(systems.has(call.systemPrompt), `${call.role} system prompt`).toBe(true);
    }
  });

  it("sends a user message that is a prompt-file template with only untrusted blocks put in", () => {
    const { templates } = promptSources();
    for (const call of calls) {
      const shape = call.userMessage.replace(BLOCK, MARK);
      expect(templates.has(shape), `${call.role} user message:\n${shape}`).toBe(true);
    }
  });
});

// The modules that build a user message. Model-facing text in them must
// come from a prompt file, also short text that goes inside a block.
const MESSAGE_BUILDERS = ["src/triage/index.ts", "src/find/index.ts", "src/verify/index.ts"];
// Two words, or a word with a colon after it, is text for a reader.
const PROSE = /[A-Za-z]+ [A-Za-z]+|[A-Za-z]:/;

// Properties whose text goes to the record and the user, not to a model.
const RECORD_TEXT_PROPERTIES = new Set(["message", "rejected"]);

// True when the node is in an Error message or in a record text property.
function inErrorText(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "Error") {
      return true;
    }
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      RECORD_TEXT_PROPERTIES.has(p.name.text)
    ) {
      return true;
    }
  }
  return false;
}

function proseLiterals(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
    }
    const isModulePath =
      node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent));
    if (text !== null && !isModulePath && PROSE.test(text) && !inErrorText(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      out.push(`${relative(ROOT, file)}:${line} ${JSON.stringify(text)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("A13: no model-facing text in the message builders", () => {
  it("has no prose string outside an error message", () => {
    const found = MESSAGE_BUILDERS.flatMap((file) => proseLiterals(join(ROOT, file)));
    expect(found).toEqual([]);
  });

  it("finds a placeholder and a list heading when they exist, so the scan works", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-prose-"));
    try {
      const file = join(dir, "x.ts");
      writeFileSync(
        file,
        [
          'import { a } from "./some module.js";',
          'const p = text === null ? "The head commit has no file at this path." : text;',
          'const h = ["Sensitive files:"];',
          "const t = `Summary: ${p}`;",
          'throw new Error("A bad prompt file.");',
          'const f = { kind: "thrown", message: "The query failed." };',
          'const r = { passed: false, rejected: "No quote is in the file." };',
          "",
        ].join("\n"),
      );
      expect(proseLiterals(file).map((l) => l.replace(/^.*?:\d+ /, ""))).toEqual([
        JSON.stringify("The head commit has no file at this path."),
        JSON.stringify("Sensitive files:"),
        JSON.stringify("Summary: "),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The text of each untrusted block in a message, by label.
function blocks(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of message.matchAll(
    /<([a-z][a-z0-9_]*)_[0-9a-f]{16}>\n([\s\S]*?)\n<\/\1_[0-9a-f]{16}>/g,
  )) {
    out.set(m[1] ?? "", m[2] ?? "");
  }
  return out;
}

function field(file: string, name: string): string {
  const value = loadPrompt(file).frontmatter[name];
  expect(typeof value, `${file} frontmatter "${name}"`).toBe("string");
  return value as string;
}

// Remove each data value, then each fixed part of each prompt-file
// template. Only whitespace must stay: all other text came from TypeScript.
function leftover(body: string, data: string[], templates: string[]): string {
  let rest = body;
  const remove = (part: string) => {
    if (part.trim() !== "") rest = rest.split(part).join("\n");
  };
  for (const value of [...data].sort((a, b) => b.length - a.length)) remove(value);
  const parts = templates.flatMap((t) => t.split(TOKEN));
  for (const part of parts.sort((a, b) => b.length - a.length)) remove(part);
  return rest.trim();
}

describe("A13: placeholder and list text in a block comes from the prompt files", () => {
  const head = mkdtempSync(join(tmpdir(), "pr-review-placeholders-"));
  writeFileSync(join(head, "a.ts"), "const a = 1;\n");
  afterAll(() => rmSync(head, { recursive: true, force: true }));

  const ok = (output: unknown): QueryOutcome<unknown> => ({ ok: true, output, raw: META });
  const gathered: GatherResult = {
    base: "a".repeat(40),
    head: "b".repeat(40),
    changedFiles: [
      { path: "a.ts", hunks: 3 },
      { path: "ci.yml", hunks: 1 },
    ],
    excluded: [{ path: "package-lock.json", reason: "generated" }],
    sensitive: ["ci.yml"],
    diff: "diff --git a/a.ts b/a.ts\n+const a = 1;\n",
    totalHunks: 4,
  };

  it("verifier: the text for a missing head file and for a file with no diff", async () => {
    const fake = createFakeSdkClient(() =>
      ok({
        in_scope: false,
        claim_holds: false,
        introduced_by_pr: false,
        quotes: [],
        rationale: "r",
        score: 0,
        severity: "nit",
      }),
    );
    const finding: Finding = {
      file: "missing.ts",
      start_line: 1,
      end_line: 1,
      category: "bug",
      severity_estimate: "nit",
      confidence: "low",
      claim: "c",
      evidence: "e",
      explanation: "x",
      needs_context: false,
    };
    await verifyFinding(fake, { allowApiKey: false, env: {} }, finding, {
      cwd: head,
      diff: gathered.diff,
      semaphore: createSemaphore(1),
      config: DEFAULT_VERIFY_CONFIG,
    });
    const found = blocks(fake.calls[0]?.userMessage ?? "");
    expect(found.get("head_file")).toBe(field("verifier.md", "no_file_text").trim());
    expect(found.get("diff")).toBe(field("verifier.md", "no_diff_text").trim());
  });

  function reviewerDef(): ReviewerDefinition {
    return {
      path: "/x/r.md",
      systemPrompt: "s",
      frontmatter: {
        name: "r",
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

  async function briefBlock(brief: TriageBrief | null): Promise<string> {
    const fake = createFakeSdkClient(() => ok({ findings: [] }));
    await runReviewers(
      fake,
      { allowApiKey: false, env: {} },
      [{ def: reviewerDef(), trigger: "t" }],
      { gathered, brief, cwd: head, semaphore: createSemaphore(1) },
      () => {},
    );
    return blocks(fake.calls[0]?.userMessage ?? "").get("triage_brief") ?? "";
  }

  it("reviewer: the text for no brief, and the brief headings and list lines", async () => {
    expect(await briefBlock(null)).toBe(field("reviewer-user.md", "no_brief_text").trim());

    const templates = ["brief_text", "hotspot_line", "empty_list_text"].map((name) =>
      field("reviewer-user.md", name),
    );
    const brief: TriageBrief = {
      tier: "full",
      reason: "r",
      confidence: "high",
      categories: ["bug"],
      hotspots: ["HOTSPOT-one", "HOTSPOT-two"],
      file_notes: [],
      summary: "SUMMARY-text",
    };
    const full = await briefBlock(brief);
    expect(full).toContain("SUMMARY-text");
    expect(leftover(full, ["SUMMARY-text", "HOTSPOT-one", "HOTSPOT-two"], templates)).toBe("");
    const empty = await briefBlock({ ...brief, hotspots: [] });
    expect(empty).toContain(field("reviewer-user.md", "empty_list_text").trim());
    expect(leftover(empty, ["SUMMARY-text"], templates)).toBe("");
  });

  it("triage: the list headings and list lines of the files block", async () => {
    const fake = createFakeSdkClient(() =>
      ok({
        tier: "full",
        reason: "r",
        confidence: "high",
        categories: [],
        hotspots: [],
        file_notes: [],
        summary: "s",
      }),
    );
    const templates = [
      "files_text",
      "changed_file_line",
      "file_line",
      "excluded_file_line",
      "empty_list_text",
    ].map((name) => field("triage.md", name));
    const options = { allowApiKey: false, env: {} };
    await runTriage(fake, options, gathered, head);
    await runTriage(fake, options, { ...gathered, sensitive: [], excluded: [] }, head);
    const [full, empty] = fake.calls.map((c) => blocks(c.userMessage).get("files") ?? "");
    expect(full).toContain("package-lock.json");
    expect(
      leftover(
        full ?? "",
        ["a.ts", "ci.yml", "3", "1", "package-lock.json", "generated"],
        templates,
      ),
    ).toBe("");
    expect(empty).toContain(field("triage.md", "empty_list_text").trim());
    expect(leftover(empty ?? "", ["a.ts", "ci.yml", "3", "1"], templates)).toBe("");
  });
});
