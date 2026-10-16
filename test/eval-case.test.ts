import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseError, casesRef, loadCases, type Case, type CaseSource } from "../src/eval/case.js";
import { cloneCase } from "../src/eval/checkout.js";

const run = promisify(execFile);
const FIXTURE_SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.sh", import.meta.url));

type Fixture = { repo: string; base: string; head: string; file: string; line: number };

async function makeFixture(): Promise<Fixture> {
  const { stdout } = await run("bash", [FIXTURE_SCRIPT]);
  const value = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? "";
  const [file, line] = value("PLANTED").split(":");
  return {
    repo: value("FIXTURE"),
    base: value("BASE"),
    head: value("HEAD"),
    file: file ?? "",
    line: Number(line),
  };
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args]);
  return stdout.trim();
}

let fixture: Fixture;
let work: string;
// A bundle that holds base and head, and a bundle that holds head only.
let fullBundle: string;
let headOnlyBundle: string;

beforeAll(async () => {
  fixture = await makeFixture();
  work = mkdtempSync(join(tmpdir(), "pr-review-eval-case-"));
  fullBundle = join(work, "full.bundle");
  headOnlyBundle = join(work, "head-only.bundle");
  // In the fixture, "main" is at base and "feature" is at head. The base
  // commit comes after the fork, so the history of head does not hold it.
  await git(fixture.repo, ["bundle", "create", "--quiet", fullBundle, "main", "feature"]);
  await git(fixture.repo, ["bundle", "create", "--quiet", headOnlyBundle, "feature"]);
}, 30_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(fixture.repo, { recursive: true, force: true });
});

function validMeta(name: string): Record<string, unknown> {
  return {
    name,
    source: "fixture",
    base: fixture.base,
    head: fixture.head,
    title: "Add average",
    body: "Adds a mean helper.",
    origin: "scripts/make-fixture.sh",
    language: "typescript",
  };
}

function validGolden(): { findings: Record<string, unknown>[] } {
  return {
    findings: [
      {
        file: fixture.file,
        start_line: fixture.line,
        end_line: fixture.line,
        category: "bug",
        severity: "blocking",
        claim: "The loop reads one element past the end of the list.",
      },
    ],
  };
}

type CaseParts = {
  meta?: Record<string, unknown>;
  golden?: unknown;
  bundle?: string;
  omit?: string[];
};

let dirCount = 0;
/** Make a new cases directory in the work directory. */
function newCasesDir(): string {
  dirCount += 1;
  const dir = join(work, `cases-${dirCount}`);
  mkdirSync(dir);
  return dir;
}

/** Write one case directory. The parts not given are valid. */
function writeCase(root: string, name: string, parts: CaseParts = {}): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const omit = parts.omit ?? [];
  if (!omit.includes("case.json")) {
    writeFileSync(join(dir, "case.json"), JSON.stringify(parts.meta ?? validMeta(name)));
  }
  if (!omit.includes("golden.json")) {
    writeFileSync(join(dir, "golden.json"), JSON.stringify(parts.golden ?? validGolden()));
  }
  if (!omit.includes("diff.patch")) {
    writeFileSync(join(dir, "diff.patch"), "diff --git a/src/stats.ts b/src/stats.ts\n");
  }
  if (!omit.includes("repo.bundle")) {
    copyFileSync(parts.bundle ?? fullBundle, join(dir, "repo.bundle"));
  }
  return dir;
}

async function rejection(promise: Promise<unknown>): Promise<CaseError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CaseError);
  return err as CaseError;
}

describe("loadCases", () => {
  it("gives the metadata and the golden findings of a valid case", async () => {
    const root = newCasesDir();
    const dir = writeCase(root, "fixture-off-by-one");
    const cases = await loadCases(root);
    const expected: Case = {
      dir,
      name: "fixture-off-by-one",
      source: "fixture",
      base: fixture.base,
      head: fixture.head,
      title: "Add average",
      body: "Adds a mean helper.",
      origin: "scripts/make-fixture.sh",
      language: "typescript",
      golden: [
        {
          file: fixture.file,
          start_line: fixture.line,
          end_line: fixture.line,
          category: "bug",
          severity: "blocking",
          claim: "The loop reads one element past the end of the list.",
        },
      ],
    };
    expect(cases).toEqual([expected]);
  });

  it("keeps the note of a golden finding", async () => {
    const root = newCasesDir();
    const golden = validGolden();
    golden.findings[0] = { ...golden.findings[0], note: "Confirmed by the principal." };
    writeCase(root, "noted", { golden });
    const [loaded] = await loadCases(root);
    expect(loaded?.golden[0]?.note).toBe("Confirmed by the principal.");
  });

  // R1.1
  it.each(["repo.bundle", "diff.patch", "golden.json"])(
    "rejects a case without %s and names the case and the file",
    async (file) => {
      const root = newCasesDir();
      writeCase(root, "missing-file", { omit: [file] });
      const err = await rejection(loadCases(root));
      expect(err.caseName).toBe("missing-file");
      expect(err.message).toContain("missing-file");
      expect(err.message).toContain(file);
    },
  );

  // R1.2
  it.each<[string, (meta: Record<string, unknown>) => void]>([
    ["a missing field", (meta) => delete meta.title],
    ["a wrong type", (meta) => (meta.base = 42)],
    ["a source outside the six values", (meta) => (meta.source = "github")],
    ["a name unequal to the directory name", (meta) => (meta.name = "other-name")],
  ])("rejects case.json with %s and names the case", async (_label, change) => {
    const root = newCasesDir();
    const meta = validMeta("bad-meta");
    change(meta);
    writeCase(root, "bad-meta", { meta });
    const err = await rejection(loadCases(root));
    expect(err.caseName).toBe("bad-meta");
    expect(err.message).toContain("bad-meta");
    expect(err.message).toContain("case.json");
  });

  it("rejects case.json that is not JSON and names the case", async () => {
    const root = newCasesDir();
    const dir = writeCase(root, "not-json");
    writeFileSync(join(dir, "case.json"), "{ name: ");
    const err = await rejection(loadCases(root));
    expect(err.caseName).toBe("not-json");
    expect(err.message).toContain("case.json");
  });

  // R1.3
  it.each<CaseSource>(["fixture", "pr", "reviewbench", "martian", "injection", "record"])(
    "loads a case with the source %s",
    async (source) => {
      const root = newCasesDir();
      writeCase(root, `source-${source}`, { meta: { ...validMeta(`source-${source}`), source } });
      const [loaded] = await loadCases(root);
      expect(loaded?.source).toBe(source);
    },
  );

  // R1.5
  it.each<[string, Record<string, unknown>]>([
    ["an unknown category", { category: "style" }],
    ["an unknown severity", { severity: "critical" }],
    ["a start_line below 1", { start_line: 0, end_line: 0 }],
    ["an end_line below start_line", { start_line: 5, end_line: 4 }],
  ])("rejects golden.json with %s and names the case", async (_label, change) => {
    const root = newCasesDir();
    const golden = validGolden();
    golden.findings[0] = { ...golden.findings[0], ...change };
    writeCase(root, "bad-golden", { golden });
    const err = await rejection(loadCases(root));
    expect(err.caseName).toBe("bad-golden");
    expect(err.message).toContain("bad-golden");
    expect(err.message).toContain("golden.json");
  });

  // R1.9
  it("reads only the subdirectories with case.json, in name order", async () => {
    const root = newCasesDir();
    writeCase(root, "b-case");
    writeCase(root, "a-case");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "README.md"), "Not a case.\n");
    writeFileSync(join(root, "README.md"), "How to add a case.\n");
    const cases = await loadCases(root);
    expect(cases.map((c) => c.name)).toEqual(["a-case", "b-case"]);
  });

  it("rejects a cases directory that holds no case, with no case name", async () => {
    const root = newCasesDir();
    const err = await rejection(loadCases(root));
    expect(err.caseName).toBeNull();
    expect(err.message).toContain(root);
  });

  it("rejects a cases directory that does not exist, with no case name", async () => {
    const err = await rejection(loadCases(join(work, "no-such-dir")));
    expect(err.caseName).toBeNull();
  });
});

describe("cloneCase", () => {
  async function loadOne(name: string, parts: CaseParts = {}): Promise<Case> {
    const root = newCasesDir();
    writeCase(root, name, parts);
    const [loaded] = await loadCases(root);
    if (!loaded) throw new Error("no case loaded");
    return loaded;
  }

  it("gives a checkout with head checked out detached and base present", async () => {
    const c = await loadOne("clone-ok");
    const path = await cloneCase(c, join(work, "clone-ok"));
    expect(await git(path, ["rev-parse", "HEAD"])).toBe(fixture.head);
    expect(await git(path, ["rev-parse", "--verify", `${fixture.base}^{commit}`])).toBe(
      fixture.base,
    );
    expect(await git(path, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe(
      "detached",
    );
    const planted = readFileSync(join(path, fixture.file), "utf8").split("\n")[fixture.line - 1];
    expect(planted).toContain("i <= values.length");
  });

  // R1.8
  it("rejects a bundle that lacks base, and names the case and the sha", async () => {
    const c = await loadOne("no-base", { bundle: headOnlyBundle });
    const err = await rejection(cloneCase(c, join(work, "no-base")));
    expect(err.caseName).toBe("no-base");
    expect(err.message).toContain("no-base");
    expect(err.message).toContain(fixture.base);
  });

  it("rejects a repo.bundle that is not a bundle, and names the case", async () => {
    const root = newCasesDir();
    const dir = writeCase(root, "not-a-bundle");
    writeFileSync(join(dir, "repo.bundle"), "not a bundle\n");
    const [c] = await loadCases(root);
    if (!c) throw new Error("no case loaded");
    const err = await rejection(cloneCase(c, join(work, "not-a-bundle")));
    expect(err.caseName).toBe("not-a-bundle");
    expect(err.message).toContain("repo.bundle");
  });
});

describe("casesRef", () => {
  it("gives the HEAD sha for the top level of a git work tree", async () => {
    expect(await casesRef(fixture.repo)).toBe(fixture.head);
  });

  it("gives null for a plain directory inside a git work tree", async () => {
    const inner = join(fixture.repo, "eval", "cases");
    mkdirSync(inner, { recursive: true });
    expect(await casesRef(inner)).toBeNull();
  });

  it("gives null for a directory outside any git work tree", async () => {
    expect(await casesRef(newCasesDir())).toBeNull();
  });
});
