#!/usr/bin/env bash
# chlauncher VPS automation installer — idempotent.
#
# Installs and enables:
#   chlauncher-server.service   — API server (Restart=always)
#   chlauncher-tgbot.service    — Telegram bind-bot (Restart=always)
#   chlauncher-watchdog.timer   — every minute: /api/ready probe,
#                                 failed-unit resurrection, disk watch
#   chlauncher-cleanup.timer    — daily: WAL checkpoint, stale uploads,
#                                 journald vacuum, apt cache, core dumps
#   chlauncher-backup.timer     — daily 03:15: sqlite .backup + rotation
#
# Usage (as root, on the VPS):
#   bash /opt/chlauncher/tools/vps/install.sh
#
# Re-running is safe: units are reinstalled and timers re-enabled.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/chlauncher}"
SRC="$APP_DIR/tools/vps"
UNIT_DIR=/etc/systemd/system

if [ "$(id -u)" != "0" ]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi
if [ ! -d "$SRC" ]; then
  echo "expected repo at $APP_DIR (APP_DIR override supported)" >&2
  exit 1
fi

chmod +x "$SRC/chlauncher-watchdog.sh" "$SRC/chlauncher-cleanup.sh" \
         "$APP_DIR/tools/backup-db.sh"

# State dir for the watchdog's fail counters.
install -d -m 0755 -o root "$([ -d /var/lib ] && echo /var/lib/chlauncher || echo /var/tmp/chlauncher)"

for u in \
  chlauncher-server.service \
  chlauncher-tgbot.service \
  chlauncher-tgadmin.service \
  chlauncher-watchdog.service \
  chlauncher-watchdog.timer \
  chlauncher-cleanup.service \
  chlauncher-cleanup.timer \
  chlauncher-backup.service \
  chlauncher-backup.timer
do
  install -m 0644 "$SRC/$u" "$UNIT_DIR/$u"
  echo "installed $u"
done

systemctl daemon-reload

systemctl enable --now chlauncher-server.service   || true
systemctl enable --now chlauncher-tgbot.service    || true
# Admin bot only starts when its env file exists (token + admin id).
if [ -f "$APP_DIR/apps/launcher/tg-admin-bot/.env" ]; then
  systemctl enable --now chlauncher-tgadmin.service || true
fi
systemctl enable --now chlauncher-watchdog.timer   || true
systemctl enable --now chlauncher-cleanup.timer    || true
systemctl enable --now chlauncher-backup.timer     || true

cat <<'EOF'

Done. Useful checks:

  systemctl list-timers 'chlauncher-*'        # all timers scheduled?
  journalctl -u chlauncher-server -f          # API logs
  journalctl -u chlauncher-tgbot -f           # bot logs
  /opt/chlauncher/tools/vps/chlauncher-watchdog.sh   # manual watchdog run
  /opt/chlauncher/tools/vps/chlauncher-cleanup.sh    # manual cleanup run

Owner alerts: copy tools/vps/watchdog.env.example → watchdog.env and set
TG_ALERT_TOKEN / TG_ALERT_CHAT_ID (bot /whoami shows your id).
EOF
