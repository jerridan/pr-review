#!/usr/bin/env bash
# Make an eval case from two commits of a git repo.
#
# Usage: make-case.sh <repo> <base> <head> <name>
#
# The script writes the directory <name> in the current directory. It holds:
#   - case.json: the name, the base sha and the head sha. The title and the
#     body come from the head commit message. The source is "pr". The origin
#     and the language are empty strings.
#   - repo.bundle: a git bundle that holds base, head and their history.
#   - diff.patch: the three-dot diff from base to head.
# The labeler then edits case.json and writes golden.json.
#
# The script does not change <repo>. It stops when <name> exists, so it
# never writes over a labelled case.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <repo> <base> <head> <name>" >&2
  exit 2
fi
repo="$1"
base_arg="$2"
head_arg="$3"
name="$4"

case "$name" in
  "" | . | .. | */*)
    echo "make-case: the name \"$name\" is not a directory name" >&2
    exit 2
    ;;
esac
if [ -e "$name" ]; then
  echo "make-case: $name exists. Remove it or use a different name." >&2
  exit 1
fi
if ! git -C "$repo" rev-parse --git-dir > /dev/null 2>&1; then
  echo "make-case: $repo is not a git repo" >&2
  exit 1
fi

resolve() {
  git -C "$repo" rev-parse --verify --quiet "$1^{commit}" || {
    echo "make-case: $1 is not a commit in $repo" >&2
    exit 1
  }
}
base="$(resolve "$base_arg")"
head="$(resolve "$head_arg")"

# A bundle holds refs, not bare shas. Put two refs in a temporary bare repo
# that borrows the objects of <repo>, so <repo> stays unchanged. The bundle
# then holds base also when base is not an ancestor of head.
work="$(mktemp -d "${TMPDIR:-/tmp}/make-case.XXXXXX")"
trap 'rm -rf "$work"' EXIT
objects="$(cd "$repo" && cd "$(git rev-parse --git-common-dir)" && pwd)/objects"
git init --quiet --bare "$work/refs.git"
echo "$objects" > "$work/refs.git/objects/info/alternates"
git -C "$work/refs.git" update-ref refs/heads/base "$base"
git -C "$work/refs.git" update-ref refs/heads/head "$head"

# Write into a temporary directory first, so a failure leaves no case.
out="$work/case"
mkdir "$out"
git -C "$work/refs.git" bundle create --quiet "$out/repo.bundle" refs/heads/base refs/heads/head
git -C "$repo" -c core.quotePath=false diff --no-color --no-ext-diff "$base...$head" > "$out/diff.patch"

title="$(git -C "$repo" log -1 --format=%s "$head")"
body="$(git -C "$repo" log -1 --format=%b "$head")"
NAME="$name" BASE="$base" HEAD_SHA="$head" TITLE="$title" BODY="$body" node -e '
const e = process.env;
const meta = {
  name: e.NAME,
  source: "pr",
  base: e.BASE,
  head: e.HEAD_SHA,
  title: e.TITLE,
  body: e.BODY,
  origin: "",
  language: "",
};
process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
' > "$out/case.json"

mv "$out" "$name"
echo "make-case: wrote $name. Write $name/golden.json next."
