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
import { parseFrontmatter } from "../src/prompts/load.js";
import { runReview } from "../src/run.js";
import type { QueryMeta, QueryOutcome, QueryRequest } from "../src/sdk/client.js";
import { createFakeSdkClient } from "../src/sdk/fake.js";

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
            quotes: [],
            rationale: "r",
            score: 70 + verifierCalls,
            severity: "blocking",
          });
        case "verifier-escalation":
          return out({
            in_scope: true,
            claim_holds: true,
            introduced_by_pr: true,
            quotes: [],
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
