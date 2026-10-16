#!/usr/bin/env bash
# Ship a hotfix: the version commit, deploy.sh <this branch>, tag, push, GitHub Release, issues, then merge master
# back into dev so the next release still fast-forwards.
# Usage, on the hotfix branch (cut from master; CHANGELOG.md has a `## v<x.y.z>` section, committed):
#   scripts/hotfix.sh <x.y.z>           ship it (a patch of the live minor version)
#   scripts/hotfix.sh publish <x.y.z>   after a deploy went through but a later step stopped: the rest again
#   scripts/hotfix.sh merge-back        only merge master into dev and push dev
# Everything runs inside main(), so bash has read the whole file before a checkout can change it.
set -euo pipefail
SCRIPT=hotfix.sh
# shellcheck source=release-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-lib.sh"

main() {
  case ${1:-} in
    publish)
      publish "${2:?usage: hotfix.sh publish <x.y.z>}" hotfix
      merge_back
      ;;
    merge-back) merge_back ;;
    [0-9]*) hotfix "$1" ;;
    *) fail "usage: hotfix.sh <x.y.z> | publish <x.y.z> | merge-back" ;;
  esac
}

hotfix() {
  local version=$1 tag=v$1 branch current before
  check_version "$version"
  branch=$(git branch --show-current)
  [[ -n $branch && $branch != master && $branch != dev ]] || fail "run it on the hotfix branch, not on ${branch:-a detached HEAD}"
  clean
  master_current
  git merge-base --is-ancestor master HEAD || fail "$branch is not based on master; rebase it onto master"
  git rev-parse -q --verify refs/heads/dev >/dev/null || fail "there is no dev branch to merge master back into"
  [[ -z $(git tag -l "$tag") ]] || fail "$tag already exists"
  current=$(pkg_version)
  if [[ ${version%.*} != "${current%.*}" ]] || ! version_gt "$version" "$current"; then
    fail "a hotfix of $current is $current with a higher patch number, not $version"
  fi
  has_section "$version" || fail "CHANGELOG.md has no '## $tag' section; add one line for the fix and commit it on $branch"

  before=$(git rev-parse HEAD)
  STEP=bump
  bump "$version"
  deploy "$branch" "$version" "$before"
  publish "$version" hotfix
  merge_back
}

main "$@"
