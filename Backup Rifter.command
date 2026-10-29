#!/bin/bash
source "$(dirname "$0")/scripts/mac/common.sh"
ensure_docker
[ -f .local/compose.env ] && docker compose --env-file .local/compose.env -f compose.rifter.yml up -d db >/dev/null 2>&1 && sleep 5
if python3 scripts/backup.py create; then
  echo "Backup saved. Copy it somewhere safe (iCloud Drive or an external drive)."
  open .local/backups
else
  echo "Backup failed. Send this window's text to Claude."
  pause_and_exit 1
fi
sleep 3
