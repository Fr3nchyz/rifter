#!/bin/bash
source "$(dirname "$0")/scripts/mac/common.sh"
ensure_docker
if [ ! -f .local/compose.env ]; then
  echo "Rifter has not been set up yet. Run 'Set up Rifter' first."
  pause_and_exit 1
fi
docker compose --env-file .local/compose.env -f compose.rifter.yml up -d db
i=0
until docker exec rifter-db pg_isready -U openrift -d openrift >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "The database did not start. Send this window's text to Claude."; pause_and_exit 1; }
  sleep 1
done
if python3 scripts/backup.py create; then
  echo "Backup saved. Copy it somewhere safe (iCloud Drive or an external drive)."
  open .local/backups
else
  echo "Backup failed. Send this window's text to Claude."
  pause_and_exit 1
fi
sleep 3
