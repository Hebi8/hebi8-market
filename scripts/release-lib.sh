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

# <version>, CHANGELOG.md on stdin: it has a section for the version.
has_section() {
  grep -qE "^## v${1//./\\.}( — .*)?$"
}

# <version>, CHANGELOG.md on stdin: the body of the version's section, without its heading.
changelog_section() {
  awk -v h="## v$1" '$0 == h || index($0, h " ") == 1 { on = 1; next } on && /^## / { exit } on' | sed '/./,$!d'
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
    fail "deploy.sh failed after master moved to v$2 (the push to origin?), so the live instance runs it and the version commit stays; in $LIVE run git push origin master, then finish with: scripts/$SCRIPT publish $2"
  fi
  git reset -q --hard "$3"
  fail "deploy failed and deploy.sh put the live instance back; the version commit is undone, nothing was tagged or pushed"
}

stopped() {
  if (($1 != 0)); then echo "$SCRIPT: stopped at '$STEP'; the live instance already runs v$2. Finish with: scripts/$SCRIPT publish $2 (from any checkout)" >&2; fi
}

# <version>: sets RELEASE_COMMIT to what was deployed as that version, read from the commit itself and not
# from whatever this checkout or dev has moved on to: the tag once it exists, else the version commit on master.
# Its package.json must say the version and its CHANGELOG.md must have the section.
release_commit() {
  local version=$1 tag=v$1 c
  if [[ -n $(git tag -l "$tag") ]]; then
    c=$(git rev-parse "$tag^{commit}")
  else
    c=$(git log master -n1 --format=%H -E --grep="^chore\(release\): v${version//./\\.}$")
    [[ -n $c ]] || fail "master has no version commit for v$version; was it deployed?"
  fi
  [[ $(git show "$c:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version') == "$version" ]] ||
    fail "package.json at ${c:0:7} is not $version"
  git show "$c:CHANGELOG.md" | has_section "$version" || fail "CHANGELOG.md at ${c:0:7} has no '## $tag' section"
  git merge-base --is-ancestor "$c" master || fail "${c:0:7} (v$version) is not on master; it was not deployed"
  git merge-base --is-ancestor "$c" origin/master || fail "origin/master lacks v$version; in $LIVE run git push origin master first"
  RELEASE_COMMIT=$c
}

# <version> <release|hotfix>: after a successful deploy, tag the version commit, push the tag, publish the
# GitHub Release from its CHANGELOG section and tell the issues it fixed. Every step can run again.
publish() {
  local version=$1 mode=$2 tag=v$1 c
  check_version "$version"
  git fetch -q origin
  release_commit "$version"
  c=$RELEASE_COMMIT
  trap 'stopped $? '"$version" EXIT

  STEP=tag
  if [[ -z $(git tag -l "$tag") ]]; then git tag -a "$tag" -m "$tag" "$c"; fi

  STEP=push
  git push -q origin "refs/tags/$tag"
  # a release also brings origin/dev up to the version commit, unless dev there has already gone past it
  if [[ $mode == release ]] && ! git merge-base --is-ancestor "$c" origin/dev 2>/dev/null; then
    git push -q origin "$c:refs/heads/dev"
  fi

  STEP=release
  if ! env -u GH_TOKEN gh release view "$tag" -R "$REPO" >/dev/null 2>&1; then
    git show "$c:CHANGELOG.md" | changelog_section "$version" | env -u GH_TOKEN gh release create "$tag" -R "$REPO" --verify-tag --title "$tag" --notes-file -
  fi

  STEP=issues
  announce "$version" "$mode" "$c"
  trap - EXIT
  echo "released $tag"
}

# Issue numbers named by GitHub's closing keywords in commit messages on stdin.
fixed_issues() {
  grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#[0-9]+' | grep -oE '[0-9]+$' || true
}

# <version> <release|hotfix> <version commit>: the issues this version fixed (on a release everything labelled
# status:next-release, on both what the commits since the previous tag say they fix) get one comment, are
# closed, and only then lose the label, so a run that stops is picked up again by the next. The comment
# carries a marker, and an issue that already has it is not commented on again.
announce() {
  local version=$1 mode=$2 c=$3 tag=v$1 bot prev n out info state pr labeled
  local marker="<!-- hebi8-release:$tag -->" url="https://github.com/$REPO/releases/tag/$tag" err
  bot=$("$HOME/.local/share/hebi8/triage-token.sh") || fail "the triage bot token script failed"
  [[ -n $bot ]] || fail "the triage bot gave no token"
  err=$(mktemp)
  local issues=()
  if [[ $mode == release ]]; then
    out=$(GH_TOKEN=$bot gh issue list -R "$REPO" --label "$NEXT_LABEL" --state all --limit 500 --json number --jq '.[].number') ||
      fail "could not list the issues labelled $NEXT_LABEL"
    if [[ -n $out ]]; then mapfile -t issues <<<"$out"; fi
  fi
  # the first release has no previous tag, and the whole history would name every old issue
  if prev=$(last_tag "$c^"); then
    out=$(git log --format=%B "$prev..$c" | fixed_issues)
    if [[ -n $out ]]; then mapfile -t -O "${#issues[@]}" issues <<<"$out"; fi
  fi
  for n in $(printf '%s\n' "${issues[@]}" | sort -nu); do
    # REST: a pull request is an issue with pull_request set; a missing or deleted one is a 404 / 410
    if ! info=$(GH_TOKEN=$bot gh api "repos/$REPO/issues/$n" --jq "[.state, (.pull_request != null), any(.labels[]; .name == \"$NEXT_LABEL\")] | @tsv" 2>"$err"); then
      if grep -qE 'HTTP (404|410)' "$err"; then
        echo "skipped #$n: no such issue" >&2
        continue
      fi
      cat "$err" >&2
      fail "could not read issue #$n"
    fi
    IFS=$'\t' read -r state pr labeled <<<"$info"
    if [[ $pr == true ]]; then
      echo "skipped #$n: a pull request" >&2
      continue
    fi
    out=$(GH_TOKEN=$bot gh api --paginate "repos/$REPO/issues/$n/comments" --jq ".[] | select(.body | contains(\"$marker\")) | .id") ||
      fail "could not read the comments on issue #$n"
    if [[ -z $out ]]; then GH_TOKEN=$bot gh issue comment "$n" -R "$REPO" --body "已在 [$tag]($url) 上线。$marker" >/dev/null; fi
    if [[ $state == open ]]; then GH_TOKEN=$bot gh issue close "$n" -R "$REPO" >/dev/null; fi
    if [[ $labeled == true ]]; then GH_TOKEN=$bot gh issue edit "$n" -R "$REPO" --remove-label "$NEXT_LABEL" >/dev/null; fi
    echo "issue #$n: 已在 $tag 上线"
  done
  rm -f "$err"
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
