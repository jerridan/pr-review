#!/usr/bin/env bash
# The D1 acceptance check (spec R11). It makes real SDK calls, so it needs
# a Claude login on this machine.
#
# Steps: build, put a pr-review wrapper on PATH for this process only,
# build the fixture repo, run the exact command from inside the fixture,
# and check that the record has a posted finding with a verifier pass on
# the planted line. It prints the cost, copies the record to
# ./pr-review-records in this repo, and removes the fixture.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "ACCEPTANCE FAILED: $*" >&2
  exit 1
}

cd "$root"
npm run build

work="$(mktemp -d "${TMPDIR:-/tmp}/pr-review-acceptance.XXXXXX")"
fixture=""
cleanup() {
  if [[ -n "$fixture" ]]; then rm -rf "$fixture"; fi
  rm -rf "$work"
}
trap cleanup EXIT

# A wrapper for dist/cli.js, so "npm link" is not necessary.
mkdir -p "$work/bin"
cat > "$work/bin/pr-review" <<WRAPPER
#!/usr/bin/env bash
exec node "$root/dist/cli.js" "\$@"
WRAPPER
chmod +x "$work/bin/pr-review"
export PATH="$work/bin:$PATH"

fixture_output="$(bash "$root/scripts/make-fixture.sh")"
value() { printf '%s\n' "$fixture_output" | sed -n "s/^$1=//p"; }
fixture="$(value FIXTURE)"
base="$(value BASE)"
head="$(value HEAD)"
planted="$(value PLANTED)"
[[ -n "$fixture" && -n "$base" && -n "$head" && -n "$planted" ]] || fail "make-fixture.sh output is not complete"
echo "Fixture: $fixture"
echo "Planted bug: $planted"

cd "$fixture"
set +e
pr-review run --base "$base" --head "$head" --format json > "$work/out.json"
code=$?
set -e
cd "$root"
[[ "$code" -eq 0 ]] || fail "pr-review run exited $code, not 0"

PLANTED="$planted" node --input-type=module - "$work/out.json" <<'NODE'
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const fail = (message) => {
  console.error(`ACCEPTANCE FAILED: ${message}`);
  process.exit(1);
};
const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const record = JSON.parse(readFileSync(doc.record_path, "utf8"));
const [file, lineText] = process.env.PLANTED.split(":");
const line = Number(lineText);

console.log(`Tier: ${doc.tier}`);
console.log(`Verdict: ${doc.verdict}`);
console.log(`Posted findings: ${doc.findings.length}`);

const hit = record.posted.findings.find(
  (f) =>
    f.file === file &&
    f.start_line <= line &&
    f.end_line >= line &&
    f.verifier.in_scope &&
    f.verifier.claim_holds &&
    f.verifier.score >= 80,
);
const verified = record.stages.verifications.some(
  (v) => v.passed && v.finding.file === file && v.finding.start_line <= line && v.finding.end_line >= line,
);
// The total is a lower bound when a query has no cost, as in the table output.
const cost = record.cost.total_cost_usd;
const missing = record.cost.queries_without_cost;
const note = missing > 0 ? ` (${missing} ${missing === 1 ? "query" : "queries"} without a cost)` : "";
const total = cost === null ? "unknown" : `${missing > 0 ? "at least " : ""}$${cost.toFixed(4)}`;
console.log(`Total cost: ${total}${note}`);

mkdirSync("pr-review-records", { recursive: true });
const kept = join("pr-review-records", `acceptance-${basename(doc.record_path)}`);
copyFileSync(doc.record_path, kept);
console.log(`Record: ${kept}`);

if (!hit) fail(`no posted finding covers ${process.env.PLANTED} with a verifier pass`);
if (!verified) fail(`no passed verification covers ${process.env.PLANTED}`);
console.log(`Found: ${hit.file}:${hit.start_line}-${hit.end_line} ${hit.severity} score ${hit.score}: ${hit.claim}`);
console.log("ACCEPTANCE PASSED");
NODE
