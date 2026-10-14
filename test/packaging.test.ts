// Tests for the CI and Claude Code packaging (R9, R10, R11): the composite
// action, the reusable workflow, the plugin manifests and the /review command.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Run one workflow step in the sandbox, with its env rendered for "ctx". */
function runStep(
  step: Step,
  ctx: Record<string, Value>,
  runner: { workspace: string; temp: string },
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {
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

function remoteFiles(remote: string): string[] {
  return git(remote, "ls-tree", "-r", "--name-only", "pr-review-records")
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
}

// ---------------------------------------------------------------------------

describe("action.yml (R9)", () => {
  it("is a composite action with the five inputs and the two outputs", () => {
    const action = loadAction();
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs).sort()).toEqual([
      "allow-api-key",
      "fresh",
      "out",
      "pr",
      "tier",
    ]);
    expect(action.inputs.pr?.required).toBe(true);
    expect(action.inputs.out?.default).toBe("pr-review-records");
    for (const name of ["tier", "fresh", "allow-api-key"]) {
      expect(action.inputs[name]?.required ?? false).toBe(false);
    }
    expect(Object.keys(action.outputs).sort()).toEqual(["record", "verdict"]);
    for (const output of Object.values(action.outputs)) {
      expect(output.value).toMatch(/\$\{\{\s*steps\.[\w-]+\.outputs\.[\w-]+\s*\}\}/);
    }
  });

  it("reads no secret", () => {
    const text = readText("action.yml");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/github\.token/);
  });

  it("pins every uses to a major tag", () => {
    for (const step of loadAction().runs.steps) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@v\d+$/);
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

  it("runs npm ci and npm run build in the action path, never in the workspace", () => {
    const steps = loadAction().runs.steps;
    const ci = findStep(steps, (s) => /^\s*npm ci\s*$/.test(s.run ?? ""), "npm ci");
    const build = findStep(steps, (s) => /^\s*npm run build\s*$/.test(s.run ?? ""), "npm build");
    for (const step of [ci, build]) {
      expect(step["working-directory"]).toMatch(/^\$\{\{\s*github\.action_path\s*\}\}$/);
      expect(step.shell).toBe("bash");
    }
    expect(steps.indexOf(ci)).toBeLessThan(steps.indexOf(build));
  });

  it("runs the CLI against the workspace with the retry watchdog", () => {
    const steps = loadAction().runs.steps;
    const cli = findStep(steps, (s) => (s.run ?? "").includes("dist/cli.js"), "cli");
    expect(cli.env?.CLAUDE_CODE_RETRY_WATCHDOG).toBe("1");
    expect(cli.run).toMatch(/node "\$GITHUB_ACTION_PATH\/dist\/cli\.js"/);
    expect(cli.run).toMatch(/run --format github --pr/);
    expect(cli.run).toMatch(/--repo "(\$GITHUB_WORKSPACE|\$\{\{ github\.workspace \}\})"/);
    // Every input reaches the script through env, never as a "${{ }}" text.
    expect(cli.run).not.toMatch(/\$\{\{/);
    expect(cli.shell).toBe("bash");
  });

  // Run the CLI step with a fake dist/cli.js. The fake prints the arguments
  // to stderr and one JSON document to stdout, and exits with FAKE_EXIT.
  function runCliStep(
    inputs: Record<string, string>,
    fakeExit: number,
    stdout?: string,
  ): { status: number | null; args: string[]; outputs: string; stdout: string } {
    const action = loadAction();
    const cli = findStep(action.runs.steps, (s) => (s.run ?? "").includes("dist/cli.js"), "cli");
    const base = tempDir("pr-review-action-");
    const actionPath = join(base, "action");
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
      github: { workspace, action_path: actionPath },
    };
    const env: Record<string, string> = {
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: base,
    };
    for (const [key, value] of Object.entries(cli.env ?? {})) env[key] = render(value, ctx);
    const result = runScript(render(cli.run, ctx), env, workspace);
    const argsLine = result.stderr.split("\n").find((line) => line.startsWith("ARGS"));
    const args = argsLine ? (JSON.parse(argsLine.slice(4)) as string[]) : [];
    return {
      status: result.status,
      args,
      outputs: readFileSync(outputFile, "utf8"),
      stdout: result.stdout,
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
    expect(group).toContain("github.event.pull_request.number");
    expect(group).toContain("github.event.issue.number");
    const fromPr = render(group, context("pull_request", prEvent("opened", false)));
    const fromComment = render(
      group,
      context("issue_comment", commentEvent("@pr-review full", "MEMBER")),
    );
    expect(fromPr).toBe(fromComment);
    expect(fromPr).toContain(String(PR_NUMBER));
  });

  it("names the comment text, the three associations and the label filter in the job if", () => {
    const gate = String(loadJob().if);
    expect(gate).toContain("@pr-review full");
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(gate).toContain(association);
    }
    expect(gate).toContain("github.event.issue.pull_request");
    expect(gate).toMatch(/startsWith\(github\.event\.label\.name, 'review:'\)/);
  });

  it("holds the fork gate in one if expression with head.repo.fork and pull_request_target", () => {
    const job = loadJob();
    const ifs = [job.if, ...job.steps.map((s) => s.if)].filter(
      (v): v is string => typeof v === "string",
    );
    expect(ifs.some((v) => v.includes("head.repo.fork") && v.includes("pull_request_target"))).toBe(
      true,
    );
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

  it("checks out refs/pull/<n>/head with fetch-depth 0 and fetches the head and the base", () => {
    const steps = loadJob().steps;
    const checkout = findStep(
      steps,
      (s) => s.uses?.startsWith("actions/checkout@") ?? false,
      "checkout",
    );
    expect(checkout.uses).toBe("actions/checkout@v4");
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    expect(String(checkout.with?.ref)).toMatch(/^refs\/pull\/\$\{\{.+\}\}\/head$/);
    expect(render(checkout.with?.ref, context("pull_request", prEvent("opened", false)))).toBe(
      `refs/pull/${PR_NUMBER}/head`,
    );
    const fetch = findStep(
      steps,
      (s) =>
        /git -C "\$GITHUB_WORKSPACE" fetch/.test(s.run ?? "") && /refs\/pull\//.test(s.run ?? ""),
      "fetch",
    );
    expect(fetch.run).toMatch(/refs\/pull\/\$\{?PR_NUMBER\}?\/head/);
    expect(fetch.run).toMatch(/BASE_REF/);
    expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(fetch));
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

  it("runs the action by jerridan/pr-review@v1 with the two env keys", () => {
    const steps = loadJob().steps;
    const review = findStep(steps, (s) => s.uses === "jerridan/pr-review@v1", "action");
    expect(review.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(review.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(String(review.with?.out)).toBe("${{ runner.temp }}/pr-review-records");
    expect(render(review.with?.pr, context("pull_request", prEvent("opened", false)))).toBe(
      String(PR_NUMBER),
    );
  });

  describe("the tier and fresh inputs of the action step", () => {
    const inputs = (eventName: string, event: Record<string, Value>) => {
      const review = findStep(loadJob().steps, (s) => s.uses === "jerridan/pr-review@v1", "action");
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

  it("uploads the record directory as an artifact with if: always()", () => {
    const steps = loadJob().steps;
    const upload = findStep(
      steps,
      (s) => s.uses?.startsWith("actions/upload-artifact@") ?? false,
      "upload",
    );
    expect(upload.uses).toBe("actions/upload-artifact@v4");
    expect(upload.if).toMatch(/always\(\)/);
    const ctx = context("pull_request", prEvent("opened", false));
    expect(render(upload.with?.name, ctx)).toBe(`pr-review-record-${PR_NUMBER}-4242`);
    expect(render(upload.with?.path, ctx)).toMatch(/^\/runner\/temp\/pr-review-records/);
    const review = findStep(steps, (s) => s.uses === "jerridan/pr-review@v1", "action");
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
    const review = findStep(steps, (s) => s.uses === "jerridan/pr-review@v1", "action");
    expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(review));
    expect(steps.indexOf(push)).toBeGreaterThan(steps.indexOf(review));
    expect(push.if).toMatch(/always\(\)/);
    expect(checkout.run).toMatch(/git -C "\$GITHUB_WORKSPACE" fetch/);
    expect(checkout.run).toMatch(/\$RUNNER_TEMP\/pr-review-records|RECORDS_DIR/);
    expect(push.run).toMatch(/rebase/);
  });

  function recordsRun(sandbox: { workspace: string; temp: string }) {
    const { checkout, push } = recordsSteps();
    const ctx = context("pull_request", prEvent("opened", false));
    (ctx.runner as Record<string, Value>).temp = sandbox.temp;
    return {
      checkout: () => runStep(checkout, ctx, sandbox),
      push: () => runStep(push, ctx, sandbox),
      dir: join(sandbox.temp, "pr-review-records"),
    };
  }

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
  });

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
  });

  it("skips the commit and the push when there is no new record", () => {
    const sandbox = makeSandbox(true);
    const run = recordsRun(sandbox);
    expect(run.checkout().status).toBe(0);
    const before = git(sandbox.remote, "rev-parse", "pr-review-records");
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(git(sandbox.remote, "rev-parse", "pr-review-records")).toBe(before);
  });

  it("skips the push when the records directory is absent", () => {
    const sandbox = makeSandbox(true);
    const run = recordsRun(sandbox);
    const pushed = run.push();
    expect(pushed.status, pushed.stderr).toBe(0);
  });

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
  });

  it("limits the push to three fetch-and-rebase retries", () => {
    const { push } = recordsSteps();
    expect(push.run).toMatch(/\b3\b/);
    expect(push.run).toMatch(/non-fast-forward|rejected|fetch first/);
  });

  it("runs no npm, make, sh or other script from the workspace", () => {
    for (const step of loadJob().steps) {
      if (step.uses !== undefined) {
        expect(step.uses).not.toMatch(/^\.\//);
        expect(step.uses).toMatch(/@v\d+$/);
      }
      expect(step.shell ?? "bash").toBe("bash");
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

  it("puts no token in a command line and no secret in another step", () => {
    for (const step of loadJob().steps) {
      const run = step.run ?? "";
      expect(run).not.toMatch(/secrets\./);
      expect(run).not.toMatch(/github\.token/);
      expect(run).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|x-access-token/);
      if (step.uses !== "jerridan/pr-review@v1") {
        expect(JSON.stringify(step.env ?? {})).not.toMatch(/secrets\.|github\.token/);
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
    owner: { name: string };
    plugins: { name: string; source: string; description: string; version: string }[];
  }

  it("has a plugin manifest named pr-review", () => {
    const plugin = JSON.parse(readText(".claude-plugin/plugin.json")) as PluginManifest;
    expect(plugin.name).toBe("pr-review");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.author.name.length).toBeGreaterThan(0);
  });

  it("has a marketplace manifest with one pr-review entry at the same version", () => {
    const plugin = JSON.parse(readText(".claude-plugin/plugin.json")) as PluginManifest;
    const market = JSON.parse(readText(".claude-plugin/marketplace.json")) as MarketplaceManifest;
    expect(market.name).toBe("pr-review");
    expect(market.owner.name.length).toBeGreaterThan(0);
    expect(market.plugins).toHaveLength(1);
    const entry = market.plugins[0];
    expect(entry?.name).toBe("pr-review");
    expect(entry?.source).toBe("./");
    expect(entry?.description.length).toBeGreaterThan(0);
    expect(entry?.version).toBe(plugin.version);
  });

  it("has a /review command with a description and the pr-review run text", () => {
    const text = readText("commands/review.md");
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    expect(m).not.toBeNull();
    const frontmatter = parse(m?.[1] ?? "") as Record<string, unknown>;
    expect(typeof frontmatter.description).toBe("string");
    expect(String(frontmatter.description).length).toBeGreaterThan(0);
    const body = m?.[2] ?? "";
    expect(body).toContain("pr-review run");
    expect(body).toContain(
      "pr-review run --base $(git merge-base origin/HEAD HEAD) --head HEAD --format table",
    );
    expect(body).toContain("gh pr view");
    expect(body).toContain("--pr <n>");
    expect(body).toContain("--format github");
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
