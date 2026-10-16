#!/usr/bin/env bash
# Ship a hotfix (docs/maintainers.md §热补丁). The usual way is a pull request into master: merging it deploys it
# (.github/workflows/deploy.yml), and the workflow tags, publishes, tells the issues and merges master back into dev.
# Usage:
#   scripts/hotfix.sh start <x.y.z>            in a clean checkout: hotfix/v<x.y.z> from origin's master, switched to
#   scripts/hotfix.sh <x.y.z>                  on that branch, the fix and a `## v<x.y.z>` CHANGELOG.md section
#                                              committed and reviewed: the version commit, the branch pushed, a pull
#                                              request into master
#   scripts/hotfix.sh --deploy <x.y.z>         without GitHub Actions: the version commit, deploy.sh <this branch>,
#                                              tag, push, Release, issues, master merged back into dev
#   scripts/hotfix.sh publish <x.y.z>          after such a deploy went through but a later step stopped: the rest
#                                              again, from any checkout (it works on the version commit)
#   scripts/hotfix.sh merge-back               only merge master into dev and push dev
# The version is always the next patch of the one on master.
# Everything runs inside main(), so bash has read the whole file before a checkout can change it.
set -euo pipefail
SCRIPT=hotfix.sh
# shellcheck source=release-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-lib.sh"

main() {
  case ${1:-} in
    start) start "${2:?usage: hotfix.sh start <x.y.z>}" ;;
    publish)
      publish "${2:?usage: hotfix.sh publish <x.y.z>}" hotfix
      merge_back
      ;;
    merge-back) merge_back ;;
    --deploy) hotfix "${2:?usage: hotfix.sh --deploy <x.y.z>}" deploy ;;
    [0-9]*) hotfix "$1" pr ;;
    *) fail "usage: hotfix.sh start <x.y.z> | <x.y.z> | --deploy <x.y.z> | publish <x.y.z> | merge-back" ;;
  esac
}

# <version>: it is the next patch of <ref>'s package.json
next_patch() {
  local current
  current=$(git show "$2:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
  [[ $1 == "${current%.*}.$((${current##*.} + 1))" ]] || fail "the hotfix after $current is ${current%.*}.$((${current##*.} + 1)), not $1"
}

start() {
  local version=$1
  check_version "$version"
  clean
  git fetch -q origin
  next_patch "$version" origin/master
  git switch -c "hotfix/v$version" --no-track origin/master
  echo "next: fix it here, add '## v$version' to the top of CHANGELOG.md (one line), commit, get the two reviews, then: scripts/hotfix.sh $version"
}

# <version> <pr|deploy>
hotfix() {
  local version=$1 how=$2 tag=v$1 branch before
  check_version "$version"
  branch=$(git branch --show-current)
  [[ -n $branch && $branch != master && $branch != dev ]] || fail "run it on the hotfix branch, not on ${branch:-a detached HEAD}"
  clean
  git fetch -q origin
  if [[ $how == pr ]]; then
    git merge-base --is-ancestor origin/master HEAD || fail "$branch is not based on origin's master; rebase it onto origin/master"
    next_patch "$version" origin/master
  else
    master_current
    git merge-base --is-ancestor master HEAD || fail "$branch is not based on master; rebase it onto master"
    git rev-parse -q --verify refs/heads/dev >/dev/null || fail "there is no dev branch to merge master back into"
    next_patch "$version" master
  fi
  [[ -z $(git tag -l "$tag") ]] || fail "$tag already exists"
  has_section "$version" <CHANGELOG.md || fail "CHANGELOG.md has no '## $tag' section; add one line for the fix and commit it on $branch"

  before=$(git rev-parse HEAD)
  STEP=bump
  if [[ $how == pr ]]; then
    # a rerun after the push or the pull request stopped: the version commit is there already
    if [[ $(git log -1 --format=%s) != "chore(hotfix): $tag" ]]; then bump "$version" hotfix; fi
    open_pr "$branch" "$version" "Hotfix $tag"
    return
  fi
  bump "$version" hotfix
  deploy "$branch" "$version" "$before"
  publish "$version" hotfix
  merge_back
}

main "$@"
