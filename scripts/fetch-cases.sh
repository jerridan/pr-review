#!/usr/bin/env bash
# Bring the pinned eval case set to eval/cases/ for a local run.
#
# Usage: fetch-cases.sh [<source>]
#
# Run the script from the root of the pr-review repo. It reads "repo" and
# "ref" from eval/cases.json. It gets the cases from <source>, a git url or
# a local path. With no <source>, it uses https://github.com/<repo>.git.
# The script uses git only. git finds your GitHub login through the
# credential helper that "gh auth setup-git" installs.
#
#   - When eval/cases/ does not exist, the script clones the source there
#     and checks out the ref. A failure leaves no eval/cases/.
#   - When eval/cases/ is the top level of a git work tree, the script
#     fetches from the source and checks out the ref in place.
#   - When eval/cases exists in a different form, the script stops with a
#     message and changes nothing.
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [<source>]" >&2
  exit 2
fi

pin="eval/cases.json"
target="eval/cases"

if [ ! -f "$pin" ]; then
  echo "fetch-cases: $pin is missing. Run this script from the root of the pr-review repo." >&2
  exit 1
fi

# Print the string value of one key of the pin file, or fail.
pin_value() {
  PIN="$pin" KEY="$1" node -e '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync(process.env.PIN, "utf8"))[process.env.KEY];
if (typeof value !== "string" || value === "") {
  console.error(`fetch-cases: ${process.env.PIN} has no string "${process.env.KEY}"`);
  process.exit(1);
}
process.stdout.write(value);
'
}
repo="$(pin_value repo)"
ref="$(pin_value ref)"
source="${1:-https://github.com/$repo.git}"

# Get the ref into the repo at $1 from the source. First fetch the branches
# and the tags. When the ref is still missing, fetch it by name or sha.
fetch_ref() {
  git -C "$1" fetch --quiet --tags "$source" '+refs/heads/*:refs/remotes/origin/*'
  if ! git -C "$1" rev-parse --verify --quiet "$ref^{commit}" > /dev/null; then
    git -C "$1" fetch --quiet "$source" "$ref" || true
  fi
  if ! git -C "$1" rev-parse --verify --quiet "$ref^{commit}" > /dev/null; then
    echo "fetch-cases: the ref $ref is not in $source" >&2
    return 1
  fi
}

if [ ! -e "$target" ] && [ ! -L "$target" ]; then
  # Clone into a temporary directory, then move it into place.
  tmp="$(mktemp -d "eval/.cases-fetch.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  git clone --quiet --no-checkout "$source" "$tmp/cases"
  fetch_ref "$tmp/cases"
  git -C "$tmp/cases" checkout --quiet --detach "$ref^{commit}"
  mv "$tmp/cases" "$target"
  echo "fetch-cases: $target is at $(git -C "$target" rev-parse HEAD)"
  exit 0
fi

# Only the top level of a work tree counts. A plain directory inside the
# pr-review work tree must not change the pr-review checkout.
top=""
if [ -d "$target" ] && [ ! -L "$target" ]; then
  top="$(git -C "$target" rev-parse --show-toplevel 2> /dev/null || true)"
fi
if [ -z "$top" ] || [ "$(cd "$top" && pwd -P)" != "$(cd "$target" && pwd -P)" ]; then
  echo "fetch-cases: $target exists and is not a git work tree. Move it away and run again." >&2
  exit 1
fi

fetch_ref "$target"
git -C "$target" checkout --quiet --detach "$ref^{commit}"
echo "fetch-cases: $target is at $(git -C "$target" rev-parse HEAD)"
