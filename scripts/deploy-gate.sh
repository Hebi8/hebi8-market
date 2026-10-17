#!/usr/bin/env bash
# The only thing the deploy key may run on the live machine: its authorized_keys line is a forced command,
#   command="<live checkout>/scripts/deploy-gate.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 …
# and whatever the other end asked for arrives in SSH_ORIGINAL_COMMAND. Exactly two requests pass:
#   live <40-hex commit>     fetch origin's master; the commit must be on it; then deploy.sh live <commit>
#   status <40-hex commit>   deploy.sh status <commit>, with the live checkout's own deploy.sh (HEAD's)
# Anything else exits 2 and runs nothing. `scripts/deploy.sh ci <commit>` (the GitHub Actions workflow) is the
# caller; see docs/self-hosting.md §用 GitHub Actions 自动部署.
#
# The live checkout is the one this file is in (HEBI8_LIVE for deploy.sh). Settings deploy.sh reads on the live
# side (HEBI8_UNIT, HEBI8_HEALTH_URL, HEBI8_SECRETS) go in front of the path in the command="…".
#
# Which copies run. This file is the live checkout's own, so it is the version that runs (while a deploy is
# unfinished, its target). For `live`, deploy.sh is not: it is read out of git from the commit being deployed,
# once that is known to be on origin's master, into a temporary file, as when deploy.sh uploaded itself over ssh,
# so a version brings its own deploy logic. `status` never runs the commit it is asked about (the object store can
# hold commits that never reached master, a dev clone's for one): it runs HEAD's deploy.sh, which got there
# through `live` or a rollback, so `status` has to read what an older or newer deploy.sh left behind. A change to
# this file takes effect from the deploy after the one that brings it: the deploy that ships it still goes
# through the old one. Keep `live` and `status` working across that one step, and the live checkout's first copy
# of this file comes with a deploy that does not need it (scripts/deploy.sh from the repo home) before the key
# goes into authorized_keys.
# Everything runs inside main(): a deploy rewrites this file while it runs.
set -euo pipefail

main() {
  local req=${SSH_ORIGINAL_COMMAND:-} dir cmd sha rev f s
  if [[ ! $req =~ ^(live|status)\ ([0-9a-f]{40})$ ]]; then
    echo "deploy-gate: refused: '$req' (only 'live <commit>' or 'status <commit>', a full 40-character commit)" >&2
    exit 2
  fi
  cmd=${BASH_REMATCH[1]}
  sha=${BASH_REMATCH[2]}
  dir=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
  cd "$dir"

  rev=HEAD
  if [[ $cmd == live ]]; then
    # only master's history: GitHub hands out any commit of the fork network by its hash, a fork's too
    git fetch -q origin master
    git merge-base --is-ancestor "$sha" refs/remotes/origin/master 2>/dev/null || {
      echo "deploy-gate: refused: ${sha:0:7} is not on origin's master" >&2
      exit 2
    }
    rev=$sha
  fi

  f=$(mktemp)
  git show "$rev:scripts/deploy.sh" >"$f"
  s=0
  HEBI8_LIVE=$dir bash "$f" "$cmd" "$sha" </dev/null || s=$?
  rm -f "$f"
  exit "$s"
}

main "$@"
