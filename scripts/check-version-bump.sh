#!/usr/bin/env bash
# Check that a change to the shipped code bumps the version.
#
# Usage: scripts/check-version-bump.sh <base-sha> <head-sha>
#
# The script finds the merge base of the two commits. When the diff from the
# merge base to the head touches src/, prompts/, commands/, .claude-plugin/,
# action.yml, package.json, package-lock.json or .github/workflows/review.yml,
# the script requires all of these:
# - The version in package.json is MAJOR.MINOR.PATCH at the base and at the
#   head.
# - The head version is greater than the base version.
# - package.json, .claude-plugin/plugin.json and the plugin entry of
#   .claude-plugin/marketplace.json hold the same version at the head.
#
# A file that moves shows at its old path and at its new path.
# The base version comes from package.json at the base sha. The head
# versions come from the three files at the head sha.
# The script exits 0 when the check passes. It exits 1 with a one-line
# reason in every other case.
set -euo pipefail

fail() {
  echo "check-version-bump: $1" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  fail "usage: check-version-bump.sh <base-sha> <head-sha>"
fi
base_sha="$1"
head_sha="$2"

root="$(git rev-parse --show-toplevel 2> /dev/null)" || fail "the current directory is not in a git repository."

merge_base="$(git -C "$root" merge-base "$base_sha" "$head_sha" 2> /dev/null)" \
  || fail "cannot find the merge base of $base_sha and $head_sha."
changed="$(git -C "$root" diff --name-only --no-renames "$merge_base" "$head_sha")" \
  || fail "cannot read the diff from $merge_base to $head_sha."

if ! grep -E '^(src/|prompts/|commands/|\.claude-plugin/|action\.yml$|package\.json$|package-lock\.json$|\.github/workflows/review\.yml$)' > /dev/null <<< "$changed"; then
  echo "The change touches no shipped file. A version bump is not necessary."
  exit 0
fi

# Print the version that the JSON text on stdin holds. "pkg" reads the
# top-level version. "market" reads the version of the single plugin entry.
# Print an empty string when the version is absent.
read_version() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const doc = JSON.parse(readFileSync(0, "utf8"));
    let version = doc.version;
    if (process.argv[1] === "market") {
      const plugins = Array.isArray(doc.plugins) ? doc.plugins : [];
      version = plugins.length === 1 ? plugins[0].version : undefined;
    }
    process.stdout.write(typeof version === "string" ? version : "");
  ' "$1"
}

is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# Read each file into a variable first. A file that is missing stops the
# script with a one-line reason, before node reads the text.
base_pkg="$(git -C "$root" show "$base_sha:package.json" 2> /dev/null)" \
  || fail "cannot read package.json at $base_sha."
head_pkg="$(git -C "$root" show "$head_sha:package.json" 2> /dev/null)" \
  || fail "cannot read package.json at $head_sha."
head_plugin="$(git -C "$root" show "$head_sha:.claude-plugin/plugin.json" 2> /dev/null)" \
  || fail "cannot read .claude-plugin/plugin.json at $head_sha."
head_market="$(git -C "$root" show "$head_sha:.claude-plugin/marketplace.json" 2> /dev/null)" \
  || fail "cannot read .claude-plugin/marketplace.json at $head_sha."

base_version="$(read_version pkg <<< "$base_pkg")" \
  || fail "cannot read the version in package.json at $base_sha."
head_version="$(read_version pkg <<< "$head_pkg")" \
  || fail "cannot read the version in package.json at $head_sha."
plugin_version="$(read_version pkg <<< "$head_plugin")" \
  || fail "cannot read the version in .claude-plugin/plugin.json at $head_sha."
market_version="$(read_version market <<< "$head_market")" \
  || fail "cannot read the version in .claude-plugin/marketplace.json at $head_sha."

is_semver "$base_version" || fail "the base version \"$base_version\" is not MAJOR.MINOR.PATCH."
is_semver "$head_version" || fail "the head version \"$head_version\" is not MAJOR.MINOR.PATCH."

# Compare MAJOR, MINOR and PATCH as numbers. "10#" stops bash from reading a
# number with a leading zero as octal.
IFS=. read -r base_major base_minor base_patch <<< "$base_version"
IFS=. read -r head_major head_minor head_patch <<< "$head_version"
greater=false
if ((10#$head_major != 10#$base_major)); then
  ((10#$head_major > 10#$base_major)) && greater=true
elif ((10#$head_minor != 10#$base_minor)); then
  ((10#$head_minor > 10#$base_minor)) && greater=true
elif ((10#$head_patch > 10#$base_patch)); then
  greater=true
fi
if [ "$greater" != "true" ]; then
  fail "the change touches shipped files, but the version $head_version is not greater than $base_version. Bump the version in package.json, .claude-plugin/plugin.json and .claude-plugin/marketplace.json."
fi

if [ "$plugin_version" != "$head_version" ] || [ "$market_version" != "$head_version" ]; then
  fail "the versions differ: package.json $head_version, plugin.json \"$plugin_version\", marketplace.json \"$market_version\"."
fi

echo "The version goes from $base_version to $head_version in the three files."
