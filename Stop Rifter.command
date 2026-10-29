#!/bin/bash
source "$(dirname "$0")/scripts/mac/common.sh"
python3 scripts/app.py stop
if [ -f .local/compose.env ] && docker info >/dev/null 2>&1; then
  docker compose --env-file .local/compose.env -f compose.rifter.yml stop
fi
echo "Rifter is stopped. Your collection data is kept."
sleep 3
