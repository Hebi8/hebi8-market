#!/usr/bin/env bash
# The dev instance: follows a branch of origin (dev) and takes the live owner's vault once a day. It runs
# under systemd user units that `install` writes, all below the live service in priority (it may share the
# machine with it):
#   hebi8-dev.service             next start from releases/<sha> (`current`)
#   hebi8-dev-poll.timer          every minute: asks origin where the branch is (git ls-remote: no objects come
#                                 down), fetches and rebuilds only when it moved
#   hebi8-dev-sync.timer          the daily copy of the live owner's vault and a cache snapshot, at SYNC_AT
# Everything lives under $HEBI8_DEV_ROOT (default ~/hebi8-dev); what is particular to the machine (address,
# where the live checkout is, which Node) goes in its config.env, never in the repo. Nothing connects in
# to deploy it. See docs/maintainers.md §dev 实例.
#
# Usage: hebi8-dev.sh status | update [--force] | sync | branch <name> | install <scripts/dev-instance dir>
#
# Each release is a git worktree in releases/<sha>, built while the old one keeps serving; `current`
# points at the one that runs. A commit that fails to build or to answer 200 is remembered in
# state/failed and not tried again until the branch moves (or `update --force`).
set -uo pipefail

ROOT=${HEBI8_DEV_ROOT:-$HOME/hebi8-dev}

# defaults; config.env overrides them
BRANCH=dev                     # a branch of origin, or any ref or commit the clone has
HOST=127.0.0.1                 # where next start listens
PORT=8809
SYNC_AT=04:30                  # daily copy from the live instance, SYNC_TZ clock; off the live 07:30 / 17:30 syncs
SYNC_TZ=Asia/Tokyo
APP_SYNC_AT=08:00              # the dev app's own bar sync, once a day in place of the owner's sync.at; empty keeps theirs
LIVE_DIR=                      # the live checkout (absolute path, or relative to the remote home with LIVE_SHELL)
LIVE_SHELL=()                  # empty: the live checkout is on this machine; else a command that runs its last argument there
LIVE_NODE=node                 # the live service's node: its better-sqlite3 is built for it; set it with LIVE_SHELL
                               # (NODE_BIN is only this machine's PATH)
NODE_BIN=                      # put first on PATH for builds and next start
KEEP=3                         # releases kept on disk, the running one included
# shellcheck source=/dev/null
[[ -f $ROOT/config.env ]] && source "$ROOT/config.env"
[[ -n $NODE_BIN ]] && PATH=$NODE_BIN:$PATH

URL="http://$HOST:$PORT/"
APP=hebi8-dev

# to the journal when a unit runs it
log() { echo "$*" >&2; }

# The environment `next start` and `next build` get. The secrets directory is the dev instance's own
# and starts empty: no notification channel, so alerts are judged but never sent.
app_env() {
  export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
  export HEBI8_VAULT=$ROOT/vault HEBI8_DB=$ROOT/data/hebi8.db HEBI8_SECRETS=$ROOT/secrets
  export HEBI8_PUBLIC_URL=${URL%/}
}

healthy() {
  local _
  for _ in {1..60}; do
    [[ $(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL") == 200 ]] && return 0
    systemctl --user is-active --quiet "$APP" || return 1
    sleep 1
  done
  return 1
}

target_commit() {
  git -C "$ROOT/repo" rev-parse --verify -q "origin/$BRANCH^{commit}" || git -C "$ROOT/repo" rev-parse --verify -q "$BRANCH^{commit}"
}

# Builds releases/<sha> next to the running one; npm ci only when the lockfile differs.
build_release() {
  local sha=$1 rel=$ROOT/releases/$1 prev cilog=$ROOT/logs/build-${1:0:7}.log
  prev=$(readlink -f "$ROOT/current" 2> /dev/null || true)
  drop_release "$sha"
  git -C "$ROOT/repo" worktree add --quiet --detach "$rel" "$sha" || return 1
  : > "$cilog"
  if [[ -n $prev && -d $prev/node_modules ]] && cmp -s "$prev/package-lock.json" "$rel/package-lock.json"; then
    cp -al "$prev/node_modules" "$rel/node_modules" || return 1
  else
    log "lockfile changed: npm ci"
    (cd "$rel" && npm ci --no-audit --no-fund) >> "$cilog" 2>&1 || return 1
  fi
  # a scratch database and vault, so a build never opens the running instance's
  (app_env && export HEBI8_DB=$ROOT/tmp/build.db HEBI8_VAULT=$ROOT/tmp/build-vault && cd "$rel" && npm run build) >> "$cilog" 2>&1
}

drop_release() {
  git -C "$ROOT/repo" worktree remove --force "$ROOT/releases/$1" 2> /dev/null || rm -rf "$ROOT/releases/$1"
  git -C "$ROOT/repo" worktree prune
}

switch_to() {
  ln -sfn "releases/$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
}

prune_releases() {
  local cur rel n=0
  cur=$(readlink -f "$ROOT/current")
  # shellcheck disable=SC2045 # newest first; the names are commit hashes
  for rel in $(ls -dt "$ROOT"/releases/*/ 2> /dev/null); do
    rel=${rel%/}
    n=$((n + 1))
    [[ $rel == "$cur" || $n -le $KEEP ]] && continue
    drop_release "$(basename "$rel")"
  done
  find "$ROOT/logs" -name 'build-*.log' -mtime +14 -delete
}

do_update() {
  local force=${1:-} target prev
  git -C "$ROOT/repo" fetch --quiet --prune origin || { log "fetch failed"; return 1; }
  target=$(target_commit) || { log "$BRANCH: no such branch or commit"; return 1; }
  prev=$(basename "$(readlink "$ROOT/current" 2> /dev/null)")
  # the branch is back on what runs: whatever failed in between no longer matters
  if [[ $target == "$prev" ]]; then
    rm -f "$ROOT/state/failed"
    return 0
  fi
  if [[ -z $force && $target == "$(cat "$ROOT/state/failed" 2> /dev/null)" ]]; then return 0; fi

  log "update $BRANCH: ${prev:0:7}${prev:+ }-> ${target:0:7}"
  if ! build_release "$target"; then
    echo "$target" > "$ROOT/state/failed"
    drop_release "$target"
    log "build of ${target:0:7} failed, ${prev:0:7} keeps running; see logs/build-${target:0:7}.log"
    return 1
  fi
  switch_to "$target"
  systemctl --user restart "$APP"
  if healthy; then
    rm -f "$ROOT/state/failed"
    log "running ${target:0:7}"
    prune_releases
    return 0
  fi
  echo "$target" > "$ROOT/state/failed"
  log "${target:0:7} did not answer 200; back to ${prev:0:7} (journalctl --user -u $APP)"
  systemctl --user stop "$APP"
  if [[ -n $prev && -d $ROOT/releases/$prev ]]; then
    switch_to "$prev"
    systemctl --user start "$APP"
    healthy || log "${prev:0:7} does not answer either; the dev instance needs a look"
    drop_release "$target"
  fi
  return 1
}

# Takes the live owner's vault, a cache snapshot and the local datasets (export.mjs, read-only, run in the
# live checkout with the live Node) and swaps them in. One way only: what was changed on the dev instance
# is gone afterwards.
do_sync() {
  local tmp script dir node links
  [[ -L $ROOT/current ]] || { log "sync: no release yet"; return 1; }
  [[ -n $LIVE_DIR ]] || { log "sync: LIVE_DIR is not set in config.env"; return 1; }
  tmp=$(mktemp -d "$ROOT/tmp/sync.XXXXXX")
  if ((${#LIVE_SHELL[@]})); then
    log "sync: exporting from $LIVE_DIR via ${LIVE_SHELL[*]}"
    # the script travels in the command line: stdin of a remote shell is not always a clean channel
    script=$(base64 -w0 "$ROOT/bin/export.mjs")
    printf -v dir %q "$LIVE_DIR"
    printf -v node %q "$LIVE_NODE"
    "${LIVE_SHELL[@]}" "f=\$(mktemp /tmp/hebi8-dev-export.XXXXXX.mjs) && echo $script | base64 -d > \$f && cd $dir && $node \$f; s=\$?; rm -f \$f; exit \$s" \
      < /dev/null > "$tmp/raw" 2> "$tmp/err"
  else
    log "sync: exporting from $LIVE_DIR"
    (cd "$LIVE_DIR" && "$LIVE_NODE" "$ROOT/bin/export.mjs") < /dev/null > "$tmp/raw" 2> "$tmp/err"
  fi || {
    log "sync: export failed: $(tail -c 300 "$tmp/err" "$tmp/raw" | tr '\n' ' ')"
    rm -rf "$tmp"
    return 1
  }
  mkdir -p "$tmp/new"
  if ! tr -d '\r' < "$tmp/raw" | sed -n '/^HEBI8-DEV-EXPORT-BEGIN$/,/^HEBI8-DEV-EXPORT-END$/{/^HEBI8-DEV-EXPORT/d;p}' | base64 -d | tar xz -C "$tmp/new" \
    || [[ ! -f $tmp/new/vault/hebi8.yaml || ! -f $tmp/new/hebi8.db ]]; then
    log "sync: the export did not come through whole"
    rm -rf "$tmp"
    return 1
  fi
  tr -d '\r' < "$tmp/err" | sed -n 's/^export\.mjs: \(skipped .*\)/sync: \1/p' >&2
  # export.mjs leaves links out; one here would lead prepare-vault and the app into the live data
  links=$(find "$tmp/new" -type l | head -3)
  if [[ -n $links ]]; then
    log "sync: the export has symbolic links, nothing changed: $(echo "$links" | sed "s|^$tmp/new/||" | tr '\n' ' ')"
    rm -rf "$tmp"
    return 1
  fi
  mkdir -p "$tmp/new/datasets"
  HEBI8_DEV_SYNC_AT=$APP_SYNC_AT node "$ROOT/bin/prepare-vault.mjs" "$ROOT/current" "$tmp/new/vault/hebi8.yaml" "$tmp/new/datasets" "$ROOT/datasets" \
    || { log "sync: prepare-vault failed"; rm -rf "$tmp"; return 1; }

  systemctl --user stop "$APP"
  rm -rf "$ROOT/vault.old" "$ROOT/datasets.old"
  [[ -d $ROOT/vault ]] && mv "$ROOT/vault" "$ROOT/vault.old"
  [[ -d $ROOT/datasets ]] && mv "$ROOT/datasets" "$ROOT/datasets.old"
  mv "$tmp/new/vault" "$ROOT/vault"
  mv "$tmp/new/datasets" "$ROOT/datasets"
  rm -f "$ROOT/data/hebi8.db" "$ROOT/data/hebi8.db-wal" "$ROOT/data/hebi8.db-shm"
  mv "$tmp/new/hebi8.db" "$ROOT/data/hebi8.db"
  rm -rf "$ROOT/vault.old" "$ROOT/datasets.old"
  systemctl --user start "$APP"
  healthy || log "sync: the app does not answer 200 after the swap (journalctl --user -u $APP)"
  log "sync: done ($(tr -d '\n ' < "$tmp/new/export.json" | cut -c1-200))"
  rm -rf "$tmp"
}

# Where origin's BRANCH is, without fetching: one ls-remote, empty when BRANCH is no branch there (a commit,
# a local ref), which then is not followed.
remote_head() {
  git -C "$ROOT/repo" ls-remote --quiet origin "refs/heads/$BRANCH" | cut -f1
}

# The timer's look: fetch and rebuild only when the branch is somewhere that neither runs nor failed. A build
# keeps the unit busy and the timer does not start it again meanwhile, so commits that land during a build are
# seen together on the next look and built once, as the newest. `update` leaves state/update for it: fetch
# and update whatever BRANCH is now, `force` retrying a failed commit too.
poll() {
  local head cur
  if [[ -f $ROOT/state/update ]]; then
    head=$(cat "$ROOT/state/update")
    rm -f "$ROOT/state/update"
    do_update "$head"
    return
  fi
  head=$(remote_head) || { log "ls-remote failed"; return 1; }
  [[ -n $head ]] || return 0
  cur=$(basename "$(readlink "$ROOT/current" 2> /dev/null)")
  if [[ $head == "$cur" ]]; then
    rm -f "$ROOT/state/failed"
    return 0
  fi
  [[ $head == "$(cat "$ROOT/state/failed" 2> /dev/null)" ]] && return 0
  do_update
}

# One change at a time: the poll and the sync both restart the app.
locked() {
  (
    flock 8
    "$@"
  ) 8> "$ROOT/run/ops.lock"
}

# Runs a job unit and waits for it, so it logs to the journal and runs at its priority like the timer's.
job() {
  local since s
  since=$(date +%s)
  systemctl --user start "$1"
  s=$?
  journalctl --user -u "$1" --since "@$since" --no-pager -o cat
  return $s
}

# A poll that was already running when asked returns without having seen state/update: run one more.
update_now() {
  local s
  job "$APP-poll.service"
  s=$?
  if [[ -f $ROOT/state/update ]]; then
    job "$APP-poll.service"
    s=$?
  fi
  return $s
}

status() {
  echo "url:      $URL"
  echo "branch:   $BRANCH -> $(git -C "$ROOT/repo" rev-parse --short "$(target_commit 2> /dev/null)" 2> /dev/null || echo '?')"
  echo "running:  $(git -C "$ROOT/current" log -1 --format='%h %s' 2> /dev/null || echo none)"
  echo "app:      $(systemctl --user is-active "$APP"), HTTP $(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL")"
  [[ -f $ROOT/state/failed ]] && echo "failed:   $(cut -c1-7 "$ROOT/state/failed") (not retried until $BRANCH moves)"
  systemctl --user list-timers "$APP-*" --all --no-pager
}

# The units, written from config.env. Nice, CPUWeight and the IO class keep the dev instance and its builds
# below the live service; MemoryHigh makes a build reclaim its own memory before anyone else's. (IOWeight
# needs the io controller delegated to the user manager, which Ubuntu does not do; the IO class works anyway.)
write_units() {
  local dir=$HOME/.config/systemd/user priority
  priority="Environment=HEBI8_DEV_ROOT=$ROOT
Nice=10
CPUWeight=20
IOWeight=20
IOSchedulingClass=best-effort
IOSchedulingPriority=7"
  mkdir -p "$dir"
  cat > "$dir/$APP.service" << EOF
[Unit]
Description=hebi8 market dev instance
After=network-online.target
Wants=network-online.target
ConditionPathExists=$ROOT/current

[Service]
$priority
MemoryHigh=1G
ExecStart=$ROOT/bin/hebi8-dev.sh unit-app
# next start's answer to SIGTERM
SuccessExitStatus=143
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
  cat > "$dir/$APP-poll.service" << EOF
[Unit]
Description=hebi8 market dev instance: follow the branch, rebuild when it moved

[Service]
Type=oneshot
$priority
MemoryHigh=3G
ExecStart=$ROOT/bin/hebi8-dev.sh unit-poll
# what the script says is at notice; systemd's own Starting / Finished every minute (info) stays out
SyslogLevel=notice
LogLevelMax=notice
EOF
  cat > "$dir/$APP-poll.timer" << EOF
[Unit]
Description=hebi8 market dev instance: look at the branch every minute

[Timer]
OnCalendar=minutely

[Install]
WantedBy=timers.target
EOF
  cat > "$dir/$APP-sync.service" << EOF
[Unit]
Description=hebi8 market dev instance: copy the live owner's vault

[Service]
Type=oneshot
$priority
MemoryHigh=3G
ExecStart=$ROOT/bin/hebi8-dev.sh unit-sync
# a failed copy is tried again half an hour later
Restart=on-failure
RestartSec=30min
EOF
  cat > "$dir/$APP-sync.timer" << EOF
[Unit]
Description=hebi8 market dev instance: daily copy of the live owner's vault

[Timer]
OnCalendar=*-*-* $SYNC_AT:00 $SYNC_TZ
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$APP.service" && systemctl --user enable --now "$APP-poll.timer" "$APP-sync.timer"
}

mkdir -p "$ROOT"/{logs,run,state,tmp,data,datasets,secrets}
chmod 700 "$ROOT/secrets"

case ${1:-} in
  unit-app)
    cd "$ROOT/current" || exit 1
    app_env
    exec node_modules/.bin/next start -H "$HOST" -p "$PORT"
    ;;
  unit-poll) locked poll ;;
  unit-sync) locked do_sync ;;
  status) status ;;
  update)
    if [[ ${2:-} == --force ]]; then echo force > "$ROOT/state/update"; else : > "$ROOT/state/update"; fi
    update_now
    ;;
  sync) job "$APP-sync.service" ;;
  branch)
    [[ -n ${2:-} ]] || { echo "usage: hebi8-dev.sh branch <name>"; exit 2; }
    touch "$ROOT/config.env"
    if grep -q '^BRANCH=' "$ROOT/config.env"; then sed -i "s|^BRANCH=.*|BRANCH=$2|" "$ROOT/config.env"; else echo "BRANCH=$2" >> "$ROOT/config.env"; fi
    echo "branch set to $2"
    : > "$ROOT/state/update"
    update_now
    ;;
  install)
    src=${2:?usage: hebi8-dev.sh install <scripts/dev-instance dir>}
    mkdir -p "$ROOT/bin"
    # a new file, not the old one rewritten: bash may be reading this very script as it runs
    for f in hebi8-dev.sh export.mjs prepare-vault.mjs; do
      cp "$src/$f" "$ROOT/bin/.$f.new" && chmod +x "$ROOT/bin/.$f.new" && mv "$ROOT/bin/.$f.new" "$ROOT/bin/$f" || exit 1
    done
    echo "installed into $ROOT/bin"
    # the units as the new script writes them
    exec "$ROOT/bin/hebi8-dev.sh" units
    ;;
  units)
    write_units
    echo "units: $APP, $APP-poll.timer, $APP-sync.timer"
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
