#!/usr/bin/env bash
# chlauncher watchdog — keeps the API server and the TG bind-bot alive
# without human babysitting.
#
# What it does every run (systemd timer, default: each minute):
#   1. GET /api/ready with a hard timeout; after 3 consecutive failures
#      it restarts chlauncher-server and alerts the owner.
#   2. Resurrects units stuck in `failed` state (systemd gives up after
#      Restart= burst limits — the watchdog does `reset-failed` + start).
#   3. Watches disk usage; at >=85% runs the cleanup script once per day.
#   4. Optionally reports actions to the owner via a Telegram message.
#
# Config (all optional, env or /opt/chlauncher/tools/vps/watchdog.env):
#   API_URL           readiness endpoint   (default http://127.0.0.1:8787)
#   SERVER_UNIT       systemd unit name    (default chlauncher-server)
#   BOT_UNIT          systemd unit name    (default chlauncher-tgbot)
#   CLEANUP_SCRIPT    cleanup helper       (default …/chlauncher-cleanup.sh)
#   DISK_PCT          disk % that triggers cleanup + alert (default 85)
#   TG_ALERT_TOKEN    bot token for alerts (reuse TG_BOT_TOKEN is fine)
#   TG_ALERT_CHAT_ID  chat id to alert     (your /whoami id)
#
# Install: tools/vps/install.sh wires this as a systemd timer.

set -uo pipefail

API_URL="${API_URL:-http://127.0.0.1:8787}"
SERVER_UNIT="${SERVER_UNIT:-chlauncher-server}"
BOT_UNIT="${BOT_UNIT:-chlauncher-tgbot}"
ADMIN_BOT_UNIT="${ADMIN_BOT_UNIT:-chlauncher-tgadmin}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP_SCRIPT="${CLEANUP_SCRIPT:-$SELF_DIR/chlauncher-cleanup.sh}"
DISK_PCT="${DISK_PCT:-85}"
STATE_DIR="${STATE_DIR:-/var/lib/chlauncher}"
FAIL_FILE="$STATE_DIR/watchdog-fails"
LAST_CLEAN_FILE="$STATE_DIR/watchdog-last-cleanup"
LOG_TAG="chlauncher-watchdog"

log() { echo "$(date -Is) [$LOG_TAG] $*"; }

alert() {
  # Best-effort Telegram ping to the owner; silent when unconfigured.
  [ -n "${TG_ALERT_TOKEN:-}" ] && [ -n "${TG_ALERT_CHAT_ID:-}" ] || return 0
  curl -fsS -m 8 -o /dev/null -X POST \
    "https://api.telegram.org/bot${TG_ALERT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_ALERT_CHAT_ID}" \
    --data-urlencode "text=$1" \
    --data-urlencode "disable_web_page_preview=true" || true
}

restart_unit() {
  local unit="$1" reason="$2"
  log "restarting $unit ($reason)"
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemctl restart "$unit" || true
  alert "⚠️ chlauncher: перезапущен сервис $unit ($reason)"
}

mkdir -p "$STATE_DIR" 2>/dev/null || true

# --- 1. readiness probe -------------------------------------------------
if curl -fsS -m 8 -o /dev/null "$API_URL/api/ready"; then
  echo 0 > "$FAIL_FILE" 2>/dev/null || true
else
  fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$FAIL_FILE" 2>/dev/null || true
  log "readiness probe failed ($fails in a row)"
  if [ "$fails" -ge 3 ]; then
    restart_unit "$SERVER_UNIT" "readiness probe failed ${fails}x"
    echo 0 > "$FAIL_FILE" 2>/dev/null || true
  fi
fi

# --- 2. resurrect units stuck in `failed` --------------------------------
for unit in "$SERVER_UNIT" "$BOT_UNIT" "$ADMIN_BOT_UNIT"; do
  if systemctl is-failed --quiet "$unit" 2>/dev/null; then
    restart_unit "$unit" "unit was in failed state"
  elif ! systemctl is-active --quiet "$unit" 2>/dev/null; then
    # Unit exists but stopped (e.g. after a manual stop or failed boot) —
    # only revive when it is enabled, respecting deliberate masking.
    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      restart_unit "$unit" "enabled unit was inactive"
    fi
  fi
done

# --- 3. disk pressure → cleanup (at most once per 20h) --------------------
usage_pct="$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if [ -n "$usage_pct" ] && [ "$usage_pct" -ge "$DISK_PCT" ]; then
  last=$(cat "$LAST_CLEAN_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $((now - last)) -gt 72000 ]; then
    log "disk at ${usage_pct}% — running cleanup"
    date +%s > "$LAST_CLEAN_FILE" 2>/dev/null || true
    [ -x "$CLEANUP_SCRIPT" ] && "$CLEANUP_SCRIPT" || true
    alert "🧹 chlauncher: диск ${usage_pct}% — выполнена автоочистка"
  fi
fi

exit 0
