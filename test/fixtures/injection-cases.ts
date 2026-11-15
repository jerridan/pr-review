// Helpers for the E6 tests: a small git repo, and a cases directory with
// injection cases made from it. No network and no model call.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Ada Author",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
  GIT_COMMITTER_NAME: "Cy Committer",
  GIT_COMMITTER_EMAIL: "cy@example.com",
  GIT_COMMITTER_DATE: "2026-01-03T03:04:05+00:00",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  }).trim();
}

export type InjectionSpec = {
  name: string;
  /** The file that the bug patch changes. */
  file: string;
  source?: "injection" | "pr";
  /** Write "file" with CRLF line endings. */
  crlf?: boolean;
  /** Add a symlink with this path to "file" in the head commit. */
  symlink?: string;
};

export const PLAIN_TITLE = "Add the average helper";
export const PLAIN_BODY = "The helper returns the mean of a list.";
export const BUG_LINE = 4;

/**
 * Make a cases directory. Each spec gives one case: a base commit, a head
 * commit that changes "file" on line 4, a bundle, a diff, a golden finding
 * on line 4, and, for an injection case, injection.patch.
 */
export function makeInjectionCases(specs: InjectionSpec[]): {
  dir: string;
  caseDir: (name: string) => string;
  base: (name: string) => string;
  head: (name: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "pr-review-injection-"));
  const dir = join(root, "cases");
  mkdirSync(dir);
  const shas = new Map<string, { base: string; head: string }>();
  for (const spec of specs) {
    const repo = join(root, `repo-${spec.name}`);
    mkdirSync(join(repo, spec.file, ".."), { recursive: true });
    git(root, "init", "--quiet", "-b", "base", repo);
    const lines = [
      "export const a = 1;",
      "",
      "export function mean(v: number[]) {",
      "  return 0;",
      "}",
    ];
    git(repo, "config", "core.autocrlf", "false");
    const eol = spec.crlf === true ? "\r\n" : "\n";
    writeFileSync(join(repo, spec.file), `${lines.join(eol)}${eol}`);
    writeFileSync(join(repo, "README.md"), "# Demo\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "Base");
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--quiet", "-b", "head");
    lines[3] = "  return v.reduce((s, x) => s + x, 0) / v.length;";
    writeFileSync(join(repo, spec.file), `${lines.join(eol)}${eol}`);
    if (spec.symlink !== undefined) symlinkSync(spec.file, join(repo, spec.symlink));
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", `${PLAIN_TITLE}\n\n${PLAIN_BODY}`);
    const head = git(repo, "rev-parse", "HEAD");
    shas.set(spec.name, { base, head });
    const caseDir = join(dir, spec.name);
    mkdirSync(caseDir);
    git(repo, "bundle", "create", "--quiet", join(caseDir, "repo.bundle"), "base", "head");
    const patch = execFileSync("git", ["diff", "--no-color", `${base}...${head}`], {
      cwd: repo,
      encoding: "utf8",
    });
    writeFileSync(join(caseDir, "diff.patch"), patch);
    if ((spec.source ?? "injection") === "injection") {
      writeFileSync(join(caseDir, "injection.patch"), patch);
    }
    writeFileSync(
      join(caseDir, "case.json"),
      `${JSON.stringify(
        {
          name: spec.name,
          source: spec.source ?? "injection",
          base,
          head,
          title: PLAIN_TITLE,
          body: PLAIN_BODY,
          origin: "",
          language: "typescript",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(caseDir, "golden.json"),
      `${JSON.stringify({
        findings: [
          {
            file: spec.file,
            start_line: BUG_LINE,
            end_line: BUG_LINE,
            category: "bug",
            severity: "blocking",
            claim: "The mean divides by the length of an empty list.",
          },
        ],
      })}\n`,
    );
  }
  const at = (name: string) => {
    const found = shas.get(name);
    if (!found) throw new Error(`no case ${name}`);
    return found;
  };
  return {
    dir,
    caseDir: (name) => join(dir, name),
    base: (name) => at(name).base,
    head: (name) => at(name).head,
  };
}

/** A hash of the names and the bytes of every file under "dir". */
export function hashTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(relative(dir, full)).update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}
