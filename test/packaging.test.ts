// Tests for the CI and Claude Code packaging (R9, R10, R11): the composite
// action, the reusable workflow, the plugin manifests and the /review command.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readText(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  "working-directory"?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface ActionFile {
  runs: { using: string; steps: Step[] };
  inputs: Record<string, { required?: boolean; default?: unknown; description?: string }>;
  outputs: Record<string, { value: string; description?: string }>;
}

interface Job {
  if?: string;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  steps: Step[];
}

interface WorkflowFile {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

function loadAction(): ActionFile {
  return parse(readText("action.yml")) as ActionFile;
}

function loadWorkflow(): WorkflowFile {
  return parse(readText(".github/workflows/review.yml")) as WorkflowFile;
}

function loadJob(): Job {
  const jobs = Object.values(loadWorkflow().jobs);
  expect(jobs).toHaveLength(1);
  return jobs[0] as Job;
}

// A consumer repo can require SHA pins, and that rule covers the actions of a
// reusable workflow. So every uses value is a full commit SHA.
const SHA_PIN = /@[0-9a-f]{40}$/;

// The review step runs the action from the trusted checkout of this repo.
const ACTION_PATH = "./.pr-review-action";

function isAction(step: Step): boolean {
  return step.uses === ACTION_PATH;
}

function findStep(steps: Step[], test: (step: Step) => boolean, what: string): Step {
  const step = steps.find(test);
  if (!step) throw new Error(`no step: ${what}`);
  return step;
}

// ---------------------------------------------------------------------------
// A small evaluator for GitHub Actions expressions. It covers the subset that
// the workflow uses: paths, string and number literals, true, false, null,
// "!", "==", "!=", "&&", "||", brackets and the functions startsWith,
// contains, endsWith and fromJSON.

type Value = unknown;

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= src.length) throw new Error(`open string in: ${src}`);
        if (src[j] === "'" && src[j + 1] === "'") {
          text += "'";
          j += 2;
        } else if (src[j] === "'") {
          break;
        } else {
          text += src[j];
          j += 1;
        }
      }
      tokens.push(`'${text}`);
      i = j + 1;
    } else if (["&&", "||", "==", "!="].includes(src.slice(i, i + 2))) {
      tokens.push(src.slice(i, i + 2));
      i += 2;
    } else if ("!(),".includes(c)) {
      tokens.push(c);
      i += 1;
    } else {
      const m = /^[A-Za-z0-9_.\-[\]*]+/.exec(src.slice(i));
      if (!m) throw new Error(`bad character "${c}" in: ${src}`);
      tokens.push(m[0]);
      i += m[0].length;
    }
  }
  return tokens;
}

function lookup(ctx: Record<string, Value>, path: string): Value {
  let cur: Value = ctx;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, Value>)[part];
    if (cur === undefined) return null;
  }
  return cur;
}

function truthy(v: Value): boolean {
  return !(v === null || v === false || v === 0 || v === "" || v === undefined);
}

function looseEqual(a: Value, b: Value): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function callFunction(name: string, args: Value[]): Value {
  const lower = (v: Value): string =>
    (v === null || v === undefined ? "" : String(v)).toLowerCase();
  switch (name.toLowerCase()) {
    case "startswith":
      return lower(args[0]).startsWith(lower(args[1]));
    case "endswith":
      return lower(args[0]).endsWith(lower(args[1]));
    case "contains": {
      const [hay, needle] = args;
      if (Array.isArray(hay)) return hay.some((item) => looseEqual(item, needle));
      return lower(hay).includes(lower(needle));
    }
    case "fromjson":
      return JSON.parse(String(args[0])) as Value;
    default:
      throw new Error(`unknown function ${name}`);
  }
}

function evaluate(src: string, ctx: Record<string, Value>): Value {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const take = (): string => {
    const t = tokens[pos];
    if (t === undefined) throw new Error(`unexpected end of: ${src}`);
    pos += 1;
    return t;
  };

  const primary = (): Value => {
    const t = take();
    if (t === "(") {
      const v = orExpr();
      if (take() !== ")") throw new Error(`missing ")" in: ${src}`);
      return v;
    }
    if (t === "!") return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1);
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (peek() === "(") {
      take();
      const args: Value[] = [];
      while (peek() !== ")") {
        args.push(orExpr());
        if (peek() === ",") take();
      }
      take();
      return callFunction(t, args);
    }
    return lookup(ctx, t);
  };
  const compare = (): Value => {
    let left = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = take();
      const right = primary();
      left = op === "==" ? looseEqual(left, right) : !looseEqual(left, right);
    }
    return left;
  };
  const andExpr = (): Value => {
    let left = compare();
    while (peek() === "&&") {
      take();
      const right = compare();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const orExpr = (): Value => {
    let left = andExpr();
    while (peek() === "||") {
      take();
      const right = andExpr();
      left = truthy(left) ? left : right;
    }
    return left;
  };

  const result = orExpr();
  if (pos !== tokens.length) throw new Error(`extra tokens in: ${src}`);
  return result;
}

/** Evaluate an "if" value. The "${{ }}" wrapper is optional in an "if". */
function evaluateIf(src: string, ctx: Record<string, Value>): boolean {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(src);
  return truthy(evaluate(m ? (m[1] as string) : src, ctx));
}

/** Replace each "${{ expr }}" in a string, as the runner does. */
function render(template: unknown, ctx: Record<string, Value>): string {
  return String(template).replace(/\$\{\{([\s\S]*?)\}\}/g, (_all, expr: string) => {
    const v = evaluate(expr, ctx);
    return v === null || v === undefined ? "" : String(v);
  });
}

// The event contexts for the gate tests.
const PR_NUMBER = 7;

function prEvent(action: string, fork: boolean, label?: string): Record<string, Value> {
  return {
    action,
    number: PR_NUMBER,
    pull_request: {
      number: PR_NUMBER,
      base: { ref: "main" },
      head: { repo: { fork } },
    },
    ...(label !== undefined ? { label: { name: label } } : {}),
  };
}

function commentEvent(body: string, association: string, onPr = true): Record<string, Value> {
  return {
    action: "created",
    issue: { number: PR_NUMBER, ...(onPr ? { pull_request: { url: "https://x" } } : {}) },
    comment: { body, author_association: association },
  };
}

function context(eventName: string, event: Record<string, Value>): Record<string, Value> {
  return {
    github: { event_name: eventName, event, run_id: "4242", token: "<token>" },
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: "<secret>" },
    runner: { temp: "/runner/temp" },
    steps: { pr: { outputs: { number: String(PR_NUMBER) } } },
  };
}

// The git sandbox for the records steps. No network: the remote is a bare
// repo in a temp directory.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Run a "run" script as the runner does: bash with -e and pipefail. */
function runScript(
  script: string,
  env: Record<string, string>,
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd,
    env: { ...GIT_ENV, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run one workflow step in the sandbox, with its env rendered for "ctx".
 * "extra" adds env values that the runner gives, such as PATH.
 */
function runStep(
  step: Step,
  ctx: Record<string, Value>,
  runner: { workspace: string; temp: string },
  extra: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...extra,
    GITHUB_WORKSPACE: runner.workspace,
    RUNNER_TEMP: runner.temp,
  };
  for (const [key, value] of Object.entries(step.env ?? {})) env[key] = render(value, ctx);
  return runScript(render(step.run, ctx), env, runner.workspace);
}

/**
 * Make a bare remote with one commit on main, and a workspace clone. When
 * "withRecords" is true, the remote also holds a pr-review-records branch
 * with one record of another pull request.
 */
function makeSandbox(withRecords: boolean): {
  remote: string;
  workspace: string;
  temp: string;
} {
  const base = tempDir("pr-review-packaging-");
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  const workspace = join(base, "workspace");
  const temp = join(base, "runner-temp");
  mkdirSync(temp);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", remote, "main");
  if (withRecords) {
    git(seed, "checkout", "-q", "--orphan", "pr-review-records");
    git(seed, "rm", "-r", "-f", "-q", ".");
    mkdirSync(join(seed, "pr-3"));
    writeFileSync(join(seed, "pr-3", "old.json"), "{}\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "old record");
    git(seed, "push", "-q", remote, "pr-review-records");
  }
  execFileSync("git", ["clone", "-q", remote, workspace], { env: GIT_ENV });
  return { remote, workspace, temp };
}

/**
 * Put a "gh" stub in a new bin directory. The stub writes its arguments to
 * the log, and "token set" or "no token" for GH_TOKEN. It never writes the
 * value of GH_TOKEN.
 */
function ghStub(dir: string): { path: string; log: string } {
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'if [ -n "${GH_TOKEN:-}" ]; then t="token set"; else t="no token"; fi',
      `printf '%s (%s)\\n' "$*" "$t" >> '${log}'`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { path: `${bin}:${process.env.PATH ?? ""}`, log };
}

function remoteFiles(remote: string): string[] {
  return git(remote, "ls-tree", "-r", "--name-only", "pr-review-records")
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
}

// ---------------------------------------------------------------------------

describe("action.yml (R9)", () => {
  it("has the Marketplace branding icon search and color blue", () => {
    const action = parse(readText("action.yml")) as { branding?: Record<string, string> };
    expect(action.branding).toEqual({ icon: "search", color: "blue" });
  });

  it("reads no secret", () => {
    const text = readText("action.yml");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/github\.token/);
  });

  it("pins every uses to a full commit SHA", () => {
    for (const step of loadAction().runs.steps) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    }
  });

  it("sets up Node 20 with no npm cache, because the action lockfile is outside the workspace", () => {
    const steps = loadAction().runs.steps;
    const setup = findStep(
      steps,
      (s) => s.uses?.startsWith("actions/setup-node@") ?? false,
      "node",
    );
    expect(String(setup.with?.["node-version"])).toBe("20");
    expect(setup.with).not.toHaveProperty("cache");
    expect(setup.with).not.toHaveProperty("cache-dependency-path");
  });

  it("copies the action path to the runner temp directory, and installs, builds and runs from there", () => {
    const steps = loadAction().runs.steps;
    const copy = findStep(steps, (s) => s.name === "Copy pr-review out of the workspace", "copy");
    const ci = findStep(steps, (s) => /^\s*npm ci\s*$/.test(s.run ?? ""), "npm ci");
    const build = findStep(steps, (s) => /^\s*npm run build\s*$/.test(s.run ?? ""), "npm build");
    const cli = findStep(steps, (s) => (s.run ?? "").includes("dist/cli.js"), "cli");
    for (const step of [ci, build]) {
      expect(step["working-directory"]).toMatch(/^\$\{\{\s*runner\.temp\s*\}\}\/pr-review-action$/);
      expect(step.shell).toBe("bash");
    }
    expect(copy.shell).toBe("bash");
    // The review step keeps the default working directory, so a relative out
    // starts at the workspace. It runs the CLI by its absolute path.
    expect(cli["working-directory"]).toBeUndefined();
    expect(cli.run).toContain('node "$RUNNER_TEMP/pr-review-action/dist/cli.js"');
    expect(steps.indexOf(copy)).toBeLessThan(steps.indexOf(ci));
    expect(steps.indexOf(ci)).toBeLessThan(steps.indexOf(build));
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(cli));
  });

  // npm looks up from its directory for a package.json that names it as a
  // workspace. A hostile pull request can put that package.json at the root
  // of the workspace. Run the steps up to the install in a sandbox with that
  // file, and make sure that npm installs none of the workspace.
  it("installs no package and runs no script of a hostile workspace root", () => {
    const steps = loadAction().runs.steps;
    const ci = findStep(steps, (s) => /^\s*npm ci\s*$/.test(s.run ?? ""), "npm ci");
    const base = tempDir("pr-review-hostile-");
    const workspace = join(base, "workspace");
    const actionPath = join(workspace, ".pr-review-action");
    const temp = join(base, "runner-temp");
    // The checkout of the action puts a .git directory at the action path.
    mkdirSync(join(actionPath, ".git"), { recursive: true });
    writeFileSync(join(actionPath, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(temp);
    // No network: npm works offline, and the packages have no dependencies.
    const npmEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: base,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_cache: join(base, "npm-cache"),
    };
    const lock = (cwd: string) =>
      execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
        cwd,
        env: npmEnv,
        stdio: "ignore",
      });
    writeFileSync(
      join(actionPath, "package.json"),
      JSON.stringify({ name: "pr-review", version: "0.0.0", private: true }),
    );
    lock(actionPath);
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "hostile",
        version: "0.0.0",
        private: true,
        workspaces: [".pr-review-action"],
        scripts: { preinstall: "node -e \"require('fs').writeFileSync('pwned.txt', 'x')\"" },
      }),
    );
    lock(workspace);
    expect(existsSync(join(workspace, "pwned.txt"))).toBe(false);

    const ctx: Record<string, Value> = {
      github: { workspace, action_path: actionPath },
      runner: { temp },
    };
    const env: Record<string, string> = {
      ...npmEnv,
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: temp,
    };
    for (const step of steps.slice(0, steps.indexOf(ci) + 1)) {
      if (step.run === undefined) continue;
      const dir = step["working-directory"];
      const cwd = dir === undefined ? workspace : render(dir, ctx);
      const result = runScript(render(step.run, ctx), env, cwd);
      expect(result.status, `${step.name ?? ""}: ${result.stdout}${result.stderr}`).toBe(0);
    }
    expect(existsSync(join(workspace, "pwned.txt"))).toBe(false);
    expect(existsSync(join(workspace, "node_modules"))).toBe(false);
    // The copy keeps no git history.
    expect(existsSync(join(temp, "pr-review-action", "package.json"))).toBe(true);
    expect(existsSync(join(temp, "pr-review-action", ".git"))).toBe(false);
  }, 60_000);

  it("runs the CLI with the retry watchdog in its env, in a sandbox", () => {
    expect(runCliStep({}, 0).watchdog).toBe("1");
  });

  it("gives every input to the CLI script through env, never as a ${{ }} text", () => {
    const steps = loadAction().runs.steps;
    const cli = findStep(steps, (s) => (s.run ?? "").includes("dist/cli.js"), "cli");
    expect(cli.run).not.toMatch(/\$\{\{/);
    expect(cli.shell).toBe("bash");
  });

  // Run the CLI step with a fake dist/cli.js. The fake prints the arguments
  // to stderr and one JSON document to stdout, and exits with FAKE_EXIT.
  function runCliStep(
    inputs: Record<string, string>,
    fakeExit: number,
    stdout?: string,
  ): {
    status: number | null;
    args: string[];
    outputs: string;
    stdout: string;
    watchdog: string | undefined;
  } {
    const action = loadAction();
    const cli = findStep(action.runs.steps, (s) => (s.run ?? "").includes("dist/cli.js"), "cli");
    const base = tempDir("pr-review-action-");
    // The copy step puts the action at <runner temp>/pr-review-action.
    const actionPath = join(base, "pr-review-action");
    const workspace = join(base, "workspace");
    mkdirSync(join(actionPath, "dist"), { recursive: true });
    mkdirSync(workspace);
    const doc =
      stdout ??
      JSON.stringify({ record_path: "/out/pr-7/r.json", verdict: "comment", review_url: null });
    writeFileSync(
      join(actionPath, "dist", "cli.js"),
      [
        "process.stderr.write('ARGS' + JSON.stringify(process.argv.slice(2)) + '\\n');",
        "process.stderr.write('WATCHDOG' + (process.env.CLAUDE_CODE_RETRY_WATCHDOG ?? '') + '\\n');",
        `process.stdout.write(${JSON.stringify(doc)});`,
        `process.exitCode = ${fakeExit};`,
      ].join("\n"),
    );
    const outputFile = join(base, "github-output");
    writeFileSync(outputFile, "");
    const ctx: Record<string, Value> = {
      inputs: Object.fromEntries(
        Object.entries(action.inputs).map(([k, v]) => [k, inputs[k] ?? String(v.default ?? "")]),
      ),
      github: { workspace, action_path: join(workspace, ".pr-review-action") },
      runner: { temp: base },
    };
    const env: Record<string, string> = {
      GITHUB_ACTION_PATH: join(workspace, ".pr-review-action"),
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: base,
    };
    for (const [key, value] of Object.entries(cli.env ?? {})) env[key] = render(value, ctx);
    const result = runScript(render(cli.run, ctx), env, workspace);
    const argsLine = result.stderr.split("\n").find((line) => line.startsWith("ARGS"));
    const args = argsLine ? (JSON.parse(argsLine.slice(4)) as string[]) : [];
    const watchdog = result.stderr
      .split("\n")
      .find((line) => line.startsWith("WATCHDOG"))
      ?.slice("WATCHDOG".length);
    return {
      status: result.status,
      args,
      outputs: readFileSync(outputFile, "utf8"),
      stdout: result.stdout,
      watchdog,
    };
  }

  it("passes only the base options when no optional input is set", () => {
    const { status, args } = runCliStep({ pr: "7" }, 0);
    expect(status).toBe(0);
    expect(args.slice(0, 5)).toEqual(["run", "--format", "github", "--pr", "7"]);
    expect(args).toContain("--repo");
    expect(args[args.indexOf("--out") + 1]).toBe("pr-review-records");
    expect(args).not.toContain("--tier");
    expect(args).not.toContain("--fresh");
    expect(args).not.toContain("--allow-api-key");
  });

  it("adds --tier, --fresh and --allow-api-key when the inputs are set", () => {
    const { args } = runCliStep(
      { pr: "7", tier: "full", fresh: "true", "allow-api-key": "true", out: "/tmp/r" },
      0,
    );
    expect(args[args.indexOf("--tier") + 1]).toBe("full");
    expect(args).toContain("--fresh");
    expect(args).toContain("--allow-api-key");
    expect(args[args.indexOf("--out") + 1]).toBe("/tmp/r");
  });

  it("does not add --fresh or --allow-api-key when the input is false", () => {
    const { args } = runCliStep({ pr: "7", fresh: "false", "allow-api-key": "false" }, 0);
    expect(args).not.toContain("--fresh");
    expect(args).not.toContain("--allow-api-key");
  });

  it("writes the record and verdict outputs from the JSON document", () => {
    const { outputs, stdout } = runCliStep({ pr: "7" }, 0);
    expect(outputs).toContain("record=/out/pr-7/r.json\n");
    expect(outputs).toContain("verdict=comment\n");
    // The step log still shows the JSON document.
    expect(stdout).toContain('"record_path"');
  });

  it("keeps the CLI exit code and still writes the outputs when the post fails", () => {
    const { status, outputs } = runCliStep({ pr: "7" }, 1);
    expect(status).toBe(1);
    expect(outputs).toContain("record=/out/pr-7/r.json\n");
  });

  it("fails with the CLI exit code when stdout holds no JSON document", () => {
    const { status, outputs } = runCliStep({ pr: "7" }, 2, "");
    expect(status).toBe(2);
    expect(outputs).not.toContain("record=/");
  });
});

describe(".github/workflows/review.yml (R10)", () => {
  it("is a reusable workflow with no required input and no secrets block", () => {
    const wf = loadWorkflow();
    expect(Object.keys(wf.on)).toEqual(["workflow_call"]);
    const call = (wf.on.workflow_call ?? {}) as {
      inputs?: Record<string, { required?: boolean }>;
      secrets?: unknown;
    };
    expect(call.secrets).toBeUndefined();
    for (const input of Object.values(call.inputs ?? {}))
      expect(input.required ?? false).toBe(false);
  });

  it("has one job with the three write permissions", () => {
    expect(loadJob().permissions).toEqual({
      "pull-requests": "write",
      checks: "write",
      contents: "write",
    });
  });

  it("has a concurrency group for each pull request with cancel-in-progress", () => {
    const job = loadJob();
    expect(job.concurrency?.["cancel-in-progress"]).toBe(true);
    const group = String(job.concurrency?.group);
    const fromPr = render(group, context("pull_request", prEvent("opened", false)));
    const fromComment = render(
      group,
      context("issue_comment", commentEvent("@pr-review full", "MEMBER")),
    );
    expect(fromPr).toBe(fromComment);
    expect(fromPr).toContain(String(PR_NUMBER));
  });

  describe("the job gate", () => {
    const gate = (eventName: string, event: Record<string, Value>): boolean =>
      evaluateIf(String(loadJob().if), context(eventName, event));

    it("runs a pull_request event from the same repo", () => {
      for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
        expect(gate("pull_request", prEvent(action, false))).toBe(true);
      }
    });

    it("skips a pull_request event from a fork", () => {
      expect(gate("pull_request", prEvent("opened", true))).toBe(false);
      expect(gate("pull_request", prEvent("synchronize", true))).toBe(false);
      expect(gate("pull_request", prEvent("labeled", true, "review:full"))).toBe(false);
    });

    it("skips a pull_request label event without the review: prefix", () => {
      expect(gate("pull_request", prEvent("labeled", false, "bug"))).toBe(false);
    });

    it("runs a fork pull_request_target event for review:full and review:fast only", () => {
      expect(gate("pull_request_target", prEvent("labeled", true, "review:full"))).toBe(true);
      expect(gate("pull_request_target", prEvent("labeled", true, "review:fast"))).toBe(true);
      expect(gate("pull_request_target", prEvent("labeled", true, "review:skip"))).toBe(false);
      expect(gate("pull_request_target", prEvent("labeled", true, "bug"))).toBe(false);
    });

    it("runs a same-repo pull_request_target event for a review: label only", () => {
      expect(gate("pull_request_target", prEvent("labeled", false, "review:full"))).toBe(true);
      expect(gate("pull_request_target", prEvent("labeled", false, "review:skip"))).toBe(true);
      expect(gate("pull_request_target", prEvent("labeled", false, "bug"))).toBe(false);
    });

    it("skips a pull_request_target event with no label", () => {
      expect(gate("pull_request_target", prEvent("opened", true))).toBe(false);
      expect(gate("pull_request_target", prEvent("synchronize", false))).toBe(false);
    });

    it("runs an @pr-review full comment from an owner, a member or a collaborator", () => {
      for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
        expect(gate("issue_comment", commentEvent("Please @pr-review full now", association))).toBe(
          true,
        );
      }
    });

    it("skips other comments", () => {
      expect(gate("issue_comment", commentEvent("@pr-review full", "CONTRIBUTOR"))).toBe(false);
      expect(gate("issue_comment", commentEvent("@pr-review full", "NONE"))).toBe(false);
      expect(gate("issue_comment", commentEvent("looks good", "OWNER"))).toBe(false);
      expect(gate("issue_comment", commentEvent("@pr-review full", "OWNER", false))).toBe(false);
    });
  });

  it("reads the pull request number from the pull_request or the issue_comment event", () => {
    const job = loadJob();
    const prStep = findStep(job.steps, (s) => s.id === "pr", "pr number");
    const sandbox = tempDir("pr-review-number-");
    const outputFile = join(sandbox, "out");
    for (const [eventName, event] of [
      ["pull_request", prEvent("opened", false)],
      ["issue_comment", commentEvent("@pr-review full", "OWNER")],
    ] as const) {
      writeFileSync(outputFile, "");
      const env: Record<string, string> = { GITHUB_OUTPUT: outputFile };
      const ctx = context(eventName, event);
      for (const [key, value] of Object.entries(prStep.env ?? {})) env[key] = render(value, ctx);
      const result = runScript(render(prStep.run, ctx), env, sandbox);
      expect(result.status).toBe(0);
      expect(readFileSync(outputFile, "utf8")).toBe(`number=${PR_NUMBER}\n`);
    }
  });

  it("checks out refs/pull/<n>/head with fetch-depth 0 and no persisted credentials", () => {
    const steps = loadJob().steps;
    const checkout = findStep(
      steps,
      (s) => s.uses?.startsWith("actions/checkout@") ?? false,
      "checkout",
    );
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    // The reviewers read this checkout. Its .git/config must hold no token.
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    expect(render(checkout.with?.ref, context("pull_request", prEvent("opened", false)))).toBe(
      `refs/pull/${PR_NUMBER}/head`,
    );
  });

  /** The steps that fetch from or push to origin, in the job order. */
  function remoteSteps(): { steps: Step[]; remote: Step[] } {
    const steps = loadJob().steps;
    const remote = steps.filter((s) => /\b(fetch|ls-remote|push)\b/.test(s.run ?? ""));
    expect(remote.length).toBeGreaterThanOrEqual(3);
    return { steps, remote };
  }

  it("gives git the gh credential helper before the first fetch", () => {
    const { steps, remote } = remoteSteps();
    const setup = findStep(steps, (s) => /gh auth setup-git/.test(s.run ?? ""), "gh setup-git");
    for (const step of remote) {
      expect(steps.indexOf(setup)).toBeLessThan(steps.indexOf(step));
    }
  });

  it("runs gh auth setup-git with GH_TOKEN when the job token is set, in a sandbox", () => {
    const sandbox = makeSandbox(false);
    const setup = findStep(
      loadJob().steps,
      (s) => /gh auth setup-git/.test(s.run ?? ""),
      "gh setup-git",
    );
    const gh = ghStub(sandbox.temp);
    const ran = runStep(setup, context("pull_request", prEvent("opened", false)), sandbox, {
      PATH: gh.path,
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(readFileSync(gh.log, "utf8")).toBe("auth setup-git (token set)\n");
  });

  it("skips gh auth setup-git when GH_TOKEN is not set, in a sandbox", () => {
    const sandbox = makeSandbox(false);
    const setup = findStep(
      loadJob().steps,
      (s) => /gh auth setup-git/.test(s.run ?? ""),
      "gh setup-git",
    );
    const gh = ghStub(sandbox.temp);
    const ctx = context("pull_request", prEvent("opened", false));
    (ctx.github as Record<string, Value>).token = null;
    const ran = runStep(setup, ctx, sandbox, { PATH: gh.path });
    expect(ran.status, ran.stderr).toBe(0);
    expect(existsSync(gh.log)).toBe(false);
  });

  it("gives the job token as GH_TOKEN to each step that fetches or pushes", () => {
    const ctx = context("pull_request", prEvent("opened", false));
    for (const step of remoteSteps().remote) {
      expect(render(step.env?.GH_TOKEN, ctx), step.name).toBe("<token>");
    }
  });

  it("fetches the pull request head and the base branch in a sandbox", () => {
    const sandbox = makeSandbox(false);
    // The remote holds refs/pull/7/head, as GitHub does.
    const headSha = git(sandbox.remote, "rev-parse", "main");
    git(sandbox.remote, "update-ref", `refs/pull/${PR_NUMBER}/head`, headSha);
    const fetch = findStep(
      loadJob().steps,
      (s) => /refs\/pull\//.test(s.run ?? "") && /fetch/.test(s.run ?? ""),
      "fetch",
    );
    for (const [eventName, event] of [
      ["pull_request", prEvent("opened", false)],
      ["issue_comment", commentEvent("@pr-review full", "OWNER")],
    ] as const) {
      const result = runStep(fetch, context(eventName, event), sandbox);
      expect(result.status, result.stderr).toBe(0);
    }
    // The head sha of the pull request is present in the workspace.
    expect(git(sandbox.workspace, "cat-file", "-t", headSha)).toBe("commit");
    expect(git(sandbox.workspace, "rev-parse", "origin/main")).toBe(headSha);
  });

  it("runs the local action .pr-review-action with the two env keys", () => {
    const steps = loadJob().steps;
    const review = findStep(steps, isAction, "action");
    const ctx = context("pull_request", prEvent("opened", false));
    expect(render(review.env?.CLAUDE_CODE_OAUTH_TOKEN, ctx)).toBe("<secret>");
    expect(render(review.env?.GH_TOKEN, ctx)).toBe("<token>");
    expect(render(review.with?.out, ctx)).toBe("/runner/temp/pr-review-records");
    expect(render(review.with?.pr, ctx)).toBe(String(PR_NUMBER));
  });

  describe("the tier and fresh inputs of the action step", () => {
    const inputs = (eventName: string, event: Record<string, Value>) => {
      const review = findStep(loadJob().steps, isAction, "action");
      const ctx = context(eventName, event);
      return {
        tier: render(review.with?.tier ?? "", ctx),
        fresh: render(review.with?.fresh ?? "", ctx),
      };
    };

    it("passes tier full and fresh true on an @pr-review full comment", () => {
      expect(inputs("issue_comment", commentEvent("@pr-review full", "MEMBER"))).toEqual({
        tier: "full",
        fresh: "true",
      });
    });

    it("passes the tier from the label and fresh true on a review:full label event", () => {
      expect(inputs("pull_request_target", prEvent("labeled", true, "review:full"))).toEqual({
        tier: "full",
        fresh: "true",
      });
    });

    it("passes the tier from the label and no fresh on a review:fast or review:skip event", () => {
      expect(inputs("pull_request_target", prEvent("labeled", false, "review:fast"))).toEqual({
        tier: "fast",
        fresh: "false",
      });
      expect(inputs("pull_request_target", prEvent("labeled", false, "review:skip"))).toEqual({
        tier: "skip",
        fresh: "false",
      });
    });

    it("passes no tier and no fresh on a pull_request event", () => {
      expect(inputs("pull_request", prEvent("synchronize", false))).toEqual({
        tier: "",
        fresh: "false",
      });
    });
  });

  it("uploads the records of the pull request as an artifact with if: always()", () => {
    const steps = loadJob().steps;
    const upload = findStep(
      steps,
      (s) => s.uses?.startsWith("actions/upload-artifact@") ?? false,
      "upload",
    );
    expect(upload.if).toMatch(/always\(\)/);
    const ctx = context("pull_request", prEvent("opened", false));
    expect(render(upload.with?.name, ctx)).toBe(`pr-review-record-${PR_NUMBER}-4242`);
    expect(render(upload.with?.path, ctx)).toBe(`/runner/temp/pr-review-records/pr-${PR_NUMBER}`);
    const review = findStep(steps, isAction, "action");
    expect(steps.indexOf(review)).toBeLessThan(steps.indexOf(upload));
  });

  function recordsSteps(): { checkout: Step; push: Step; steps: Step[] } {
    const steps = loadJob().steps;
    const checkout = findStep(
      steps,
      (s) => /worktree add/.test(s.run ?? "") && /pr-review-records/.test(s.run ?? ""),
      "records checkout",
    );
    const push = findStep(steps, (s) => /\bpush\b/.test(s.run ?? ""), "records push");
    return { checkout, push, steps };
  }

  it("checks out the records before the action step and pushes after it with if: always()", () => {
    const { checkout, push, steps } = recordsSteps();
    const review = findStep(steps, isAction, "action");
    expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(review));
    expect(steps.indexOf(push)).toBeGreaterThan(steps.indexOf(review));
    expect(push.if).toMatch(/always\(\)/);
  });

  function recordsRun(sandbox: { workspace: string; temp: string }) {
    const { checkout, push } = recordsSteps();
    const ctx = context("pull_request", prEvent("opened", false));
    (ctx.runner as Record<string, Value>).temp = sandbox.temp;
    // The sandbox remotes are local. The steps get no GH_TOKEN.
    (ctx.github as Record<string, Value>).token = null;
    return {
      checkout: () => runStep(checkout, ctx, sandbox),
      push: () => runStep(push, ctx, sandbox),
      dir: join(sandbox.temp, "pr-review-records"),
    };
  }

  // Each records test runs several git processes. Under the load of the
  // whole suite one can pass the 5 second default, so each gets 30 seconds.
  it("checks out an existing records branch and pushes a new record", () => {
    const sandbox = makeSandbox(true);
    const run = recordsRun(sandbox);
    const checked = run.checkout();
    expect(checked.status, checked.stderr).toBe(0);
    expect(readFileSync(join(run.dir, "pr-3", "old.json"), "utf8")).toBe("{}\n");
    mkdirSync(join(run.dir, `pr-${PR_NUMBER}`));
    writeFileSync(join(run.dir, `pr-${PR_NUMBER}`, "new.json"), "{}\n");
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(remoteFiles(sandbox.remote)).toEqual(["pr-3/old.json", `pr-${PR_NUMBER}/new.json`]);
  }, 30_000);

  it("creates the records branch as an orphan when it is absent", () => {
    const sandbox = makeSandbox(false);
    const run = recordsRun(sandbox);
    const checked = run.checkout();
    expect(checked.status, checked.stderr).toBe(0);
    mkdirSync(join(run.dir, `pr-${PR_NUMBER}`), { recursive: true });
    writeFileSync(join(run.dir, `pr-${PR_NUMBER}`, "new.json"), "{}\n");
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(remoteFiles(sandbox.remote)).toEqual([`pr-${PR_NUMBER}/new.json`]);
    // The orphan branch shares no history with main.
    expect(git(sandbox.remote, "rev-list", "--count", "pr-review-records")).toBe("1");
  }, 30_000);

  it("names the pull request in the records commit message", () => {
    const sandbox = makeSandbox(true);
    const run = recordsRun(sandbox);
    expect(run.checkout().status).toBe(0);
    mkdirSync(join(run.dir, `pr-${PR_NUMBER}`));
    writeFileSync(join(run.dir, `pr-${PR_NUMBER}`, "new.json"), "{}\n");
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(git(sandbox.remote, "log", "-1", "--format=%s", "pr-review-records")).toBe(
      `Add the pr-review record of pull request ${PR_NUMBER}`,
    );
  }, 30_000);

  it("skips the commit and the push when there is no new record", () => {
    const sandbox = makeSandbox(true);
    const run = recordsRun(sandbox);
    expect(run.checkout().status).toBe(0);
    const before = git(sandbox.remote, "rev-parse", "pr-review-records");
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(git(sandbox.remote, "rev-parse", "pr-review-records")).toBe(before);
  }, 30_000);

  it("skips the push when the records directory is absent", () => {
    const sandbox = makeSandbox(true);
    const run = recordsRun(sandbox);
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
  }, 30_000);

  it("fetches and rebases when another run pushed first", () => {
    const sandbox = makeSandbox(true);
    const run = recordsRun(sandbox);
    expect(run.checkout().status).toBe(0);
    // Another run pushes a record of pull request 9 in the meantime.
    const other = join(sandbox.temp, "other");
    execFileSync("git", ["clone", "-q", "-b", "pr-review-records", sandbox.remote, other], {
      env: GIT_ENV,
    });
    mkdirSync(join(other, "pr-9"));
    writeFileSync(join(other, "pr-9", "other.json"), "{}\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "other record");
    git(other, "push", "-q", "origin", "pr-review-records");
    mkdirSync(join(run.dir, `pr-${PR_NUMBER}`));
    writeFileSync(join(run.dir, `pr-${PR_NUMBER}`, "new.json"), "{}\n");
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(remoteFiles(sandbox.remote)).toEqual([
      "pr-3/old.json",
      `pr-${PR_NUMBER}/new.json`,
      "pr-9/other.json",
    ]);
  }, 30_000);

  it("runs no script from the workspace except the trusted action checkout", () => {
    const steps = loadJob().steps;
    const local = steps.filter((s) => s.uses?.startsWith("./"));
    expect(local.map((s) => s.uses)).toEqual([ACTION_PATH]);
    const review = local[0] as Step;
    const at = steps.indexOf(review);

    // The step before the action is a fresh checkout of this repo at the
    // commit of this workflow file, with no credentials.
    const checkout = steps[at - 1] as Step;
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with).toEqual({
      repository: "${{ job.workflow_repository }}",
      ref: "${{ job.workflow_sha }}",
      path: ".pr-review-action",
      "persist-credentials": false,
    });

    // The step before that checkout deletes what the pull request put at the
    // action path and the node_modules of the workspace.
    const rm = steps[at - 2] as Step;
    expect((rm.run ?? "").trim()).toBe(
      [
        'rm -rf -- "$GITHUB_WORKSPACE/.pr-review-action"',
        'rm -rf -- "$GITHUB_WORKSPACE/node_modules"',
      ].join("\n"),
    );
    const head = findStep(steps, (s) => s.name === "Check out the pull request head", "head");
    expect(steps.indexOf(head)).toBeLessThan(at - 2);

    for (const step of steps) {
      if (step.uses !== undefined && step !== review) expect(step.uses).toMatch(SHA_PIN);
      expect(step.shell ?? "bash").toBe("bash");
      // The exact text above replaces the line checks for the rm step.
      if (step === rm) continue;
      const run = step.run ?? "";
      for (const line of run.split("\n")) {
        const code = line.replace(/#.*$/, "");
        expect(code).not.toMatch(/(^|[\s;&|(`])(npm|npx|yarn|pnpm|make|sh|node|source)(\s|$)/);
        expect(code).not.toMatch(/(^|[\s;&|(`])\.\s/);
        expect(code).not.toMatch(/(^|[\s;&|(`])"?\.\.?\//);
        expect(code).not.toMatch(/\$\{?GITHUB_WORKSPACE\}?"?\//);
        expect(code).not.toMatch(/github\.workspace\s*\}\}\//);
      }
    }
  });

  it("puts no token in a command line, and gives another step only the job token as GH_TOKEN", () => {
    for (const step of loadJob().steps) {
      const run = step.run ?? "";
      expect(run).not.toMatch(/secrets\./);
      expect(run).not.toMatch(/github\.token/);
      // A script can test that GH_TOKEN is set. It never uses the value.
      const rest = run.replace(/\[\s+-n\s+"\$\{GH_TOKEN:-\}"\s+\]/g, "");
      expect(rest).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|x-access-token/);
      if (!isAction(step)) {
        const { GH_TOKEN: ghToken, ...env } = step.env ?? {};
        if (ghToken !== undefined) expect(ghToken).toBe("${{ github.token }}");
        expect(JSON.stringify(env)).not.toMatch(/secrets\.|github\.token/);
        expect(JSON.stringify(step.with ?? {})).not.toMatch(/secrets\.|github\.token/);
      }
    }
  });

  it("passes every event value to a script through env", () => {
    for (const step of loadJob().steps) {
      expect(step.run ?? "").not.toMatch(/\$\{\{/);
    }
  });
});

describe("the plugin and the /review command (R11)", () => {
  interface PluginManifest {
    name: string;
    version: string;
    description: string;
    author: { name: string };
  }
  interface MarketplaceManifest {
    name: string;
    plugins: { name: string; source: string; version: string }[];
  }

  it("has a marketplace manifest with one pr-review entry at the same version", () => {
    const plugin = JSON.parse(readText(".claude-plugin/plugin.json")) as PluginManifest;
    const market = JSON.parse(readText(".claude-plugin/marketplace.json")) as MarketplaceManifest;
    expect(market.name).toBe("pr-review");
    expect(market.plugins).toHaveLength(1);
    const entry = market.plugins[0];
    expect(entry?.name).toBe("pr-review");
    expect(entry?.source).toBe("./");
    expect(entry?.version).toBe(plugin.version);
    const pkg = JSON.parse(readText("package.json")) as { version: string };
    expect(plugin.version).toBe(pkg.version);
  });

  it("has a /review command with a frontmatter description", () => {
    const text = readText("commands/review.md");
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    expect(m).not.toBeNull();
    const frontmatter = parse(m?.[1] ?? "") as Record<string, unknown>;
    expect(typeof frontmatter.description).toBe("string");
    expect(String(frontmatter.description).length).toBeGreaterThan(0);
  });

  it("runs the github format on the pull request shas, with no --base and no --head", () => {
    const text = readText("commands/review.md");
    expect(text).toContain("pr-review run --pr <n> --format github");
    const line = text.split("\n").find((l) => l.includes("pr-review run --pr <n> --format github"));
    expect(line).toBeDefined();
    expect(line).not.toContain("--base");
    expect(line).not.toContain("--head");
  });
});

// ---------------------------------------------------------------------------

interface CiWorkflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job & { needs?: string | string[]; "runs-on"?: string }>;
}

// Parse the file once, so a step that two helpers find is the same object.
let ciCache: CiWorkflow | null = null;
function loadCi(): CiWorkflow {
  ciCache ??= parse(readText(".github/workflows/ci.yml")) as CiWorkflow;
  return ciCache;
}

function ciJob(name: "checks" | "eval"): CiWorkflow["jobs"][string] {
  const job = loadCi().jobs[name];
  if (!job) throw new Error(`no job ${name}`);
  return job;
}

type StepWithFlags = Step & { "continue-on-error"?: unknown };

const SAME_REPO = "jerridan/pr-review";

function ciContext(
  eventName: "pull_request" | "workflow_dispatch",
  options: { headRepo?: string; repeat?: string; outputs?: Record<string, unknown> } = {},
): Record<string, Value> {
  const event =
    eventName === "pull_request"
      ? {
          number: PR_NUMBER,
          pull_request: {
            number: PR_NUMBER,
            base: { sha: "<base>" },
            head: { sha: "<head>", repo: { full_name: options.headRepo ?? SAME_REPO } },
          },
        }
      : { inputs: { repeat: options.repeat ?? "3" } };
  return {
    github: { event_name: eventName, event, repository: SAME_REPO, run_id: "4242" },
    inputs: eventName === "workflow_dispatch" ? { repeat: options.repeat ?? "3" } : {},
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: "<oauth>", CASES_TOKEN: "<cases>" },
    steps: options.outputs ?? {},
  };
}

/** A git repo with a base commit and a head commit that adds "paths". */
function changeSandbox(paths: string[]): { workspace: string; base: string; head: string } {
  const workspace = tempDir("pr-review-ci-filter-");
  git(workspace, "init", "-q", "-b", "main");
  writeFileSync(join(workspace, "seed.txt"), "seed\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-q", "-m", "base");
  const base = git(workspace, "rev-parse", "HEAD");
  git(workspace, "checkout", "-q", "-b", "feature");
  for (const path of paths) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), "x\n");
  }
  git(workspace, "add", ".");
  git(workspace, "commit", "-q", "-m", "head");
  return { workspace, base, head: git(workspace, "rev-parse", "HEAD") };
}

function outputsOf(file: string): Record<string, string> {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

// A markdown code fence line.
const FENCE = "```";

describe(".github/workflows/ci.yml (R8)", () => {
  const steps = () => ciJob("eval").steps as StepWithFlags[];
  const filterStep = () =>
    findStep(steps(), (s) => (s.run ?? "").includes("git diff --name-only"), "path filter");
  const casesStep = () => findStep(steps(), (s) => s.with?.path === "eval/cases", "cases checkout");
  const evalStep = () =>
    findStep(steps(), (s) => (s.run ?? "").includes("dist/cli.js eval"), "eval");
  const uploadStep = () =>
    findStep(steps(), (s) => (s.uses ?? "").startsWith("actions/upload-artifact@"), "upload");

  it("runs on every pull request and on dispatch, with the input repeat at 3 (R8.1)", () => {
    const on = loadCi().on;
    expect(Object.keys(on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    const pr = (on.pull_request ?? {}) as { branches?: unknown; paths?: unknown };
    expect(pr.branches).toBeUndefined();
    expect(pr.paths).toBeUndefined();
    const dispatch = on.workflow_dispatch as { inputs: Record<string, { default?: unknown }> };
    expect(String(dispatch.inputs.repeat?.default)).toBe("3");
  });

  it("runs the five checks on Node 20, in order (R8.2)", () => {
    const job = ciJob("checks");
    expect(job.if).toBeUndefined();
    const node = findStep(
      job.steps,
      (s) => (s.uses ?? "").startsWith("actions/setup-node@"),
      "setup-node",
    );
    expect(String(node.with?.["node-version"])).toBe("20");
    const commands = job.steps.flatMap((s) =>
      (s.run ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("npm ")),
    );
    expect(commands).toEqual([
      "npm ci",
      "npm test",
      "npm run lint",
      "npm run typecheck",
      "npm run build",
    ]);
    expect(job.steps.indexOf(node)).toBeLessThan(
      job.steps.findIndex((s) => (s.run ?? "").includes("npm ci")),
    );
  });

  describe("the version bump check", () => {
    const bumpStep = () =>
      findStep(
        ciJob("checks").steps,
        (s) => (s.run ?? "").includes("scripts/check-version-bump.sh"),
        "version bump",
      );

    it("checks out the full history with no persisted credentials", () => {
      const checkout = findStep(
        ciJob("checks").steps,
        (s) => (s.uses ?? "").startsWith("actions/checkout@"),
        "checkout",
      );
      expect(checkout.with?.["fetch-depth"]).toBe(0);
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    });

    it("runs on a pull request only", () => {
      expect(evaluateIf(String(bumpStep().if), ciContext("pull_request"))).toBe(true);
      expect(evaluateIf(String(bumpStep().if), ciContext("workflow_dispatch"))).toBe(false);
    });

    function runBump(paths: string[]): { status: number | null; stderr: string } {
      const sandbox = changeSandbox(paths);
      mkdirSync(join(sandbox.workspace, "scripts"));
      writeFileSync(
        join(sandbox.workspace, "scripts", "check-version-bump.sh"),
        readText("scripts/check-version-bump.sh"),
        { mode: 0o755 },
      );
      const ctx = ciContext("pull_request");
      const event = (ctx.github as { event: { pull_request: Record<string, Value> } }).event;
      event.pull_request.base = { sha: sandbox.base };
      event.pull_request.head = { sha: sandbox.head, repo: { full_name: SAME_REPO } };
      return runStep(
        bumpStep(),
        ctx,
        { workspace: sandbox.workspace, temp: sandbox.workspace },
        { PATH: process.env.PATH ?? "" },
      );
    }

    it("passes the base and head shas of the pull request to the script, in a sandbox", () => {
      // The script fails only when the diff from the base to the head
      // touches a shipped file. So the exit codes show that it got both shas.
      expect(runBump(["README.md"]).status).toBe(0);
      expect(runBump(["src/a.ts"]).status).toBe(1);
    }, 30_000);
  });

  describe("the eval job gate (R8.3)", () => {
    const gate = (ctx: Record<string, Value>) => evaluateIf(String(ciJob("eval").if), ctx);

    it("needs the checks job", () => {
      expect([ciJob("eval").needs].flat()).toEqual(["checks"]);
    });

    it("runs on dispatch and on a pull request from the same repo", () => {
      expect(gate(ciContext("workflow_dispatch"))).toBe(true);
      expect(gate(ciContext("pull_request"))).toBe(true);
    });

    it("skips a pull request from a fork", () => {
      expect(gate(ciContext("pull_request", { headRepo: "someone/pr-review" }))).toBe(false);
    });
  });

  describe("the path filter (R8.3)", () => {
    function filter(paths: string[]): string {
      const sandbox = changeSandbox(paths);
      const out = join(tempDir("pr-review-ci-out-"), "output");
      const ctx = ciContext("pull_request");
      const event = (ctx.github as { event: { pull_request: Record<string, Value> } }).event;
      event.pull_request.base = { sha: sandbox.base };
      event.pull_request.head = { sha: sandbox.head, repo: { full_name: SAME_REPO } };
      const result = runStep(
        filterStep(),
        ctx,
        { workspace: sandbox.workspace, temp: sandbox.workspace },
        { GITHUB_OUTPUT: out, PATH: process.env.PATH ?? "" },
      );
      expect(result.status, result.stderr).toBe(0);
      return outputsOf(out).run ?? "";
    }

    it.each([
      "src/a.ts",
      "prompts/judge.md",
      "eval/baseline.json",
      "package.json",
      "package-lock.json",
    ])("runs the eval for a change to %s", (path) => {
      expect(filter(["README.md", path])).toBe("true");
    });

    it("skips the eval for changes outside the five rules", () => {
      expect(
        filter([
          "README.md",
          "docs/a.md",
          "test/a.test.ts",
          "scripts/a.sh",
          ".github/workflows/ci.yml",
          "srcx/a.ts",
          "a/src/b.ts",
          "package.json.bak",
          "docs/package-lock.json",
        ]),
      ).toBe("false");
    });

    it("always runs the eval on dispatch", () => {
      const out = join(tempDir("pr-review-ci-out-"), "output");
      const workspace = tempDir("pr-review-ci-empty-");
      const result = runStep(
        filterStep(),
        ciContext("workflow_dispatch"),
        { workspace, temp: workspace },
        { GITHUB_OUTPUT: out, PATH: process.env.PATH ?? "" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(outputsOf(out).run).toBe("true");
    });

    it("keys every later step of the job on the filter output", () => {
      const all = steps();
      const after = all.slice(all.indexOf(filterStep()) + 1);
      expect(after.length).toBeGreaterThan(0);
      for (const step of after) {
        expect(step.if ?? "", step.name).toMatch(/steps\.\w+\.outputs\.run == 'true'/);
      }
    });
  });

  describe("the eval steps (R8.4)", () => {
    it("checks out pr-review, then the cases, then installs and builds, then runs the eval, then uploads", () => {
      const all = steps();
      const checkout = all.findIndex(
        (s) => (s.uses ?? "").startsWith("actions/checkout@") && s.with?.path === undefined,
      );
      const install = all.findIndex(
        (s) => (s.run ?? "").includes("npm ci") && (s.run ?? "").includes("npm run build"),
      );
      const order = [
        checkout,
        all.indexOf(casesStep()),
        install,
        all.indexOf(evalStep()),
        all.indexOf(uploadStep()),
      ];
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("checks out the cases repo from the pin, with CASES_TOKEN and no persisted credentials", () => {
      const step = casesStep();
      expect(step.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(step.with?.token).toBe("${{ secrets.CASES_TOKEN }}");
      expect(String(step.with?.repository)).toMatch(/^\$\{\{\s*steps\.\w+\.outputs\.repo\s*\}\}$/);
      expect(String(step.with?.ref)).toMatch(/^\$\{\{\s*steps\.\w+\.outputs\.ref\s*\}\}$/);
    });

    it("reads the repo and the ref of eval/cases.json into the outputs that the checkout uses", () => {
      const step = casesStep();
      const pinId = /steps\.(\w+)\.outputs/.exec(String(step.with?.repository))?.[1];
      const pin = findStep(steps(), (s) => s.id === pinId, "pin");
      const workspace = tempDir("pr-review-ci-pin-");
      mkdirSync(join(workspace, "eval"));
      const ref = "0123456789abcdef0123456789abcdef01234567";
      writeFileSync(
        join(workspace, "eval", "cases.json"),
        JSON.stringify({ repo: "jerridan/pr-review-cases", ref }),
      );
      const out = join(workspace, "output");
      const result = runStep(
        pin,
        ciContext("pull_request"),
        { workspace, temp: workspace },
        { GITHUB_OUTPUT: out, PATH: process.env.PATH ?? "" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(outputsOf(out)).toEqual({ repo: "jerridan/pr-review-cases", ref });
    });

    it.each<[string, Record<string, unknown>]>([
      ["a repo that is not owner/name", { repo: "a b", ref: "0".repeat(40) }],
      ["a ref that is not a sha", { repo: "a/b", ref: "main; rm -rf /" }],
    ])("fails the pin step for %s", (_label, pinValue) => {
      const step = casesStep();
      const pinId = /steps\.(\w+)\.outputs/.exec(String(step.with?.repository))?.[1];
      const pin = findStep(steps(), (s) => s.id === pinId, "pin");
      const workspace = tempDir("pr-review-ci-pin-");
      mkdirSync(join(workspace, "eval"));
      writeFileSync(join(workspace, "eval", "cases.json"), JSON.stringify(pinValue));
      const out = join(workspace, "output");
      const result = runStep(
        pin,
        ciContext("pull_request"),
        { workspace, temp: workspace },
        { GITHUB_OUTPUT: out, PATH: process.env.PATH ?? "" },
      );
      expect(result.status).not.toBe(0);
      expect(outputsOf(out)).toEqual({});
    });

    function runEval(
      ctx: Record<string, Value>,
      exitCode: number,
    ): { status: number | null; args: string; summary: string; tokenSet: boolean } {
      const dir = tempDir("pr-review-ci-eval-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const log = join(dir, "node.log");
      writeFileSync(
        join(bin, "node"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" > '${log}'`,
          `if [ -n "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then echo token >> '${log}.token'; fi`,
          "echo 'REPORT-TABLE'",
          `exit ${exitCode}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const summary = join(dir, "summary.md");
      writeFileSync(summary, "BEFORE\n");
      const result = runStep(
        evalStep(),
        ctx,
        { workspace: dir, temp: dir },
        { GITHUB_STEP_SUMMARY: summary, PATH: `${bin}:${process.env.PATH ?? ""}` },
      );
      return {
        status: result.status,
        args: existsSync(log) ? readFileSync(log, "utf8").trim() : "",
        summary: readFileSync(summary, "utf8"),
        tokenSet: existsSync(`${log}.token`),
      };
    }

    it("runs the eval with the flags and repeat 3 on a pull request, and appends the table to the step summary", () => {
      const result = runEval(ciContext("pull_request"), 0);
      expect(result.status).toBe(0);
      expect(result.args).toBe(
        "dist/cli.js eval --cases eval/cases --repeat 3 --baseline eval/baseline.json --out pr-review-eval",
      );
      expect(result.summary).toBe(`BEFORE\n${FENCE}\nREPORT-TABLE\n${FENCE}\n`);
      expect(result.tokenSet).toBe(true);
      expect(evalStep().run).toContain("pipefail");
      expect(evalStep().run).toContain("GITHUB_STEP_SUMMARY");
    });

    it("runs the eval with the input repeat on dispatch", () => {
      expect(runEval(ciContext("workflow_dispatch", { repeat: "5" }), 0).args).toContain(
        "--repeat 5",
      );
    });

    it.each([1, 3])(
      "fails the step with the exit code %i of the eval, and still writes the summary (R8.5)",
      (code) => {
        const result = runEval(ciContext("pull_request"), code);
        expect(result.status).toBe(code);
        expect(result.summary).toContain("REPORT-TABLE");
      },
    );

    // GitHub renders the step summary as markdown. Without a fence, the
    // lines of the table join into one paragraph.
    it.each([0, 1, 3])(
      "puts the table in a code fence in the step summary, and keeps the exit code %i",
      (code) => {
        const result = runEval(ciContext("pull_request"), code);
        expect(result.status).toBe(code);
        expect(result.summary).toBe(`BEFORE\n${FENCE}\nREPORT-TABLE\n${FENCE}\n`);
      },
    );

    it("has no continue-on-error on the eval step, and uploads pr-review-eval/ also after a failure (R8.5)", () => {
      expect((evalStep() as StepWithFlags)["continue-on-error"]).toBeUndefined();
      const upload = uploadStep();
      expect(upload.if ?? "").toMatch(/always\(\)/);
      expect(String(upload.with?.path).replace(/\/$/, "")).toBe("pr-review-eval");
    });
  });

  it("runs one workflow for each pull request and cancels the run in progress (R8.6)", () => {
    const wf = loadCi();
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(true);
    const group = String(wf.concurrency?.group);
    const one = render(group, ciContext("pull_request"));
    expect(one).toContain(String(PR_NUMBER));
    const other = render(group, {
      ...ciContext("pull_request"),
      github: {
        event_name: "pull_request",
        repository: SAME_REPO,
        run_id: "1",
        event: { number: 8, pull_request: { number: 8 } },
      },
    });
    expect(other).not.toBe(one);
  });

  describe("secrets and pins (R8.7, R2.8, R6.6)", () => {
    it("pins every uses value to a full commit SHA", () => {
      const all = Object.values(loadCi().jobs).flatMap((job) => job.steps);
      const uses = all.flatMap((s) => (s.uses ? [s.uses] : []));
      expect(uses.length).toBeGreaterThan(0);
      for (const value of uses) expect(value).toMatch(SHA_PIN);
    });

    it("sets the permissions to contents: read only", () => {
      const wf = loadCi();
      expect(wf.permissions).toEqual({ contents: "read" });
      for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeUndefined();
    });

    it("holds no token-like string and never writes the baseline", () => {
      const text = readText(".github/workflows/ci.yml");
      expect(text).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|AKIA[0-9A-Z]{16}/);
      expect(text).not.toContain("write-baseline");
    });

    it("gives CASES_TOKEN to the cases checkout only, and CLAUDE_CODE_OAUTH_TOKEN to the eval step only", () => {
      const text = readText(".github/workflows/ci.yml");
      expect(text.match(/CASES_TOKEN/g)).toHaveLength(1);
      expect(casesStep().with?.token).toBe("${{ secrets.CASES_TOKEN }}");
      const env = evalStep().env ?? {};
      const secretKeys = Object.entries(env)
        .filter(([, value]) => String(value).includes("secrets."))
        .map(([key]) => key);
      expect(secretKeys).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
      const all = Object.values(loadCi().jobs).flatMap((job) => job.steps) as StepWithFlags[];
      for (const step of all) {
        if (step === casesStep() || step === evalStep()) continue;
        expect(JSON.stringify(step), step.name).not.toMatch(/secrets\./);
      }
      for (const step of all) expect(step.run ?? "").not.toMatch(/secrets\./);
    });
  });
});
