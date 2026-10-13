import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/measure-passes.sh", import.meta.url));

// A stub for the pr-review command. It reads the passes value from the
// config on the base commit, so it shows which arm called it. In the
// one-pass arm, only the odd runs cover the planted line. In the
// two-pass arm, every run covers it. A covering run posts two findings;
// the other runs post one finding on another line.
const STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$STUB_DIR/calls.log"
base=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--base" ]; then base="$2"; fi
  shift
done
passes="$(git show "$base:.pr-review/config.yaml" | sed -n 's/^ *passes: *//p')"
count_file="$STUB_DIR/count-$passes"
n=0
if [ -f "$count_file" ]; then n="$(cat "$count_file")"; fi
n=$((n + 1))
echo "$n" > "$count_file"
line="$(grep -n 'i <= values.length' src/stats.ts | cut -d: -f1)"
if [ "$passes" = "2" ] || [ $((n % 2)) -eq 1 ]; then
  findings="{\\"file\\":\\"src/stats.ts\\",\\"start_line\\":$line,\\"end_line\\":$line},{\\"file\\":\\"src/stats.ts\\",\\"start_line\\":1,\\"end_line\\":1}"
  cost="0.3"
  if [ "$passes" = "1" ]; then cost="0.1"; fi
else
  findings="{\\"file\\":\\"src/stats.ts\\",\\"start_line\\":1,\\"end_line\\":1}"
  cost="0.1"
fi
echo "{\\"record_path\\":\\"/none\\",\\"tier\\":\\"full\\",\\"verdict\\":\\"would approve\\",\\"coverage\\":{},\\"excluded_files\\":[],\\"total_cost_usd\\":$cost,\\"queries_without_cost\\":0,\\"findings\\":[$findings]}"
`;

let work: string;
let stubDir: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pr-review-measure-"));
  stubDir = join(work, "stub");
  mkdirSync(join(stubDir, "bin"), { recursive: true });
  const stub = join(stubDir, "bin", "pr-review");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("scripts/measure-passes.sh (R6)", () => {
  it("has valid bash syntax", async () => {
    await expect(run("bash", ["-n", SCRIPT])).resolves.toBeDefined();
  });

  it("prints, per arm, the covering runs, the mean cost and the mean finding count", async () => {
    const { stdout } = await run("bash", [SCRIPT, "5"], {
      env: {
        ...process.env,
        PATH: `${join(stubDir, "bin")}:${process.env.PATH}`,
        STUB_DIR: stubDir,
      },
      timeout: 60_000,
    });
    const lines = stdout.split("\n").filter((l) => l.startsWith("passes="));
    expect(lines).toEqual([
      "passes=1: runs=5 failed=0 covered=3 mean_cost_usd=0.1000 mean_findings=1.60",
      "passes=2: runs=5 failed=0 covered=5 mean_cost_usd=0.3000 mean_findings=2.00",
    ]);
  }, 60_000);

  it("runs pr-review run with the base, the head and --format json, five times per arm", () => {
    const calls = readFileSync(join(stubDir, "calls.log"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(10);
    for (const call of calls) {
      expect(call).toMatch(/^run --base [0-9a-f]{40} --head [0-9a-f]{40} --format json$/);
    }
  });

  it("counts a run that fails and leaves it out of the means", async () => {
    const failDir = join(work, "fail-bin");
    mkdirSync(failDir, { recursive: true });
    const stub = join(failDir, "pr-review");
    writeFileSync(stub, "#!/usr/bin/env bash\necho boom >&2\nexit 1\n");
    chmodSync(stub, 0o755);
    const { stdout } = await run("bash", [SCRIPT, "2"], {
      env: { ...process.env, PATH: `${failDir}:${process.env.PATH}` },
      timeout: 60_000,
    });
    expect(stdout.split("\n").filter((l) => l.startsWith("passes="))).toEqual([
      "passes=1: runs=0 failed=2 covered=0 mean_cost_usd=unknown mean_findings=unknown",
      "passes=2: runs=0 failed=2 covered=0 mean_cost_usd=unknown mean_findings=unknown",
    ]);
  }, 60_000);

  it("exits 2 with a usage message when the run count is not a positive integer", async () => {
    for (const args of [[], ["0"], ["x"], ["1", "2"]]) {
      await expect(run("bash", [SCRIPT, ...args])).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("usage"),
      });
    }
  });
});
