#!/usr/bin/env bash
# Build a fixture git repo in a new temporary directory.
#
# The base branch has one commit after the fork point, so a two-dot diff
# and a three-dot diff are different. The head branch:
#   - adds the function "average" to src/stats.ts, with an off-by-one bug
#     in the loop bound (the planted bug),
#   - moves src/util/format.ts to src/format.ts with no content change,
#   - changes package-lock.json,
#   - adds .github/workflows/ci.yml, which is a sensitive path.
#
# Options, each for the base commit after the fork (the BASE commit):
#   --pr-review-dir <dir>  copy <dir> to .pr-review/
#   --claude-md <file>     copy <file> to CLAUDE.md
# Options for the later states of the head branch:
#   --second-push          add a second commit on HEAD (HEAD2). It changes
#                          one hunk of src/stats.ts: line 14 gets a guard
#                          for an empty list, so the old text of line 14
#                          is gone.
#   --amend                amend HEAD2 with a new message only (HEAD3). The
#                          tree of HEAD3 is the tree of HEAD2. This option
#                          implies --second-push.
# With no option, the output does not change.
#
# Output lines: FIXTURE=<path>, BASE=<sha>, HEAD=<sha>, PLANTED=<file>:<line>,
# and HEAD2=<sha> with --second-push, HEAD3=<sha> with --amend.
set -euo pipefail

usage() {
  echo "usage: $0 [--pr-review-dir <dir>] [--claude-md <file>] [--second-push] [--amend]" >&2
  exit 2
}

pr_review_dir=""
claude_md=""
second_push=""
amend=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr-review-dir)
      [ "$#" -ge 2 ] || usage
      [ -d "$2" ] || { echo "make-fixture: $2 is not a directory" >&2; exit 2; }
      pr_review_dir="$(cd "$2" && pwd)"
      shift 2
      ;;
    --claude-md)
      [ "$#" -ge 2 ] || usage
      [ -f "$2" ] || { echo "make-fixture: $2 is not a file" >&2; exit 2; }
      claude_md="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
      shift 2
      ;;
    --second-push)
      second_push=1
      shift
      ;;
    --amend)
      second_push=1
      amend=1
      shift
      ;;
    *)
      usage
      ;;
  esac
done

# Do not let the user's git config change the result.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Fixture"
export GIT_AUTHOR_EMAIL="fixture@example.invalid"
export GIT_COMMITTER_NAME="Fixture"
export GIT_COMMITTER_EMAIL="fixture@example.invalid"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z"
export GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"

tmp_root="${TMPDIR:-/tmp}"
repo="$(mktemp -d "${tmp_root%/}/pr-review-fixture.XXXXXX")"
cd "$repo"

git init --quiet --initial-branch=main
git config commit.gpgsign false

mkdir -p src/util
cat > src/stats.ts <<'TS'
export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return total;
}
TS

cat > src/util/format.ts <<'TS'
export function formatCount(count: number, noun: string): string {
  const plural = count === 1 ? noun : `${noun}s`;
  return `${count} ${plural}`;
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) {
    return "0%";
  }
  return `${Math.round((part / whole) * 100)}%`;
}
TS

cat > package-lock.json <<'JSON'
{
  "name": "fixture",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "fixture", "version": "1.0.0" }
  }
}
JSON

cat > README.md <<'MD'
# Fixture

A small repo for pr-review tests.
MD

git add -A
git commit --quiet -m "Base: sum, format helpers, lockfile"

git checkout --quiet -b feature

cat >> src/stats.ts <<'TS'

export function average(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}
TS

git mv src/util/format.ts src/format.ts

cat > package-lock.json <<'JSON'
{
  "name": "fixture",
  "version": "1.1.0",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "fixture", "version": "1.1.0" }
  }
}
JSON

mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YAML'
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
YAML

git add -A
git commit --quiet -m "Head: add average, move format helpers, bump lockfile, add CI"
head_sha="$(git rev-parse HEAD)"

head2_sha=""
head3_sha=""
if [ -n "$second_push" ]; then
  # Write the whole file, so the result does not depend on a sed variant.
  cat > src/stats.ts <<'TS'
export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return total;
}

export function average(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return values.length === 0 ? 0 : total / values.length;
}
TS
  git commit --quiet -am "Head 2: return 0 for an empty list"
  head2_sha="$(git rev-parse HEAD)"
fi
if [ -n "$amend" ]; then
  git commit --quiet --amend -m "Head 2: return 0 for an empty list in average"
  head3_sha="$(git rev-parse HEAD)"
fi

git checkout --quiet main
cat >> README.md <<'MD'

The base branch moved on after the fork.
MD
if [ -n "$pr_review_dir" ] || [ -n "$claude_md" ]; then
  if [ -n "$pr_review_dir" ]; then
    mkdir -p .pr-review
    cp -R "$pr_review_dir/." .pr-review/
  fi
  if [ -n "$claude_md" ]; then
    cp "$claude_md" CLAUDE.md
  fi
  git add -A
  git commit --quiet -m "Base: extend README after the fork"
else
  git commit --quiet -am "Base: extend README after the fork"
fi
base_sha="$(git rev-parse HEAD)"

# Leave the head commit checked out, as a PR checkout has it.
git checkout --quiet feature

planted_line="$(grep -n 'i <= values.length' src/stats.ts | cut -d: -f1)"

echo "FIXTURE=$repo"
echo "BASE=$base_sha"
echo "HEAD=$head_sha"
echo "PLANTED=src/stats.ts:$planted_line"
if [ -n "$head2_sha" ]; then echo "HEAD2=$head2_sha"; fi
if [ -n "$head3_sha" ]; then echo "HEAD3=$head3_sha"; fi
