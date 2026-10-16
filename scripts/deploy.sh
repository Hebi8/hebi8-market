#!/usr/bin/env bash
# Deploy a branch to the live instance: back up, fast-forward master, build, restart, health check, push.
# Usage: scripts/deploy.sh <branch-or-commit>
# Runs in the repo home (HEBI8_REPO, the checkout whose master is what is live). The instance itself runs on
# HEBI8_LIVE_HOST: the commit is pushed straight into the live checkout over ssh, this same file runs there as
# `deploy.sh live <commit>` (back up, fast-forward, build, restart, health check, and back to the previous
# commit when the build or the check fails), and only after that does master move here and go to origin.
# HEBI8_LIVE_HOST=local: the live checkout (HEBI8_LIVE) is the repo home, everything happens on this machine.
#
# Exit status: 0 deployed (master moved and was pushed; a failed push is git's own status, after master moved),
# 1 not deployed (the live instance runs what it ran before), 3 unknown (master did not move). After 3, run the
# same deploy again once the live machine answers: it finishes a deploy that went through or does it again.
#
# State in the live checkout's .git: refs/hebi8/live is the commit last confirmed running (healthy after a
# deploy or a rollback), never HEAD, which moves before the build and the check. hebi8-deploy.pending is
# written before HEAD moves and removed only once the new commit is recorded, or the old one is back and
# healthy; while it is there nothing is known. hebi8-deploy.lock: one deploy at a time. Whenever the live side
# does not end with 0, `deploy.sh status` decides, and only a clear "runs what it ran before" is a 1.
# A new live machine needs a baseline before its first deploy: in the live checkout, while the instance runs
# healthy, git update-ref refs/hebi8/live <the full commit it runs>.
# Everything runs inside main(), so bash has read the whole file before the merge can change it.
set -euo pipefail

# the file itself, before anything changes directory: this is what runs on the live machine
SELF=$(readlink -f "${BASH_SOURCE[0]}")
LIVE_REF=refs/hebi8/live

main() {
  case ${1:-} in
    live)
      live "${2:?usage: deploy.sh live <commit>}"
      return
      ;;
    status)
      status "${2:?usage: deploy.sh status <commit>}"
      return
      ;;
  esac
  local host=${HEBI8_LIVE_HOST:-dreaife@100.102.150.101}
  local ref=${1:?usage: deploy.sh <branch-or-commit>}
  local repo=${HEBI8_REPO:-$HOME/dev/hebi8-market}
  # on one machine the live checkout is the repo home, and HEBI8_LIVE names it as it always did
  if [[ $host == local ]]; then repo=${HEBI8_LIVE:-$HOME/dev/hebi8-market}; fi

  cd "$repo"
  [[ $(git branch --show-current) == master ]] || fail "$repo is not on master"
  [[ -z $(git status --porcelain) ]] || fail "$repo has local changes"
  git merge-base --is-ancestor HEAD "$ref" || fail "$ref is not a fast-forward of master; rebase it onto master first"
  local sha rc=0 state
  sha=$(git rev-parse --verify "$ref^{commit}")

  # the live side always runs as its own bash, where set -e holds (inside an `||` list it would not)
  if [[ $host == local ]]; then
    HEBI8_LIVE=$PWD bash "$SELF" live "$sha" || rc=$?
  else
    git push -q "$host:${HEBI8_LIVE:-dev/hebi8-market}" "+$sha:refs/hebi8/deploy" ||
      fail "could not hand ${sha:0:7} to $host; nothing changed there"
    on_host "$host" live "$sha" || rc=$?
  fi
  if ((rc != 0)); then
    # whatever said so (the deploy, ssh, the wrapper), the live checkout decides what runs
    echo "deploy.sh: the live side ended with status $rc; asking it what runs" >&2
    if [[ $host == local ]]; then
      state=$(HEBI8_LIVE=$PWD bash "$SELF" status "$sha") || state="unclear (status failed)"
    else
      state=$(on_host "$host" status "$sha") || state="unreachable"
    fi
    case $state in
      done) echo "it runs ${sha:0:7} and answers; going on" ;;
      not-live) fail "it does not run ${sha:0:7}: it runs what it ran before, healthy; master did not move" ;;
      *) unknown "$state" ;;
    esac
  fi
  if [[ $host != local ]]; then git merge --ff-only "$sha"; fi
  git push origin master
  echo "deployed $(git rev-parse --short HEAD)"
}

# <host> <live|status> <commit>: this file runs there, over stdin into a file first so nothing it runs can
# read the rest of it. The settings that name places on that machine (HEBI8_LIVE, HEBI8_UNIT,
# HEBI8_HEALTH_URL, HEBI8_SECRETS) go along when they are set here.
on_host() {
  local host=$1 envs=() v
  for v in HEBI8_LIVE HEBI8_UNIT HEBI8_HEALTH_URL HEBI8_SECRETS; do
    if [[ -n ${!v:-} ]]; then envs+=("$v=$(printf %q "${!v}")"); fi
  done
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    "f=\$(mktemp) && cat > \"\$f\" && env ${envs[*]} bash \"\$f\" $2 $3; s=\$?; rm -f \"\$f\"; exit \$s" <"$SELF"
}

# <commit>: on the live machine, from its checkout (HEBI8_LIVE, relative to $HOME or absolute). Exits 0 when
# the commit is recorded as live; otherwise the caller asks `status`.
live() {
  local sha=$1 unit=${HEBI8_UNIT:-hebi8-market}
  local secrets=${HEBI8_SECRETS:-$HOME/.config/hebi8/market}
  live_dir
  local health pending rec base prev
  health=$(health_url "$unit")
  # a rerun waits for one that lost its connection and is still going
  exec 9>"$(git rev-parse --git-path hebi8-deploy.lock)"
  flock -w 900 9 || { echo "deploy.sh: another deploy still holds the lock" >&2; exit 3; }
  pending=$(git rev-parse --git-path hebi8-deploy.pending)
  rec=$(git rev-parse -q --verify "$LIVE_REF" || true)

  [[ $(git branch --show-current) == master ]] || fail "the live checkout is not on master"
  [[ -z $(git status --porcelain) ]] || fail "the live checkout has local changes"
  # build with the node the service runs on (the unit's PATH): better-sqlite3 is compiled for it
  local path
  path=$(systemctl --user show "$unit" -p Environment --value | tr ' ' '\n' | sed -n 's/^PATH=//p')
  if [[ -n $path ]]; then export PATH=$path; fi

  if [[ ! -e $pending && -n $rec && $rec == "$sha" && $(git rev-parse HEAD) == "$sha" ]] && healthy "$health"; then
    echo "live: already runs $(git log --oneline -1)"
    return
  fi
  # what runs: where an unfinished deploy started, else the record; empty when nothing says (no baseline yet)
  base=$rec
  if [[ -e $pending ]]; then base=$(sed -n 's/^from //p' "$pending"); fi
  # what to go back to; without a record that is the checkout as it is
  prev=${base:-$(git rev-parse HEAD)}
  git merge-base --is-ancestor "$prev" "$sha" || fail "${sha:0:7} is not a fast-forward of what runs (${prev:0:7})"
  git merge-base --is-ancestor HEAD "$sha" ||
    fail "the live checkout is at $(git rev-parse --short HEAD), not on the way from ${prev:0:7} to ${sha:0:7}"

  local ts backup
  ts=$(date +%Y%m%d-%H%M%S)
  backup=$HOME/backups/hebi8/$ts-deploy
  mkdir -p "$backup"
  cp -a vault "$backup/vault"
  cp -a "$secrets" "$backup/secrets"
  node -e "new (require('better-sqlite3'))('data/hebi8.db', { readonly: true }).backup(process.argv[1])" "$backup/hebi8.db"
  echo "backup: $(hostname):$backup"

  printf 'target %s\nfrom %s\nstarted %s\n' "$sha" "$prev" "$(date -Is)" >"$pending"
  git merge --ff-only "$sha"
  echo "live master: $(git log --oneline -1)"
  if build_and_start "$base" "$unit" "$health" "$ts"; then
    git update-ref "$LIVE_REF" "$sha"
    rm -f "$pending"
    return
  fi

  if [[ $prev == "$sha" ]]; then
    echo "deploy.sh: ${sha:0:7} does not answer and there is nothing older to go back to; the service needs a look" >&2
    exit 3
  fi
  echo "deploy failed; rolling back to ${prev:0:7}" >&2
  git reset --hard "$prev"
  if build_and_start "$sha" "$unit" "$health" "$ts"; then
    git update-ref "$LIVE_REF" "$prev"
    rm -f "$pending"
    exit 1
  fi
  echo "deploy.sh: the rollback to ${prev:0:7} did not come back either; the service needs a look" >&2
  exit 3
}

# <commit>, on the live machine: done (recorded, checked out, healthy), not-live (another commit is recorded,
# checked out and healthy), busy (a deploy holds the lock) or unclear (an unfinished deploy or rollback, no
# record, no answer, or a checkout that is neither).
status() {
  local sha=$1 unit=${HEBI8_UNIT:-hebi8-market} pending rec head
  live_dir
  exec 9>"$(git rev-parse --git-path hebi8-deploy.lock)"
  if ! flock -n 9; then
    echo busy
    return
  fi
  pending=$(git rev-parse --git-path hebi8-deploy.pending)
  rec=$(git rev-parse -q --verify "$LIVE_REF" || true)
  head=$(git rev-parse HEAD)
  if [[ -e $pending ]]; then
    echo "unclear (a deploy to $(sed -n 's/^target //p' "$pending" | cut -c1-7) did not finish)"
  elif [[ -z $rec ]]; then
    echo "unclear (nothing recorded as live)"
  elif ! healthy "$(health_url "$unit")"; then
    echo "unclear (the page does not answer)"
  elif [[ $rec == "$sha" && $head == "$sha" ]]; then
    echo done
  elif [[ $rec != "$sha" && $head == "$rec" ]]; then
    echo not-live
  else
    echo "unclear (checkout at ${head:0:7}, recorded ${rec:0:7})"
  fi
}

# cd into the live checkout
live_dir() {
  local dir=${HEBI8_LIVE:-dev/hebi8-market}
  [[ $dir == /* ]] || dir=$HOME/$dir
  cd "$dir"
}

# <unit>: HEBI8_HEALTH_URL, or the address the unit's `next start -H … -p …` serves on
health_url() {
  if [[ -n ${HEBI8_HEALTH_URL:-} ]]; then
    echo "$HEBI8_HEALTH_URL"
    return
  fi
  local exec host port
  exec=$(systemctl --user show "$1" -p ExecStart --value 2>/dev/null || true)
  host=$(sed -nE 's/.* (-H|--hostname) ([^ ;]+).*/\2/p' <<<"$exec")
  port=$(sed -nE 's/.* (-p|--port) ([0-9]+).*/\2/p' <<<"$exec")
  [[ -n $host && $host != 0.0.0.0 && $host != "::" ]] || host=127.0.0.1
  echo "http://$host:${port:-3000}/"
}

# Installs dependencies when the lockfile moved since <from> (always when it is empty: nothing says what the
# installed ones are for), rebuilds and restarts, then checks the page.
build_and_start() {
  local from=$1 unit=$2 health=$3 ts=$4
  systemctl --user stop "$unit"
  # a stale .next/dev from an old `next dev` breaks the production typecheck
  if [[ -d .next/dev ]]; then mv .next/dev "/tmp/hebi8-next-dev-$ts-$RANDOM"; fi
  if [[ -z $from ]] || ! git diff --quiet "$from" HEAD -- package-lock.json; then npm ci || return 1; fi
  npm run build || return 1
  systemctl --user start "$unit"
  local i
  for i in {1..20}; do
    if healthy "$health"; then return 0; fi
    sleep 1
  done
  return 1
}

healthy() {
  [[ $(curl -s -o /dev/null -w '%{http_code}' "$1") == 200 ]]
}

fail() {
  echo "deploy.sh: $1" >&2
  exit 1
}

unknown() {
  echo "deploy.sh: the outcome is unknown: $1; master did not move. Once the live machine answers, run the same deploy again: it finishes one that went through or does it again" >&2
  exit 3
}

main "$@"
