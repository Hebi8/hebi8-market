# shellcheck shell=bash
# Shared by release.sh and hotfix.sh, which source it and set SCRIPT (docs/maintainers.md §分支与发版).
# Issue labels and comments are the triage bot's; pushes and the GitHub Release are the user's own gh.

REPO=Hebi8/hebi8-market
LIVE=${HEBI8_LIVE:-$HOME/dev/hebi8-market}
NEXT_LABEL=status:next-release
STEP=checks

fail() {
  echo "$SCRIPT: $1" >&2
  exit 1
}

check_version() {
  [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$1' is not a version like 0.3.0"
}

clean() {
  [[ -z $(git status --porcelain) ]] || fail "the checkout has local changes"
}

pkg_version() {
  node -p 'require("./package.json").version'
}

# <a> <b>: a is a later version than b
version_gt() {
  [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1) == "$1" ]]
}

# The newest release tag reachable from <ref> (HEAD by default); fails when there is none.
last_tag() {
  git describe --tags --abbrev=0 --match 'v[0-9]*' "${1:-HEAD}" 2>/dev/null
}

# The local master has everything origin/master has, so deploy.sh's push goes through.
master_current() {
  git fetch -q origin
  git merge-base --is-ancestor origin/master master || fail "origin/master has commits the local master lacks"
}

has_section() {
  grep -qE "^## v${1//./\\.}( — .*)?$" CHANGELOG.md
}

# The body of a version's section in CHANGELOG.md, without its heading.
changelog_section() {
  awk -v h="## v$1" '$0 == h || index($0, h " ") == 1 { on = 1; next } on && /^## / { exit } on' CHANGELOG.md | sed '/./,$!d'
}

# The version commit: package.json, the lockfile and the section's date.
bump() {
  local version=$1
  npm version "$version" --no-git-tag-version >/dev/null
  sed -i -E "s/^## v${version//./\\.}( — .*)?$/## v$version — $(date +%F)/" CHANGELOG.md
  git commit -qm "chore(release): v$version" -- package.json package-lock.json CHANGELOG.md
  echo "version commit: $(git log --oneline -1)"
}

# <ref> <version> <commit before the bump>: deploy.sh, or undo the version commit when it did not go live.
deploy() {
  STEP=deploy
  if "$LIVE/scripts/deploy.sh" "$1"; then return; fi
  if git merge-base --is-ancestor HEAD master; then
    fail "deploy.sh failed after master moved to v$2, so the live instance runs it; push master by hand, then finish with: scripts/$SCRIPT publish $2"
  fi
  git reset -q --hard "$3"
  fail "deploy failed and deploy.sh put the live instance back; the version commit is undone, nothing was tagged or pushed"
}

stopped() {
  if (($1 != 0)); then echo "$SCRIPT: stopped at '$STEP'; the live instance already runs v$2. Finish with: scripts/$SCRIPT publish $2" >&2; fi
}

# <version> <release|hotfix>: after a successful deploy, tag what master is, push the tag, publish the
# GitHub Release from the CHANGELOG section and tell the issues it fixed. Safe to run again.
publish() {
  local version=$1 mode=$2 tag=v$1
  trap 'stopped $? '"$version" EXIT
  [[ $(git rev-parse master) == $(git rev-parse HEAD) ]] || fail "master is not at this checkout's HEAD; was v$version deployed from here?"

  STEP=tag
  if [[ -z $(git tag -l "$tag") ]]; then git tag -a "$tag" -m "$tag" master; fi
  [[ $(git rev-parse "$tag^{commit}") == $(git rev-parse master) ]] || fail "$tag exists and is not master"

  STEP=push
  if [[ $mode == release ]]; then
    git push --atomic origin dev "refs/tags/$tag"
  else
    git push origin "refs/tags/$tag"
  fi

  STEP=release
  if ! env -u GH_TOKEN gh release view "$tag" -R "$REPO" >/dev/null 2>&1; then
    changelog_section "$version" | env -u GH_TOKEN gh release create "$tag" -R "$REPO" --verify-tag --title "$tag" --notes-file -
  fi

  STEP=issues
  announce "$version" "$mode"
  trap - EXIT
  echo "released $tag"
}

# Issue numbers named by GitHub's closing keywords in commit messages on stdin.
fixed_issues() {
  grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#[0-9]+' | grep -oE '[0-9]+$' || true
}

# The issues this version fixed: on a release everything labelled status:next-release, and on both what
# the commits since the previous tag say they fix. Each loses the label, gets one comment and is closed.
announce() {
  local version=$1 mode=$2 tag=v$1 bot prev n state labeled
  bot=$("$HOME/.local/share/hebi8/triage-token.sh")
  [[ -n $bot ]] || fail "the triage bot gave no token"
  local issues=()
  if [[ $mode == release ]]; then
    mapfile -t issues < <(GH_TOKEN=$bot gh issue list -R "$REPO" --label "$NEXT_LABEL" --state all --limit 500 --json number --jq '.[].number')
  fi
  # the first release has no previous tag, and the whole history would name every old issue
  if prev=$(last_tag "$tag^"); then
    mapfile -t -O "${#issues[@]}" issues < <(git log --format=%B "$prev..$tag" | fixed_issues)
  fi
  local url="https://github.com/$REPO/releases/tag/$tag"
  for n in $(printf '%s\n' "${issues[@]}" | sort -nu); do
    if ! state=$(GH_TOKEN=$bot gh issue view "$n" -R "$REPO" --json state,labels --jq "[.state, any(.labels[]; .name == \"$NEXT_LABEL\")] | @tsv"); then
      echo "skipped #$n: not an issue" >&2
      continue
    fi
    labeled=${state#*$'\t'}
    state=${state%$'\t'*}
    if [[ $labeled == true ]]; then GH_TOKEN=$bot gh issue edit "$n" -R "$REPO" --remove-label "$NEXT_LABEL" >/dev/null; fi
    GH_TOKEN=$bot gh issue comment "$n" -R "$REPO" --body "已在 [$tag]($url) 上线。" >/dev/null
    if [[ $state == OPEN ]]; then GH_TOKEN=$bot gh issue close "$n" -R "$REPO" >/dev/null; fi
    echo "issue #$n: 已在 $tag 上线"
  done
}

# Merge master into dev and push dev, so master stays an ancestor of dev and the next release fast-forwards.
# Done in the checkout that has dev, or in a temporary worktree when none has it.
merge_back() {
  STEP=merge-back
  local dir tmp=""
  dir=$(git worktree list --porcelain | awk '/^worktree /{ w = substr($0, 10) } $0 == "branch refs/heads/dev" { print w }')
  if [[ -z $dir ]]; then
    tmp=$(mktemp -d)
    git worktree add -q "$tmp" dev
    dir=$tmp
  fi
  [[ -z $(git -C "$dir" status --porcelain) ]] || fail "the dev checkout $dir has local changes; commit them, then run: scripts/$SCRIPT merge-back"
  if ! git -C "$dir" merge -q --no-ff --no-edit -m "Merge master ($(last_tag master)) into dev" master; then
    git -C "$dir" merge --abort
    fail "master does not merge cleanly into dev; in $dir run git merge master, resolve, commit and git push origin dev"
  fi
  git -C "$dir" push origin dev
  if [[ -n $tmp ]]; then git worktree remove "$tmp"; fi
  echo "dev: $(git log --oneline -1 dev)"
}
