#!/usr/bin/env bash
# The dev instance on memoh-codex: follows a branch (dev), takes the live owner's vault once a day.
# Everything lives under $HEBI8_DEV_ROOT (default /data/hebi8-dev, the disk that survives a reset of
# the system layer); there is no systemd, so `daemon` is the watchdog: it keeps `next start` running,
# checks the branch every UPDATE_EVERY seconds and runs the daily sync. /data/services/start.sh runs
# `hebi8-dev.sh start` at boot. See docs/maintainers.md §dev 实例.
#
# Usage: hebi8-dev.sh start | stop | status | update [--force] | sync | restart | branch <name> | install <dir> | daemon
#
# Each release is a git worktree in releases/<sha>, built while the old one keeps serving; `current`
# points at the one that runs. A commit that fails to build or to answer 200 is remembered in
# state/failed and not tried again until the branch moves (or `update --force`).
set -uo pipefail

ROOT=${HEBI8_DEV_ROOT:-/data/hebi8-dev}
export PATH="/opt/memoh/toolkit/node-glibc/bin:$HOME/.local/bin:$PATH"

# defaults; config.env overrides them
BRANCH=master                  # a branch of origin, or any ref or commit the clone has
HOST=100.107.245.93            # memoh-codex's Tailscale IP: tailnet only, no public entrance
PORT=8809
UPDATE_EVERY=600               # seconds between fetches
SYNC_AT=04:30                  # daily copy from the live instance, SYNC_TZ clock; off the live 07:30 / 17:30 syncs
SYNC_TZ=Asia/Tokyo
LIVE_MACHINE=homeN100          # reached with `lody-lan lan shell`
LIVE_DIR='~/dev/hebi8-market'
LIVE_NODE='~/.local/share/hebi8/node/bin/node' # the live service's node: its better-sqlite3 is built for it
KEEP=3                         # releases kept on disk, the running one included
# shellcheck source=/dev/null
[[ -f $ROOT/config.env ]] && source "$ROOT/config.env"

URL="http://$HOST:$PORT/"
LOG=$ROOT/logs/daemon.log

# to the log, and to the terminal unless this is the daemon (whose stderr is logs/daemon.out)
log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"
  [[ -n ${DAEMON:-} ]] || echo "$*" >&2
}

# The environment `next start` and `next build` get. The secrets directory is the dev instance's own
# and starts empty: no notification channel, so alerts are judged but never sent.
app_env() {
  export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
  export HEBI8_VAULT=$ROOT/vault HEBI8_DB=$ROOT/data/hebi8.db HEBI8_SECRETS=$ROOT/secrets
  export HEBI8_PUBLIC_URL=${URL%/}
}

app_pid() {
  local pid
  pid=$(cat "$ROOT/run/app.pid" 2>/dev/null) || return 1
  # a zombie's cmdline is empty (nothing reaps orphans on this machine)
  [[ -n $pid && -r /proc/$pid/cmdline ]] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q next && echo "$pid"
}

start_app() {
  [[ -L $ROOT/current ]] || { log "no release yet"; return 1; }
  if app_pid > /dev/null; then return 0; fi
  # one old log is enough
  if [[ $(stat -c %s "$ROOT/logs/app.log" 2>/dev/null || echo 0) -gt 20000000 ]]; then mv "$ROOT/logs/app.log" "$ROOT/logs/app.log.1"; fi
  (
    app_env
    cd "$ROOT/current" || exit 1
    # its own session, so stop_app can signal the whole group; the ops lock (fd 8) stays here
    exec setsid node_modules/.bin/next start -H "$HOST" -p "$PORT" >> "$ROOT/logs/app.log" 2>&1 < /dev/null 8>&- 9>&-
  ) &
  echo $! > "$ROOT/run/app.pid"
  date +%s > "$ROOT/run/app.started"
  log "app started (pid $!, $(commit_of current))"
}

stop_app() {
  local pid i
  pid=$(app_pid) || { rm -f "$ROOT/run/app.pid"; return 0; }
  kill -TERM -- "-$pid" 2> /dev/null || kill -TERM "$pid"
  for i in {1..20}; do
    app_pid > /dev/null || break
    sleep 0.5
  done
  if app_pid > /dev/null; then kill -KILL -- "-$pid" 2> /dev/null || kill -KILL "$pid"; fi
  rm -f "$ROOT/run/app.pid"
  log "app stopped (pid $pid)"
}

restart_app() {
  stop_app
  start_app && healthy
}

healthy() {
  local i
  for i in {1..60}; do
    [[ $(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL") == 200 ]] && return 0
    app_pid > /dev/null || return 1
    sleep 1
  done
  return 1
}

commit_of() { basename "$(readlink -f "$ROOT/$1" 2> /dev/null)" | cut -c1-7; }

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
    # better-sqlite3 compiles from source; apt packages go with a reset of the system layer
    command -v g++ > /dev/null || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends build-essential >> "$cilog" 2>&1
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
  date +%s > "$ROOT/state/checked"
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
  stop_app
  switch_to "$target"
  start_app
  if healthy; then
    rm -f "$ROOT/state/failed"
    log "running ${target:0:7}"
    prune_releases
    return 0
  fi
  echo "$target" > "$ROOT/state/failed"
  log "${target:0:7} did not answer 200; back to ${prev:0:7} (logs/app.log)"
  stop_app
  if [[ -n $prev && -d $ROOT/releases/$prev ]]; then
    switch_to "$prev"
    start_app
    healthy || log "${prev:0:7} does not answer either; the dev instance needs a look"
    drop_release "$target"
  fi
  return 1
}

# The epoch of the latest SYNC_AT that has passed.
sync_moment() {
  local today
  today=$(TZ=$SYNC_TZ date -d "today $SYNC_AT" +%s)
  if (($(date +%s) >= today)); then echo "$today"; else TZ=$SYNC_TZ date -d "yesterday $SYNC_AT" +%s; fi
}

# Pulls the live owner's vault, a cache snapshot and the local datasets (export.mjs runs there) and
# swaps them in. One way only: what was changed on the dev instance is gone afterwards.
do_sync() {
  local tmp script cmd
  date +%s > "$ROOT/state/sync-tried"
  [[ -L $ROOT/current ]] || { log "sync: no release yet"; return 1; }
  tmp=$(mktemp -d "$ROOT/tmp/sync.XXXXXX")
  script=$(base64 -w0 "$ROOT/bin/export.mjs")
  # the script travels in the command line: stdin of `lan shell` is not a clean channel
  cmd="f=\$(mktemp /tmp/hebi8-dev-export.XXXXXX.mjs) && echo $script | base64 -d > \$f && cd $LIVE_DIR && $LIVE_NODE \$f; s=\$?; rm -f \$f; exit \$s"
  log "sync: exporting from $LIVE_MACHINE"
  if ! lody-lan lan shell "$LIVE_MACHINE" -- "$cmd" < /dev/null > "$tmp/raw" 2> "$tmp/err"; then
    log "sync: export failed: $(tail -c 300 "$tmp/err" "$tmp/raw" | tr '\n' ' ')"
    rm -rf "$tmp"
    return 1
  fi
  mkdir -p "$tmp/new"
  if ! tr -d '\r' < "$tmp/raw" | sed -n '/^HEBI8-DEV-EXPORT-BEGIN$/,/^HEBI8-DEV-EXPORT-END$/{/^HEBI8-DEV-EXPORT/d;p}' | base64 -d | tar xz -C "$tmp/new" \
    || [[ ! -f $tmp/new/vault/hebi8.yaml || ! -f $tmp/new/hebi8.db ]]; then
    log "sync: the export did not come through whole"
    rm -rf "$tmp"
    return 1
  fi
  mkdir -p "$tmp/new/datasets"
  node "$ROOT/bin/prepare-vault.mjs" "$ROOT/current" "$tmp/new/vault/hebi8.yaml" "$tmp/new/datasets" "$ROOT/datasets" || { log "sync: prepare-vault failed"; rm -rf "$tmp"; return 1; }

  stop_app
  rm -rf "$ROOT/vault.old" "$ROOT/datasets.old"
  [[ -d $ROOT/vault ]] && mv "$ROOT/vault" "$ROOT/vault.old"
  [[ -d $ROOT/datasets ]] && mv "$ROOT/datasets" "$ROOT/datasets.old"
  mv "$tmp/new/vault" "$ROOT/vault"
  mv "$tmp/new/datasets" "$ROOT/datasets"
  rm -f "$ROOT/data/hebi8.db" "$ROOT/data/hebi8.db-wal" "$ROOT/data/hebi8.db-shm"
  mv "$tmp/new/hebi8.db" "$ROOT/data/hebi8.db"
  rm -rf "$ROOT/vault.old" "$ROOT/datasets.old"
  start_app
  healthy || log "sync: the app does not answer 200 after the swap (logs/app.log)"
  date +%s > "$ROOT/state/synced"
  log "sync: done ($(tr -d '\n ' < "$tmp/new/export.json" | cut -c1-200))"
  rm -rf "$tmp"
}

# One round of the watchdog; holds the ops lock.
tick() {
  local now last
  now=$(date +%s)
  if ! app_pid > /dev/null && [[ -L $ROOT/current ]]; then
    last=$(cat "$ROOT/run/app.started" 2> /dev/null || echo 0)
    if ((now - last >= 30)); then
      [[ -f $ROOT/run/app.pid ]] && log "app is not running; starting it"
      start_app
    fi
  fi
  last=$(cat "$ROOT/state/checked" 2> /dev/null || echo 0)
  ((now - last >= UPDATE_EVERY)) && do_update
  last=$(cat "$ROOT/state/synced" 2> /dev/null || echo 0)
  if ((last < $(sync_moment))); then
    # a failed sync waits half an hour before the next try
    ((now - $(cat "$ROOT/state/sync-tried" 2> /dev/null || echo 0) >= 1800)) && do_sync
  fi
  return 0
}

locked() { # locked <wait|nowait> <command...>
  local mode=$1
  shift
  (
    if [[ $mode == wait ]]; then flock 8; else flock -n 8 || exit 0; fi
    "$@"
  ) 8> "$ROOT/run/ops.lock"
}

daemon_pid() {
  local pid
  pid=$(cat "$ROOT/run/daemon.pid" 2> /dev/null) || return 1
  [[ -n $pid && -r /proc/$pid/cmdline ]] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "hebi8-dev.sh daemon" && echo "$pid"
}

daemon() {
  DAEMON=1
  echo $$ > "$ROOT/run/daemon.pid"
  log "daemon started (pid $$, branch $BRANCH, $URL)"
  trap 'log "daemon stopped"; exit 0' TERM INT
  while :; do
    # re-read config.env so `branch` takes effect without a restart
    [[ -f $ROOT/config.env ]] && source "$ROOT/config.env"
    locked nowait tick
    sleep 15 &
    wait $!
  done
}

status() {
  local pid
  echo "url:      $URL"
  echo "branch:   $BRANCH -> $(git -C "$ROOT/repo" rev-parse --short "$(target_commit 2> /dev/null)" 2> /dev/null || echo '?')"
  echo "running:  $(git -C "$ROOT/current" log -1 --format='%h %s' 2> /dev/null || echo none)"
  echo "app:      $(pid=$(app_pid) && echo "pid $pid, HTTP $(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL")" || echo 'not running')"
  echo "daemon:   $(daemon_pid || echo 'not running')"
  echo "checked:  $(date -d "@$(cat "$ROOT/state/checked" 2> /dev/null || echo 0)" '+%F %T %Z')"
  echo "synced:   $(date -d "@$(cat "$ROOT/state/synced" 2> /dev/null || echo 0)" '+%F %T %Z'), next at $SYNC_AT $SYNC_TZ"
  [[ -f $ROOT/state/failed ]] && echo "failed:   $(cut -c1-7 "$ROOT/state/failed") (not retried until $BRANCH moves)"
  return 0
}

mkdir -p "$ROOT"/{logs,run,state,tmp,data,datasets,secrets}
chmod 700 "$ROOT/secrets"

case ${1:-} in
  daemon) daemon ;;
  start)
    if pid=$(daemon_pid); then echo "daemon already running (pid $pid)"; exit 0; fi
    setsid -f bash "$ROOT/bin/hebi8-dev.sh" daemon >> "$ROOT/logs/daemon.out" 2>&1 < /dev/null 8>&- 9>&-
    echo "daemon started"
    ;;
  stop)
    if pid=$(daemon_pid); then kill "$pid"; fi
    locked wait stop_app
    ;;
  status) status ;;
  update) locked wait do_update "${2:-}" ;;
  sync) locked wait do_sync ;;
  restart) locked wait restart_app ;;
  branch)
    [[ -n ${2:-} ]] || { echo "usage: hebi8-dev.sh branch <name>"; exit 2; }
    touch "$ROOT/config.env"
    if grep -q '^BRANCH=' "$ROOT/config.env"; then sed -i "s|^BRANCH=.*|BRANCH=$2|" "$ROOT/config.env"; else echo "BRANCH=$2" >> "$ROOT/config.env"; fi
    BRANCH=$2
    log "branch set to $2"
    locked wait do_update
    ;;
  install)
    src=${2:?usage: hebi8-dev.sh install <scripts/dev-instance dir>}
    mkdir -p "$ROOT/bin"
    # a new file, not the old one rewritten: bash is reading this very script as it runs
    for f in hebi8-dev.sh export.mjs prepare-vault.mjs; do
      cp "$src/$f" "$ROOT/bin/.$f.new" && chmod +x "$ROOT/bin/.$f.new" && mv "$ROOT/bin/.$f.new" "$ROOT/bin/$f" || exit 1
    done
    echo "installed into $ROOT/bin; restart the daemon (stop, start) to use the new hebi8-dev.sh"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
