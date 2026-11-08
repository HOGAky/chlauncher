#!/usr/bin/env bash
# Safe SQLite backup for the chlauncher server database.
#
# Uses the SQLite `.backup` API — a plain `cp` of a WAL-mode database
# while the server is writing can produce a corrupted copy.
#
# Usage:   tools/backup-db.sh [DB_PATH] [BACKUP_DIR]
# Cron:    15 3 * * * /opt/chlauncher/tools/backup-db.sh >> /var/log/chlauncher-backup.log 2>&1
# Retention: keeps the newest 14 backups, deletes older ones.

set -euo pipefail

DB_PATH="${1:-/opt/chlauncher/apps/server/data/chlauncher.db}"
BACKUP_DIR="${2:-/opt/chlauncher/backups}"
KEEP=14

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F-%H%M)"
DEST="$BACKUP_DIR/chlauncher-$STAMP.db"

sqlite3 "$DB_PATH" ".backup '$DEST'"
gzip -f "$DEST"
echo "$(date -Is) backup ok: $DEST.gz ($(du -h "$DEST.gz" | cut -f1))"

# Retention: drop all but the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/chlauncher-*.db.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
