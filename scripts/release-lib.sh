# shellcheck shell=bash
# Shared by release.sh and hotfix.sh, which source it and set SCRIPT (docs/maintainers.md §分支与发版), and run
# by the deploy workflow after a deploy (release.sh deployed).
# Issue labels and comments are the triage bot's (HEBI8_ISSUES_TOKEN, else the token script below, else your
# own gh); pushes, pull requests and the GitHub Release are your own gh, in GitHub Actions the workflow's token.

REPO=${GITHUB_REPOSITORY:-Hebi8/hebi8-market}
# this directory, absolute: deploy.sh beside it is the one the version being shipped brings
LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# the checkout whose master is what is live (the main checkout); deploy.sh moves it after a deploy from here
HOME_REPO=${HEBI8_REPO:-$(dirname "$(git -C "$LIB_DIR" rev-parse --path-format=absolute --git-common-dir)")}
BOT_TOKEN_SCRIPT=$HOME/.local/share/hebi8/triage-token.sh
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

# <version>, CHANGELOG.md on stdin: it has a section for the version. Feed it a file or a variable, never a
# pipe: grep -q stops at the first match, and under pipefail the writer's SIGPIPE would fail the pipeline.
has_section() {
  grep -qE "^## v${1//./\\.}( — .*)?$"
}

# <version>, CHANGELOG.md on stdin: the body of the version's section, without its heading. awk stops at the
# next section, so the same goes as for has_section.
changelog_section() {
  awk -v h="## v$1" '$0 == h || index($0, h " ") == 1 { on = 1; next } on && /^## / { exit } on' | sed '/./,$!d'
}

# <version> <release|hotfix>: the version commit, chore(<kind>): v<version>: package.json, the lockfile and the
# section's date. The kind tells the deploy workflow which issues the version fixed.
bump() {
  local version=$1
  npm version "$version" --no-git-tag-version >/dev/null
  sed -i -E "s/^## v${version//./\\.}( — .*)?$/## v$version — $(date +%F)/" CHANGELOG.md
  git commit -qm "chore($2): v$version" -- package.json package-lock.json CHANGELOG.md
  echo "version commit: $(git log --oneline -1)"
}

# gh as yourself: in GitHub Actions the workflow's GH_TOKEN, elsewhere your gh login (never a GH_TOKEN that
# happens to be set, which may be the bot's)
gh_own() {
  if [[ -n ${GITHUB_ACTIONS:-} ]]; then gh "$@"; else env -u GH_TOKEN gh "$@"; fi
}

# Sets BOT, the triage bot's token for gh_bot: HEBI8_ISSUES_TOKEN, else what BOT_TOKEN_SCRIPT prints; without
# either it stays empty and gh_bot is you.
bot_init() {
  BOT=${HEBI8_ISSUES_TOKEN:-}
  if [[ -z $BOT && -x $BOT_TOKEN_SCRIPT ]]; then
    BOT=$("$BOT_TOKEN_SCRIPT") || fail "the triage bot token script failed"
    [[ -n $BOT ]] || fail "the triage bot gave no token"
  fi
}

gh_bot() {
  if [[ -n $BOT ]]; then GH_TOKEN=$BOT gh "$@"; else gh_own "$@"; fi
}

# <branch> <base> <version> <release|hotfix> <command...>: the command in a temporary worktree of <branch>, cut
# from <base> with the version commit on top. A rerun (the push or the pull request did not go through) finds the
# branch with its version commit and goes on from there.
in_worktree() {
  local branch=$1 base=$2 version=$3 kind=$4 dir
  shift 4
  dir=$(mktemp -d)
  # shellcheck disable=SC2064 # the directory now: a stop anywhere below leaves no worktree holding the branch
  trap "git worktree remove --force '$dir'" EXIT
  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    git worktree add -q "$dir" "$branch"
    [[ $(git -C "$dir" log -1 --format=%s) == "chore($kind): v$version" ]] ||
      fail "the branch $branch exists and does not end with the version commit; delete it or look at it"
  else
    git worktree add -q -b "$branch" "$dir" "$base"
    (cd "$dir" && bump "$version" "$kind")
  fi
  (cd "$dir" && "$@")
  trap - EXIT
  git worktree remove "$dir"
}

# <branch> <version> <title>: push the branch and open its pull request into master (or show the one that is
# open), the body the version's CHANGELOG section. Merged, the deploy workflow ships it.
open_pr() {
  local branch=$1 version=$2 title=$3 url
  STEP=push
  git push -q -u origin "$branch"
  STEP='pull request'
  url=$(gh_own pr list -R "$REPO" --head "$branch" --base master --state open --json url --jq '.[0].url // empty')
  if [[ -z $url ]]; then
    url=$({
      changelog_section "$version" <CHANGELOG.md
      # shellcheck disable=SC2016 # the backticks are Markdown
      printf '\n---\n合并时选 **Create a merge commit**（不要 squash / rebase：master 要一直是 dev 的祖先）。合并后 Deploy 工作流部署到线上，成功后打 tag `v%s`、发 Release、处理 issue，再把 master 合回 dev。\n' "$version"
    } | gh_own pr create -R "$REPO" --base master --head "$branch" --title "$title" --body-file -)
  fi
  echo "pull request: $url"
  echo "next: the two reviews, then merge it with 'Create a merge commit' (not squash or rebase)"
}

# <ref> <version> <commit before the bump>: deploy.sh (the one in this checkout, so the version being shipped
# brings its own). The version commit is undone only when deploy.sh says the live instance runs what it ran
# before (status 1); when it cannot tell (3, or anything else before master moved) the commit stays, since the
# live instance may run it.
deploy() {
  STEP=deploy
  local rc=0
  "$LIB_DIR/deploy.sh" "$1" || rc=$?
  if ((rc == 0)); then return; fi
  if ((rc == 3)); then unknown_outcome "$1" "$2"; fi
  if git merge-base --is-ancestor HEAD master; then
    fail "deploy.sh failed after master moved to v$2 (the push to origin?), so the live instance runs it and the version commit stays; in $HOME_REPO run git push origin master, then finish with: scripts/$SCRIPT publish $2"
  fi
  if ((rc != 1)); then unknown_outcome "$1" "$2"; fi
  git reset -q --hard "$3"
  fail "deploy failed and deploy.sh put the live instance back; the version commit is undone, nothing was tagged or pushed"
}

# <ref> <version>: deploy.sh could not tell whether the live instance runs it
unknown_outcome() {
  fail "the deploy's outcome on the live machine is unknown, so the version commit stays and nothing was tagged or pushed. Once the live machine answers, from this checkout run scripts/deploy.sh $1 (it finishes a deploy that went through or does it again), then: scripts/$SCRIPT publish $2"
}

stopped() {
  if (($1 == 0)); then return; fi
  if [[ -n ${GITHUB_ACTIONS:-} ]]; then
    echo "::error::stopped at '$STEP'; the live instance already runs v$2. Re-run this workflow run (Re-run failed jobs): the deploy is skipped, the steps done are skipped" >&2
  else
    echo "$SCRIPT: stopped at '$STEP'; the live instance already runs v$2. Finish with: scripts/$SCRIPT publish $2 (from any checkout)" >&2
  fi
}

# <version> [<commit>]: sets RELEASE_COMMIT to what was deployed as that version, read from the commit itself and
# not from whatever this checkout or dev has moved on to: the commit given (the deploy workflow's), else the tag
# once it exists, else the version commit on master. Its package.json must say the version and its CHANGELOG.md,
# kept in RELEASE_CHANGELOG, must have the section.
release_commit() {
  local version=$1 tag=v$1 c=${2:-} changelog
  if [[ -n $c ]]; then
    :
  elif [[ -n $(git tag -l "$tag") ]]; then
    c=$(git rev-parse "$tag^{commit}")
  else
    c=$(git log master -n1 --format=%H -E --grep="^chore\((release|hotfix)\): v${version//./\\.}$")
    [[ -n $c ]] || fail "master has no version commit for v$version; was it deployed?"
  fi
  [[ $(git show "$c:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version') == "$version" ]] ||
    fail "package.json at ${c:0:7} is not $version"
  changelog=$(git show "$c:CHANGELOG.md") || fail "could not read CHANGELOG.md at ${c:0:7}"
  has_section "$version" <<<"$changelog" || fail "CHANGELOG.md at ${c:0:7} has no '## $tag' section"
  git merge-base --is-ancestor "$c" master || fail "${c:0:7} (v$version) is not on master; it was not deployed"
  git merge-base --is-ancestor "$c" origin/master || fail "origin/master lacks v$version; in $HOME_REPO run git push origin master first"
  RELEASE_COMMIT=$c
  RELEASE_CHANGELOG=$changelog
}

# <version> <release|hotfix> [<commit>]: after a successful deploy, tag what was deployed, push the tag, publish
# the GitHub Release from its CHANGELOG section and tell the issues it fixed. Every step can run again. Without
# a commit (a deploy from here, release.sh / hotfix.sh --deploy) a release also brings origin/dev up to the
# version commit; with one (the deploy workflow) merging master back into dev is merge_back_ci's.
publish() {
  local version=$1 mode=$2 tag=v$1 c
  check_version "$version"
  git fetch -q origin
  release_commit "$version" "${3:-}"
  c=$RELEASE_COMMIT
  trap 'stopped $? '"$version" EXIT

  STEP=tag
  if [[ -z $(git tag -l "$tag") ]]; then git tag -a "$tag" -m "$tag" "$c"; fi

  STEP=push
  git push -q origin "refs/tags/$tag"
  # a release also brings origin/dev up to the version commit, unless dev there has already gone past it
  if [[ -z ${3:-} && $mode == release ]] && ! git merge-base --is-ancestor "$c" origin/dev 2>/dev/null; then
    git push -q origin "$c:refs/heads/dev"
  fi

  STEP=release
  if ! gh_own release view "$tag" -R "$REPO" >/dev/null 2>&1; then
    changelog_section "$version" <<<"$RELEASE_CHANGELOG" | gh_own release create "$tag" -R "$REPO" --verify-tag --title "$tag" --notes-file -
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
  local version=$1 mode=$2 c=$3 tag=v$1 prev n out info state pr labeled
  local marker="<!-- hebi8-release:$tag -->" url="https://github.com/$REPO/releases/tag/$tag" err
  bot_init
  err=$(mktemp)
  local issues=()
  if [[ $mode == release ]]; then
    out=$(gh_bot issue list -R "$REPO" --label "$NEXT_LABEL" --state all --limit 500 --json number --jq '.[].number') ||
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
    if ! info=$(gh_bot api "repos/$REPO/issues/$n" --jq "[.state, (.pull_request != null), any(.labels[]; .name == \"$NEXT_LABEL\")] | @tsv" 2>"$err"); then
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
    out=$(gh_bot api --paginate "repos/$REPO/issues/$n/comments" --jq ".[] | select(.body | contains(\"$marker\")) | .id") ||
      fail "could not read the comments on issue #$n"
    if [[ -z $out ]]; then gh_bot issue comment "$n" -R "$REPO" --body "已在 [$tag]($url) 上线。$marker" >/dev/null; fi
    if [[ $state == open ]]; then gh_bot issue close "$n" -R "$REPO" >/dev/null; fi
    if [[ $labeled == true ]]; then gh_bot issue edit "$n" -R "$REPO" --remove-label "$NEXT_LABEL" >/dev/null; fi
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

# <commit>: the deploy workflow, after <commit> (a push to master) went live. A version whose tag is not out yet
# (or is on this very commit: a rerun) is published, as a hotfix when its version commit says chore(hotfix),
# else as a release; a version already out elsewhere was only deployed. Then master goes back into dev.
deployed() {
  local c version t mode=release
  c=$(git rev-parse --verify "$1^{commit}")
  git fetch -q --tags origin
  version=$(git show "$c:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
  if t=$(git rev-parse -q --verify "refs/tags/v$version^{commit}") && [[ $t != "$c" ]]; then
    echo "v$version is out already (${t:0:7}); ${c:0:7} was only deployed"
  else
    if [[ -n $(git log -n1 --format=%H -E --grep="^chore\(hotfix\): v${version//./\\.}$" "$c") ]]; then mode=hotfix; fi
    publish "$version" "$mode" "$c"
  fi
  merge_back_ci "$c"
}

# <commit>: merge it into origin's dev and push dev, so master stays an ancestor of dev. When dev takes changes
# only through pull requests the push is refused: then a pull request from master into dev, merged as soon as
# GitHub lets it (auto-merge, else at once; when neither is allowed it waits for you). A push with the workflow's
# token starts no workflow, so dev's deploy does not run for it; the dev instance's own fetch picks it up.
merge_back_ci() {
  STEP=merge-back
  local c=$1 tmp pr title
  git fetch -q origin dev
  if git merge-base --is-ancestor "$c" origin/dev; then
    echo "dev has ${c:0:7} already"
    return
  fi
  title="Merge master ($(last_tag "$c" || git rev-parse --short "$c")) into dev"
  tmp=$(mktemp -d)
  git worktree add -q --detach "$tmp" origin/dev
  if ! git -C "$tmp" merge -q --no-edit -m "$title" "$c"; then
    git -C "$tmp" merge --abort
    git worktree remove --force "$tmp"
    fail "master does not merge cleanly into dev: on a branch from dev run git merge origin/master, resolve, commit, and merge that into dev with a pull request (a merge commit)"
  fi
  if git -C "$tmp" push -q origin HEAD:refs/heads/dev; then
    git worktree remove "$tmp"
    echo "dev: $(git log --oneline -1 origin/dev)"
    return
  fi
  git worktree remove --force "$tmp"
  echo "dev refused the push; going through a pull request" >&2
  pr=$(gh_own pr list -R "$REPO" --head master --base dev --state open --json url --jq '.[0].url // empty')
  if [[ -z $pr ]]; then
    pr=$(gh_own pr create -R "$REPO" --base dev --head master --title "$title" \
      --body "发版 / 热补丁之后把 master 合回 dev，好让 master 一直是 dev 的祖先。只能用 **Create a merge commit** 合并。")
  fi
  if gh_own pr merge "$pr" -R "$REPO" --merge --auto || gh_own pr merge "$pr" -R "$REPO" --merge; then
    echo "dev: $pr merges master"
  else
    echo "::warning::$pr (master into dev) needs you: merge it with a merge commit before the next release"
  fi
}
