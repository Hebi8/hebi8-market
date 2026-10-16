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
# 1 not deployed (refused before changing anything, or rolled back: the live instance runs what it ran before),
# 3 unknown (the connection broke and the live machine could not say; master did not move). After 3, run the
# same deploy again once the live machine answers: it finishes a deploy that went through or does it again.
#
# The live checkout keeps refs/hebi8/live, the commit last confirmed running (healthy after a deploy). That,
# not the checkout's HEAD, says what is live: HEAD moves at the fast-forward, before the build and the check.
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
  local sha
  sha=$(git rev-parse --verify "$ref^{commit}")

  if [[ $host == local ]]; then
    HEBI8_LIVE=$PWD live "$sha"
  else
    remote "$host" "$sha"
    git merge --ff-only "$sha"
  fi
  git push origin master
  echo "deployed $(git rev-parse --short HEAD)"
}

# <host> <commit>: the live side on the host, with this file. Its checkout gets the commit's objects first (a
# ref of its own, so neither checkout's branches are touched).
remote() {
  local host=$1 sha=$2 dir=${HEBI8_LIVE:-dev/hebi8-market} rc=0 state
  git push -q "$host:$dir" "+$sha:refs/hebi8/deploy"
  on_host "$host" live "$sha" || rc=$?
  case $rc in
    0) return ;;
    1) fail "the deploy on $host did not go through and the instance there runs what it ran before; master did not move" ;;
  esac
  # anything else (255 is ssh's own) leaves the outcome open: ask the live checkout what runs
  echo "deploy.sh: the deploy on $host ended with status $rc; asking it what runs" >&2
  state=$(on_host "$host" status "$sha") || state=unreachable
  case $state in
    done) echo "$host runs ${sha:0:7} and answers; going on" ;;
    not-live) fail "$host does not run ${sha:0:7}: it is back at what ran before; master did not move" ;;
    *) unknown "$host: $state" ;;
  esac
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

# <commit>: on the live machine, from its checkout (HEBI8_LIVE, relative to $HOME or absolute).
live() {
  local sha=$1 unit=${HEBI8_UNIT:-hebi8-market}
  local secrets=${HEBI8_SECRETS:-$HOME/.config/hebi8/market}
  live_dir
  local health
  health=$(health_url "$unit")
  # one deploy at a time; a rerun waits for one that lost its connection and is still going
  exec 9>"$(git rev-parse --git-dir)/hebi8-deploy.lock"
  flock -w 900 9 || { echo "deploy.sh: another deploy still holds the lock" >&2; exit 3; }
  # the first deploy under this scheme: what the checkout is at is what runs
  if ! git rev-parse -q --verify "$LIVE_REF" >/dev/null; then git update-ref "$LIVE_REF" HEAD; fi
  local prev
  prev=$(git rev-parse "$LIVE_REF")

  [[ $(git branch --show-current) == master ]] || fail "the live checkout is not on master"
  [[ -z $(git status --porcelain) ]] || fail "the live checkout has local changes"
  # build with the node the service runs on (the unit's PATH): better-sqlite3 is compiled for it
  local path
  path=$(systemctl --user show "$unit" -p Environment --value | tr ' ' '\n' | sed -n 's/^PATH=//p')
  if [[ -n $path ]]; then export PATH=$path; fi

  if [[ $prev == "$sha" && $(git rev-parse HEAD) == "$sha" ]] && healthy "$health"; then
    echo "live: already runs $(git log --oneline -1)"
    return
  fi
  git merge-base --is-ancestor "$prev" "$sha" || fail "${sha:0:7} is not a fast-forward of what runs (${prev:0:7})"
  # HEAD is what runs, or this commit when an earlier try stopped after the fast-forward
  git merge-base --is-ancestor HEAD "$sha" ||
    fail "the live checkout is at $(git rev-parse --short HEAD), neither what runs (${prev:0:7}) nor on the way to ${sha:0:7}; reset it to ${prev:0:7} there"

  local ts backup
  ts=$(date +%Y%m%d-%H%M%S)
  backup=$HOME/backups/hebi8/$ts-deploy
  mkdir -p "$backup"
  cp -a vault "$backup/vault"
  cp -a "$secrets" "$backup/secrets"
  node -e "new (require('better-sqlite3'))('data/hebi8.db', { readonly: true }).backup(process.argv[1])" "$backup/hebi8.db"
  echo "backup: $(hostname):$backup"

  git merge --ff-only "$sha"
  echo "live master: $(git log --oneline -1)"
  if build_and_start "$prev" "$unit" "$health" "$ts"; then
    git update-ref "$LIVE_REF" "$sha"
    return
  fi

  # recorded as live by an earlier run and no longer answering: there is nothing older to go back to
  if [[ $prev == "$sha" ]]; then
    echo "deploy.sh: ${sha:0:7} was already live here but does not answer and did not come back; the service needs a look" >&2
    exit 3
  fi
  echo "deploy failed; rolling back to ${prev:0:7}" >&2
  git reset --hard "$prev"
  build_and_start "$sha" "$unit" "$health" "$ts" || echo "rollback failed too; the service needs a look" >&2
  exit 1
}

# <commit>, on the live machine: done (the recorded commit, checked out, and the page answers), not-live (the
# checkout is at the recorded commit and that is another one), busy (a deploy holds the lock) or unclear.
status() {
  local sha=$1 unit=${HEBI8_UNIT:-hebi8-market} rec head
  live_dir
  exec 9>"$(git rev-parse --git-dir)/hebi8-deploy.lock"
  if ! flock -n 9; then
    echo busy
    return
  fi
  rec=$(git rev-parse -q --verify "$LIVE_REF" || true)
  head=$(git rev-parse HEAD)
  if [[ $rec == "$sha" && $head == "$sha" ]] && healthy "$(health_url "$unit")"; then
    echo done
  elif [[ -n $rec && $rec != "$sha" && $head == "$rec" ]]; then
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

# Installs dependencies when the lockfile moved since <from>, rebuilds and restarts, then checks the page.
build_and_start() {
  local from=$1 unit=$2 health=$3 ts=$4
  systemctl --user stop "$unit"
  # a stale .next/dev from an old `next dev` breaks the production typecheck
  if [[ -d .next/dev ]]; then mv .next/dev "/tmp/hebi8-next-dev-$ts-$RANDOM"; fi
  if ! git diff --quiet "$from" HEAD -- package-lock.json; then npm ci || return 1; fi
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
  echo "deploy.sh: the outcome is unknown ($1); master did not move. Once the live machine answers, run the same deploy again: it finishes one that went through or does it again" >&2
  exit 3
}

main "$@"
