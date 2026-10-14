#!/usr/bin/env bash
# Measure the recall of the diff-bugs reviewer with one pass against two
# passes (spec R6). It makes real SDK calls through the pr-review command
# on PATH, so it needs a Claude login on this machine and it costs money.
#
# usage: measure-passes.sh <runs>
#
# The script builds the fixture repo twice. Each fixture holds a
# .pr-review/config.yaml on its base commit. The first sets
# reviewers.diff-bugs.passes to 1. The second sets it to 2. Both also set
# enabled to false for the six other built-in reviewers. So every posted
# finding comes from diff-bugs. For each arm
# the script runs "pr-review run --base <sha> --head <sha> --format json"
# <runs> times inside the fixture, and then prints one line:
#
#   passes=<n>: runs=<ok> failed=<bad> covered=<k> mean_cost_usd=<c> mean_findings=<f>
#
# covered is the number of runs whose posted findings cover the planted
# line. Only diff-bugs runs, so covered measures diff-bugs alone. The means are over the runs that finished. A run that exits with
# an error counts as failed and is left out of the counts and the means.
set -euo pipefail

usage() {
  echo "usage: $0 <runs>   (runs is a positive integer)" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
runs="$1"
case "$runs" in
  '' | *[!0-9]*) usage ;;
esac
[ "$runs" -ge 1 ] || usage

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "measure-passes: $*" >&2
  exit 1
}

command -v pr-review > /dev/null 2>&1 || fail "the pr-review command is not on PATH (run npm link, or see scripts/acceptance.sh)"
command -v node > /dev/null 2>&1 || fail "node is not on PATH"

work="$(mktemp -d "${TMPDIR:-/tmp}/pr-review-measure.XXXXXX")"
fixtures=()
cleanup() {
  for fixture in ${fixtures[@]+"${fixtures[@]}"}; do
    rm -rf "$fixture"
  done
  rm -rf "$work"
}
trap cleanup EXIT

# The built-in reviewers other than diff-bugs. The config turns them off.
other_reviewers=(conventions tests security history description-drift docs-and-comments)

for passes in 1 2; do
  # The config goes to the base commit of the fixture.
  config_dir="$work/config-$passes"
  out_dir="$work/out-$passes"
  mkdir -p "$config_dir" "$out_dir"
  {
    printf 'reviewers:\n  diff-bugs:\n    passes: %s\n' "$passes"
    for other in "${other_reviewers[@]}"; do
      printf '  %s:\n    enabled: false\n' "$other"
    done
  } > "$config_dir/config.yaml"

  fixture_output="$(bash "$root/scripts/make-fixture.sh" --pr-review-dir "$config_dir")"
  value() { printf '%s\n' "$fixture_output" | sed -n "s/^$1=//p"; }
  fixture="$(value FIXTURE)"
  base="$(value BASE)"
  head="$(value HEAD)"
  planted="$(value PLANTED)"
  [ -n "$fixture" ] && [ -n "$base" ] && [ -n "$head" ] && [ -n "$planted" ] || fail "make-fixture.sh output is not complete"
  fixtures+=("$fixture")

  failed=0
  done_files=()
  for ((i = 1; i <= runs; i++)); do
    echo "passes=$passes: run $i of $runs" >&2
    result="$out_dir/run-$i.json"
    if (cd "$fixture" && pr-review run --base "$base" --head "$head" --format json) > "$result" 2> "$out_dir/run-$i.err"; then
      done_files+=("$result")
    else
      failed=$((failed + 1))
      echo "passes=$passes: run $i failed:" >&2
      sed 's/^/  /' "$out_dir/run-$i.err" >&2
    fi
  done

  PASSES="$passes" PLANTED="$planted" FAILED="$failed" node --input-type=module - ${done_files[@]+"${done_files[@]}"} <<'NODE'
import { readFileSync } from "node:fs";

const [file, lineText] = process.env.PLANTED.split(":");
const line = Number(lineText);
let covered = 0;
let findings = 0;
const costs = [];
const files = process.argv.slice(2);
for (const path of files) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  findings += doc.findings.length;
  if (typeof doc.total_cost_usd === "number") costs.push(doc.total_cost_usd);
  if (doc.findings.some((f) => f.file === file && f.start_line <= line && f.end_line >= line)) {
    covered += 1;
  }
}
const mean = (sum, count) => (count > 0 ? (sum / count).toFixed(4) : "unknown");
const meanCount = files.length > 0 ? (findings / files.length).toFixed(2) : "unknown";
const meanCost = mean(
  costs.reduce((sum, c) => sum + c, 0),
  costs.length,
);
console.log(
  `passes=${process.env.PASSES}: runs=${files.length} failed=${process.env.FAILED} covered=${covered} mean_cost_usd=${meanCost} mean_findings=${meanCount}`,
);
NODE
done
