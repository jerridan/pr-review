#!/usr/bin/env bash
# Fetch two commits of a remote repo into a new shallow repo, for make-case.sh.
#
# Usage: fetch-pr.sh <url> <base> <head> <dir>
#
# The script makes <dir>, fetches <base> and <head> from <url>, and deepens
# the history of <head> until <base> is an ancestor of <head>. So <dir>
# holds base, head and the commits between them, and nothing older. Give
# the merge base of the change as <base>: for a PR, the merge base of its
# head with its base branch. The GitHub compare API prints it as
# "merge_base_commit".
#
# The repo is shallow. make-case.sh writes the file "shallow" into the case
# from it, and the eval reads that file when it makes the checkout.
#
# The script stops when <dir> exists, and when <base> is not an ancestor
# of <head> after 1000 commits.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <url> <base> <head> <dir>" >&2
  exit 2
fi
url="$1"
base="$2"
head="$3"
dir="$4"

if [ -e "$dir" ]; then
  echo "fetch-pr: $dir exists. Remove it or use a different directory." >&2
  exit 1
fi

git init --quiet "$dir"
git -C "$dir" remote add origin "$url"
git -C "$dir" fetch --quiet --depth=1 origin "$base"
git -C "$dir" update-ref refs/heads/base "$base"
git -C "$dir" fetch --quiet --depth=1 origin "$head"
git -C "$dir" update-ref refs/heads/pr "$head"

depth=1
while ! git -C "$dir" merge-base --is-ancestor "$base" "$head"; do
  if [ "$depth" -ge 1000 ]; then
    echo "fetch-pr: $base is not an ancestor of $head within 1000 commits" >&2
    exit 1
  fi
  depth=$((depth + 20))
  git -C "$dir" fetch --quiet --deepen=20 origin "$head"
done
# The last step can bring commits older than base. Cut the history of head
# at base again, so the bundle holds no older tree.
count="$(git -C "$dir" rev-list --count "$base..$head")"
git -C "$dir" fetch --quiet --depth="$((count + 1))" origin "$head"
if ! git -C "$dir" merge-base --is-ancestor "$base" "$head"; then
  echo "fetch-pr: $base is not an ancestor of $head after the cut" >&2
  exit 1
fi
echo "fetch-pr: $dir holds $base and $head, $count commits apart."
