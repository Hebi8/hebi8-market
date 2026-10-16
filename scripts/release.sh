#!/usr/bin/env bash
# Release dev: the version commit, deploy.sh dev (master fast-forwards to it), tag, push, GitHub Release, issues.
# Usage, in the checkout that has dev:
#   scripts/release.sh notes             what changed since the last tag, to rewrite into CHANGELOG.md
#   scripts/release.sh <x.y.z>           release it (CHANGELOG.md needs a `## v<x.y.z>` section, committed on dev)
#   scripts/release.sh publish <x.y.z>   after a deploy went through but a later step stopped: the rest again
# Everything runs inside main(), so bash has read the whole file before a checkout can change it.
set -euo pipefail
SCRIPT=release.sh
# shellcheck source=release-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-lib.sh"

main() {
  case ${1:-} in
    notes) notes ;;
    publish)
      on_dev
      publish "${2:?usage: release.sh publish <x.y.z>}" release
      ;;
    [0-9]*) release "$1" ;;
    *) fail "usage: release.sh notes | <x.y.z> | publish <x.y.z>" ;;
  esac
}

on_dev() {
  [[ $(git branch --show-current) == dev ]] || fail "run it on dev"
}

# A draft for CHANGELOG.md: the feat and fix commits since the last tag (all of them before the first), the
# commits that touch the vault, hebi8.yaml, the secrets dir or MCP tools (for 升级注意), the issues waiting,
# and the version that follows from them.
notes() {
  local prev range current next bot
  current=$(pkg_version)
  if prev=$(last_tag); then range=$prev..HEAD; else range=HEAD; fi
  local log
  log=$(git log --reverse --format='- %s (%h)' "$range")
  echo "# changes since ${prev:-the first commit} (package.json $current)"
  echo
  echo "## feat"
  grep -E '^- feat' <<<"$log" || echo "(none)"
  echo
  echo "## fix"
  grep -E '^- fix' <<<"$log" || echo "(none)"
  echo
  echo "## upgrade notes? (vault, hebi8.yaml, secrets dir, MCP tools)"
  local upgrade
  upgrade=$(git log --reverse --format='- %s (%h)' "$range" -- vault.example src/lib/config.ts src/lib/vault.ts src/lib/secrets.ts src/lib/mcp/tools.ts)
  echo "${upgrade:-(none)}"
  echo
  echo "## issues labelled $NEXT_LABEL"
  bot=$("$HOME/.local/share/hebi8/triage-token.sh")
  GH_TOKEN=$bot gh issue list -R "$REPO" --label "$NEXT_LABEL" --state all --limit 500 --json number,title --jq '.[] | "- #\(.number) \(.title)"'
  echo
  local major=${current%%.*} rest=${current#*.}
  local minor=${rest%%.*} patch=${rest#*.}
  if grep -qE '^- feat' <<<"$log" || [[ -n $upgrade ]]; then
    next=$major.$((minor + 1)).0
  else
    next=$major.$minor.$((patch + 1))
  fi
  echo "suggested version: $next (minor for a feature or a change to the vault, hebi8.yaml or MCP tools; patch for fixes only)"
  echo "next: write '## v$next — 日期' at the top of CHANGELOG.md (one line per change, for the people who use it; the date is filled in on release), commit it on dev, then run scripts/release.sh $next"
}

release() {
  local version=$1 tag=v$1 before
  check_version "$version"
  on_dev
  clean
  master_current
  git merge-base --is-ancestor master HEAD || fail "master is not an ancestor of dev; merge it in first: scripts/hotfix.sh merge-back"
  if git rev-parse -q --verify refs/remotes/origin/dev >/dev/null; then
    git merge-base --is-ancestor origin/dev HEAD || fail "origin/dev has commits this dev lacks; pull first"
  fi
  [[ -z $(git tag -l "$tag") ]] || fail "$tag already exists"
  version_gt "$version" "$(pkg_version)" || fail "$version does not come after $(pkg_version)"
  has_section "$version" || fail "CHANGELOG.md has no '## $tag' section; run scripts/release.sh notes and write one"

  before=$(git rev-parse HEAD)
  STEP=bump
  bump "$version"
  deploy dev "$version" "$before"
  publish "$version" release
}

main "$@"
