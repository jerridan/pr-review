#!/usr/bin/env bash
# Create the GitHub release v<version> for the version in package.json.
#
# The release workflow runs this script after each push to main. GitHub
# creates the tag and the release together from one "gh release create"
# call. So the script runs no "git tag" and no "git push", and it needs no
# git identity. The script never moves a tag that exists.
#
# Usage: scripts/release-tag.sh [--dry-run]
#
# Env:
# - GITHUB_REF must be refs/heads/main for a real run.
# - GH_TOKEN must be set for a real run. gh reads it.
# - RELEASE_DRY_RUN=true selects a dry run, as --dry-run does.
#
# A dry run prints what the script would do and runs no gh command.
# The script exits 0 when the release exists or when it creates it.
# It exits 1 with a one-line reason in every other case.
set -euo pipefail

fail() {
  echo "release-tag: $1" >&2
  exit 1
}

dry_run=false
if [ "${RELEASE_DRY_RUN:-}" = "true" ]; then
  dry_run=true
fi
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

root="$(git rev-parse --show-toplevel 2> /dev/null)" || fail "the current directory is not in a git repository."

# Read the version from package.json. Print an empty string when the field
# is absent or is not a string.
version="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof pkg.version === "string" ? pkg.version : "");
' "$root/package.json" 2> /dev/null)" || fail "cannot read package.json."

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "the version in package.json is \"$version\", not MAJOR.MINOR.PATCH."
fi
tag="v$version"

if [ "$dry_run" != "true" ]; then
  if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
    fail "GITHUB_REF is \"${GITHUB_REF:-}\". A release runs only from refs/heads/main."
  fi
  if [ -z "${GH_TOKEN:-}" ]; then
    fail "GH_TOKEN is not set. A real run needs it."
  fi
fi

# Exit code 2 of ls-remote means that the tag is absent.
found=0
git -C "$root" ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null || found=$?
if [ "$found" -eq 0 ]; then
  echo "The tag $tag exists on origin. There is no release to create."
  exit 0
fi
if [ "$found" -ne 2 ]; then
  fail "cannot read the tags of origin (git ls-remote exit $found)."
fi

head="$(git -C "$root" rev-parse HEAD)"
if [ "$dry_run" = "true" ]; then
  echo "Dry run: the script would run: gh release create $tag --target $head --title $tag --generate-notes"
  exit 0
fi

gh release create "$tag" --target "$head" --title "$tag" --generate-notes
echo "Created the release $tag at $head."
