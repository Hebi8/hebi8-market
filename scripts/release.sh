#!/usr/bin/env bash
# Release origin's dev (docs/maintainers.md §发版). The usual way is a pull request: merging it into master deploys
# it (.github/workflows/deploy.yml), and the workflow tags, publishes, tells the issues and merges master back
# into dev. dev itself moves on GitHub, so everything here works on origin/dev after a fetch, never the local dev.
# Usage, from any checkout of the repository:
#   scripts/release.sh notes                what changed on origin/dev since the last tag, to rewrite into CHANGELOG.md
#   scripts/release.sh <x.y.z>              the release pull request: release/v<x.y.z> from origin/dev plus the
#                                           version commit, pushed, a pull request into master (CHANGELOG.md on
#                                           origin/dev needs a `## v<x.y.z>` section)
#   scripts/release.sh --deploy <x.y.z>     without GitHub Actions: the same branch, deploy.sh (master fast-forwards
#                                           to it), tag, push, Release, issues, master merged back into dev
#   scripts/release.sh publish <x.y.z>      after such a deploy went through but a later step stopped: the rest
#                                           again, from any checkout (it works on the version commit)
#   scripts/release.sh deployed <commit>    the deploy workflow, after <commit> went live
# Everything runs inside main(), so bash has read the whole file before a checkout can change it.
set -euo pipefail
SCRIPT=release.sh
# shellcheck source=release-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-lib.sh"

main() {
  case ${1:-} in
    notes) notes ;;
    publish)
      publish "${2:?usage: release.sh publish <x.y.z>}" release
      merge_back
      ;;
    deployed) deployed "${2:?usage: release.sh deployed <commit>}" ;;
    --deploy) release "${2:?usage: release.sh --deploy <x.y.z>}" deploy ;;
    [0-9]*) release "$1" pr ;;
    *) fail "usage: release.sh notes | <x.y.z> | --deploy <x.y.z> | publish <x.y.z>" ;;
  esac
}

# A draft for CHANGELOG.md: the feat and fix commits since the last tag (all of them before the first), the
# commits that touch the vault, hebi8.yaml, the secrets dir or MCP tools (for 升级注意), the issues waiting,
# and the version that follows from them.
notes() {
  local prev range current next
  git fetch -q origin
  current=$(version_at origin/dev)
  if prev=$(last_tag origin/dev); then range=$prev..origin/dev; else range=origin/dev; fi
  local log
  log=$(git log --reverse --format='- %s (%h)' "$range")
  echo "# changes on origin/dev since ${prev:-the first commit} (package.json $current)"
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
  bot_init
  gh_bot issue list -R "$REPO" --label "$NEXT_LABEL" --state all --limit 500 --json number,title --jq '.[] | "- #\(.number) \(.title)"'
  echo
  local major=${current%%.*} rest=${current#*.}
  local minor=${rest%%.*} patch=${rest#*.}
  if grep -qE '^- feat' <<<"$log" || [[ -n $upgrade ]]; then
    next=$major.$((minor + 1)).0
  else
    next=$major.$minor.$((patch + 1))
  fi
  echo "suggested version: $next (minor for a feature or a change to the vault, hebi8.yaml or MCP tools; patch for fixes only)"
  echo "next: write '## v$next — 日期' at the top of CHANGELOG.md (one line per change, for the people who use it; the date is filled in on release), get it into dev, then run scripts/release.sh $next"
}

# <x.y.z> <pr|deploy>: release/v<x.y.z> is cut from origin/dev in a worktree of its own (no checkout of yours
# moves, and dev itself takes only pull requests) and gets the version commit there; then it goes to master as a
# pull request, or (--deploy) is deployed from here.
release() {
  local version=$1 how=$2 tag=v$1 branch=release/v$1 current changelog
  check_version "$version"
  if [[ $how == deploy ]]; then master_current; else git fetch -q origin; fi
  git merge-base --is-ancestor origin/master origin/dev ||
    fail "origin/master has commits origin/dev lacks: master was not merged back into dev (the deploy of the last pull request into master failed, or the merge-back pull request is still open). Run scripts/hotfix.sh merge-back (or merge that pull request), then this again"
  [[ -z $(git tag -l "$tag") ]] || fail "$tag already exists"
  current=$(version_at origin/master)
  if [[ $version == "$current" ]]; then
    fail "master says $current already, but it was never released (its deploy failed?): release a later version, or fix it with scripts/hotfix.sh start"
  fi
  version_gt "$version" "$current" || fail "$version does not come after $current"
  changelog=$(git show origin/dev:CHANGELOG.md)
  has_section "$version" <<<"$changelog" ||
    fail "CHANGELOG.md on origin/dev has no '## $tag' section; run scripts/release.sh notes and get one into dev"
  if [[ $how == pr ]]; then
    # a branch left from an earlier try is reused only while it still is origin/dev plus the version commit (a
    # push or a pull request that did not go through); one cut from an older dev would leave out what came
    # since. (--deploy always reuses it: after an unknown outcome its version commit may be live.)
    if git rev-parse -q --verify "refs/heads/$branch" >/dev/null &&
      [[ $(git log -1 --format=%s "$branch") == "chore(release): $tag" && $(git rev-parse "$branch^") != "$(git rev-parse origin/dev)" ]]; then
      fail "$branch was cut from an older dev ($(git rev-parse --short "$branch^"); origin/dev is $(git rev-parse --short origin/dev)). If its pull request is closed, delete it (git branch -D $branch; git push origin --delete $branch) and run this again; if it is open, merge or close it first"
    fi
    in_worktree "$branch" origin/dev "$version" release open_pr "$branch" "$version" "Release $tag"
  else
    in_worktree "$branch" origin/dev "$version" release ship "$branch" "$version"
  fi
}

# <branch> <version>, in the release worktree: deploy it, publish, merge master back into dev
ship() {
  STEP=deploy
  deploy "$1" "$2" "$(git rev-parse HEAD^)"
  publish "$2" release
  merge_back
}

main "$@"
