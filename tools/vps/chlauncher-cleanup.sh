#!/usr/bin/env bash
# chlauncher cleanup — removes the junk that slowly kills a small VPS.
#
# Runs daily via systemd timer (or from the watchdog on disk pressure).
# Safe to run while services are up: everything here is either idempotent
# or an online SQLite operation.
#
#   1. SQLite: WAL checkpoint (TRUNCATE) + PRAGMA optimize — online, no lock.
#   2. Stale upload/temp files under the static dir (*.part/*.tmp > 1d).
#   3. journald logs older than 14 days            (needs root/sudo)
#   4. apt package cache                          (needs root/sudo)
#   5. Core dumps and old crash artifacts.
#
# Env overrides:
#   APP_DIR      install root      (default /opt/chlauncher)
#   DB_PATH      sqlite database   (default $APP_DIR/apps/server/data/chlauncher.db)
#   STATIC_DIR   uploads/builds    (default $APP_DIR/apps/server/static)
#   JOURNAL_DAYS retention for journald (default 14)

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/chlauncher}"
DB_PATH="${DB_PATH:-$APP_DIR/apps/server/data/chlauncher.db}"
STATIC_DIR="${STATIC_DIR:-$APP_DIR/apps/server/static}"
JOURNAL_DAYS="${JOURNAL_DAYS:-14}"
LOG_TAG="chlauncher-cleanup"

log() { echo "$(date -Is) [$LOG_TAG] $*"; }
IS_ROOT=0; [ "$(id -u)" = "0" ] && IS_ROOT=1

freed_before="$(df -Pm / | awk 'NR==2 {print $4}')"

# --- 1. SQLite housekeeping ---------------------------------------------
if [ -f "$DB_PATH" ] && command -v sqlite3 >/dev/null; then
  # WAL files can balloon on busy days; checkpoint folds them back and
  # truncates. `optimize` updates planner stats — cheap and online.
  sqlite3 "$DB_PATH" 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;' \
    && log "sqlite: WAL checkpointed + optimized" \
    || log "sqlite: checkpoint failed (db busy?)"
fi

# --- 2. stale upload/temp artifacts --------------------------------------
if [ -d "$STATIC_DIR" ]; then
  removed=$(find "$STATIC_DIR" -type f \( -name '*.part' -o -name '*.tmp' \) -mtime +1 -print -delete 2>/dev/null | wc -l)
  [ "$removed" -gt 0 ] && log "removed $removed stale upload temp files"
fi
if [ -d "$APP_DIR/apps/server/data" ]; then
  removed=$(find "$APP_DIR/apps/server/data" -type f -name '*.tmp' -mtime +1 -print -delete 2>/dev/null | wc -l)
  [ "$removed" -gt 0 ] && log "removed $removed stale data temp files"
fi

# --- 3. journald retention ------------------------------------------------
if [ "$IS_ROOT" = "1" ]; then
  journalctl --vacuum-time="${JOURNAL_DAYS}d" >/dev/null 2>&1 \
    && log "journald vacuumed to ${JOURNAL_DAYS}d" \
    || true
fi

# --- 4. apt cache ----------------------------------------------------------
if [ "$IS_ROOT" = "1" ] && command -v apt-get >/dev/null; then
  apt-get clean -y >/dev/null 2>&1 && log "apt cache cleaned" || true
fi

# --- 5. core dumps & crash leftovers ---------------------------------------
find /var/crash /var/lib/apport/coredump "$APP_DIR" \
  -type f \( -name 'core.*' -o -name '*.core' -o -name 'heapdump-*.heapsnapshot' \) \
  -mtime +3 -print -delete 2>/dev/null | while read -r f; do log "removed $f"; done

freed_after="$(df -Pm / | awk 'NR==2 {print $4}')"
log "done — free space: ${freed_before}MB → ${freed_after}MB"
exit 0
