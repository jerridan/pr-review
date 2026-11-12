#!/usr/bin/env bash
# Make an eval case by bug injection.
#
# Usage: inject-case.sh <repo> <base> <head> <patch> <message-file> <name>
#
# <base> and <head> are two commits of <repo>, for example the merge base and
# the head of a merged PR. <patch> is a bug patch that applies to the tree of
# <head>. <message-file> holds the PR title on its first line and the PR body
# after it.
#
# The script builds one new commit. Its parent is <base>. Its tree is the tree
# of <head> with <patch> applied. Its message is <message-file>. Then it calls
# scripts/make-case.sh with <base> and the new commit. So the history, the
# blame and the PR text of the case do not show the injection.
#
# The script writes the directory <name> in the current directory. It holds
# the files that make-case.sh writes, with two differences:
#   - case.json has the source "injection".
#   - injection.patch is a copy of <patch>, for a person to read.
# The labeler then edits origin and language in case.json and writes
# golden.json.
#
# The commit has a fixed author, a fixed committer and a fixed date. The same
# inputs give the same head sha.
#
# The script does not change <repo>. It stops when <name> exists, when <patch>
# or <message-file> is missing, or when <patch> does not apply to <head>. In
# each case it leaves no <name>.
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: $0 <repo> <base> <head> <patch> <message-file> <name>" >&2
  exit 2
fi
repo="$1"
base_arg="$2"
head_arg="$3"
patch="$4"
message="$5"
name="$6"

case "$name" in
  "" | . | .. | */*)
    echo "inject-case: the name \"$name\" is not a directory name" >&2
    exit 2
    ;;
esac
if [ -e "$name" ]; then
  echo "inject-case: $name exists. Remove it or use a different name." >&2
  exit 1
fi
for f in "$patch" "$message"; do
  if [ ! -f "$f" ]; then
    echo "inject-case: $f is not a file" >&2
    exit 1
  fi
done
if ! git -C "$repo" rev-parse --git-dir > /dev/null 2>&1; then
  echo "inject-case: $repo is not a git repo" >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
# Make the paths absolute, because the script changes directory below.
patch="$(cd "$(dirname "$patch")" && pwd)/$(basename "$patch")"
message="$(cd "$(dirname "$message")" && pwd)/$(basename "$message")"

resolve() {
  git -C "$repo" rev-parse --verify --quiet "$1^{commit}" || {
    echo "inject-case: $1 is not a commit in $repo" >&2
    exit 1
  }
}
base="$(resolve "$base_arg")"
head="$(resolve "$head_arg")"

# Build the new commit in a temporary bare repo that borrows the objects of
# <repo>, so <repo> stays unchanged. A shallow repo lacks the parents of its
# boundary commits, so the temporary repo gets the same boundary.
work="$(mktemp -d "${TMPDIR:-/tmp}/inject-case.XXXXXX")"
trap 'rm -rf "$work"' EXIT
common="$(cd "$repo" && cd "$(git rev-parse --git-common-dir)" && pwd)"
tmp="$work/inject.git"
git init --quiet --bare "$tmp"
echo "$common/objects" > "$tmp/objects/info/alternates"
if [ -f "$common/shallow" ]; then
  cp "$common/shallow" "$tmp/shallow"
fi

export GIT_DIR="$tmp"
export GIT_INDEX_FILE="$work/index"
git read-tree "$head"
if ! git apply --cached "$patch"; then
  echo "inject-case: $patch does not apply to $head_arg" >&2
  exit 1
fi
tree="$(git write-tree)"
new="$(
  GIT_AUTHOR_NAME="pr-review inject-case" GIT_AUTHOR_EMAIL="inject-case@example.invalid" \
    GIT_AUTHOR_DATE="2020-01-01T00:00:00 +0000" \
    GIT_COMMITTER_NAME="pr-review inject-case" GIT_COMMITTER_EMAIL="inject-case@example.invalid" \
    GIT_COMMITTER_DATE="2020-01-01T00:00:00 +0000" \
    git -c commit.gpgsign=false commit-tree "$tree" -p "$base" -F "$message"
)"
unset GIT_DIR GIT_INDEX_FILE

# Write the case with make-case.sh into a temporary directory, so a failure
# leaves no case.
mkdir "$work/out"
(cd "$work/out" && bash "$here/make-case.sh" "$tmp" "$base" "$new" "$name" > /dev/null)
cp "$patch" "$work/out/$name/injection.patch"
CASE_JSON="$work/out/$name/case.json" node --input-type=module -e '
import fs from "node:fs";
const file = process.env.CASE_JSON;
const meta = JSON.parse(fs.readFileSync(file, "utf8"));
meta.source = "injection";
fs.writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
'

mv "$work/out/$name" "$name"
echo "inject-case: wrote $name. Edit origin and language in $name/case.json. Write $name/golden.json next."
