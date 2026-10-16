#!/usr/bin/env bash
# Deploy a branch to the live instance: back up, fast-forward master, build, restart, health check, push.
# Usage: scripts/deploy.sh <branch-or-commit>
# Runs in the repo home (HEBI8_REPO, the checkout whose master is what is live). The instance itself runs on
# HEBI8_LIVE_HOST: the commit is pushed straight into the live checkout over ssh, this same file runs there as
# `deploy.sh live <commit>` (back up, fast-forward, build, restart, health check, and back to the previous
# commit when the build or the check fails), and only after that does master move here and go to origin.
# HEBI8_LIVE_HOST=local: the repo home is the live checkout, everything happens on this machine.
# Everything runs inside main(), so bash has read the whole file before the merge can change it.
set -euo pipefail

main() {
  if [[ ${1:-} == live ]]; then
    live "${2:?usage: deploy.sh live <commit>}"
    return
  fi
  local repo=${HEBI8_REPO:-$HOME/dev/hebi8-market}
  local host=${HEBI8_LIVE_HOST:-dreaife@100.102.150.101}
  local ref=${1:?usage: deploy.sh <branch-or-commit>}

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
# ref of its own, so neither checkout's branches are touched). The settings that name places on that machine
# (HEBI8_LIVE, HEBI8_UNIT, HEBI8_HEALTH_URL, HEBI8_SECRETS) go along when they are set here.
remote() {
  local host=$1 sha=$2 dir=${HEBI8_LIVE:-dev/hebi8-market} envs=() v
  for v in HEBI8_LIVE HEBI8_UNIT HEBI8_HEALTH_URL HEBI8_SECRETS; do
    if [[ -n ${!v:-} ]]; then envs+=("$v=$(printf %q "${!v}")"); fi
  done
  git push -q "$host:$dir" "+$sha:refs/hebi8/deploy"
  # the script goes over stdin into a file first, so nothing the deploy runs can read the rest of it
  if ssh -o BatchMode=yes "$host" "f=\$(mktemp) && cat > \"\$f\" && env ${envs[*]} bash \"\$f\" live $sha; s=\$?; rm -f \"\$f\"; exit \$s" <"${BASH_SOURCE[0]}"; then
    return
  fi
  # a connection that drops after the live side finished is not a failed deploy: the live checkout decides
  if [[ $(ssh -o BatchMode=yes "$host" "git -C $dir rev-parse HEAD" </dev/null 2>/dev/null) == "$sha" ]]; then
    echo "ssh failed, but $host runs ${sha:0:7}; going on"
    return
  fi
  fail "the deploy on $host failed; it went back to the previous commit (see above), master did not move"
}

# <commit>: on the live machine, from its checkout (HEBI8_LIVE, relative to $HOME or absolute).
live() {
  local sha=$1
  local dir=${HEBI8_LIVE:-dev/hebi8-market}
  local unit=${HEBI8_UNIT:-hebi8-market}
  local health=${HEBI8_HEALTH_URL:-http://100.102.150.101:8808/}
  local secrets=${HEBI8_SECRETS:-$HOME/.config/hebi8/market}
  [[ $dir == /* ]] || dir=$HOME/$dir

  cd "$dir"
  [[ $(git branch --show-current) == master ]] || fail "the live checkout is not on master"
  [[ -z $(git status --porcelain) ]] || fail "the live checkout has local changes"
  # build with the node the service runs on (the unit's PATH): better-sqlite3 is compiled for it
  local path
  path=$(systemctl --user show "$unit" -p Environment --value | tr ' ' '\n' | sed -n 's/^PATH=//p')
  if [[ -n $path ]]; then export PATH=$path; fi

  # run again after a dropped connection: already there and answering is done
  if [[ $(git rev-parse HEAD) == "$sha" ]] && healthy "$health"; then
    echo "live: already at $(git log --oneline -1)"
    return
  fi
  git merge-base --is-ancestor HEAD "$sha" || fail "${sha:0:7} is not a fast-forward of the live checkout ($(git rev-parse --short HEAD))"

  local prev ts backup
  prev=$(git rev-parse HEAD)
  ts=$(date +%Y%m%d-%H%M%S)
  backup=$HOME/backups/hebi8/$ts-deploy
  mkdir -p "$backup"
  cp -a vault "$backup/vault"
  cp -a "$secrets" "$backup/secrets"
  node -e "new (require('better-sqlite3'))('data/hebi8.db', { readonly: true }).backup(process.argv[1])" "$backup/hebi8.db"
  echo "backup: $(hostname):$backup"

  git merge --ff-only "$sha"
  echo "live master: $(git log --oneline -1)"
  if build_and_start "$prev" "$unit" "$health" "$ts"; then return; fi

  echo "deploy failed; rolling back to ${prev:0:7}" >&2
  git reset --hard "$prev"
  build_and_start "$sha" "$unit" "$health" "$ts" || echo "rollback failed too; the service needs a look" >&2
  exit 1
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

main "$@"
