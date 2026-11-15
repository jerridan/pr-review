// D4c C1: the codex backend of pr-review replay. A fake "codex" on PATH
// answers each call, so the test needs no network and no credential.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayReport, ResultsFile } from "../src/eval/replay/index.js";
import { captureOutput, cleanup, makeFixture, output, tempDir } from "./fixtures/eval-fixture.js";
import {
  makeReplayInputs,
  REPLAY,
  replay,
  replayFake,
  type Made,
} from "./fixtures/replay-fixture.js";

const made: string[] = [];
afterAll(() => cleanup(made));
captureOutput();

let inputs: Made;
beforeAll(async () => {
  const fx = await makeFixture();
  made.push(fx.repo);
  inputs = await makeReplayInputs(made, fx);
}, 240_000);

// The fake codex logs its argv, prints the text of "stderr.txt", and writes
// the planned result for the claim in the prompt to the out file. The file
// "fail" makes it exit 1.
const SHIM = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
appendFileSync(join(dir, "log.jsonl"), JSON.stringify(argv) + "\\n");
const err = join(dir, "stderr.txt");
if (existsSync(err)) process.stderr.write(readFileSync(err, "utf8"));
if (existsSync(join(dir, "fail"))) process.exit(1);
const claim = /CLAIM-[A-Z0-9]+/.exec(argv[argv.length - 1])[0];
const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify(results[claim]));
`;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-review-replay-codex-"));
  writeFileSync(join(dir, "shim.mjs"), SHIM);
  writeFileSync(join(dir, "results.json"), JSON.stringify(REPLAY));
  writeFileSync(join(dir, "stderr.txt"), "tokens used\n1,000\n");
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "bin", "codex"),
    `#!/bin/sh\nexec node '${join(dir, "shim.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${join(dir, "bin")}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_CODEX_DIR", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const argvLog = (): string[][] =>
  readFileSync(join(dir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);

async function replayCodex() {
  const out = tempDir("replay-codex-out", made);
  const client = replayFake();
  const code = await replay(client, [
    "--cases",
    inputs.cases,
    "--from",
    inputs.full,
    "--out",
    out,
    "--format",
    "json",
    "--concurrency",
    "1",
    "--verifier",
    "codex:gpt-6.1-terra:medium",
  ]);
  return { code, out, client };
}

const entriesOf = (out: string) =>
  ["a-case", "b-case"].flatMap(
    (name) =>
      (
        JSON.parse(readFileSync(join(out, name, "results.json"), "utf8")) as ResultsFile
      ).entries,
  );

describe("pr-review replay: the codex verifier", () => {
  it("calls codex with the model and the effort of the arm, and stores cost null and the tokens", async () => {
    const { code, out, client } = await replayCodex();
    expect(code).toBe(0);
    const calls = argvLog();
    expect(calls).toHaveLength(6);
    for (const argv of calls) {
      expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-6.1-terra");
      expect(argv).toContain("model_reasoning_effort=medium");
    }
    expect(client.calls.filter((c) => c.role === "verifier")).toEqual([]);
    const entries = entriesOf(out);
    expect(entries).toHaveLength(6);
    for (const e of entries) {
      expect(e.call).toMatchObject({
        model: "gpt-6.1-terra",
        effort: "medium",
        cost_usd: null,
        tokens: 1000,
      });
    }
    expect((JSON.parse(output.stdout) as ReplayReport).cost.tokens).toBe(6000);
  }, 120_000);

  it("gives a failed codex call as a failure result, not a throw", async () => {
    writeFileSync(join(dir, "fail"), "");
    const { code, out } = await replayCodex();
    expect(code).toBe(0);
    const entries = entriesOf(out);
    expect(entries).toHaveLength(6);
    for (const e of entries) {
      expect(e.result).toMatchObject({
        kind: "thrown",
        message: expect.stringContaining("codex"),
      });
      expect(e.call).toMatchObject({ cost_usd: null, tokens: 1000 });
    }
  }, 120_000);

  it("names the quota in the failure of a call that hits the usage limit", async () => {
    writeFileSync(join(dir, "fail"), "");
    writeFileSync(
      join(dir, "stderr.txt"),
      "ERROR: You've hit your usage limit. Try again at 4:33 PM.\n",
    );
    const { out } = await replayCodex();
    expect(entriesOf(out)[0]?.result).toMatchObject({
      kind: "limit",
      message: expect.stringMatching(/quota/i),
    });
  }, 120_000);
});
