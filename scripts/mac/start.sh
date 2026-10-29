#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
ensure_docker
python3 scripts/app.py start
i=0
until python3 scripts/app.py status >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 150 ]; then
    echo "Still starting. Check .local/run/supervisor.log or send this window's text to Claude."
    pause_and_exit 1
  fi
  sleep 2
done
ADDR="$(app_address)"
[ -z "$ADDR" ] && ADDR="http://localhost:5173"
echo
echo "Rifter is running at $ADDR"
echo "Sign-up verification codes appear at http://localhost:8025 (a local mailbox on this Mac)."
open "$ADDR"
echo "You can close this window. Rifter keeps running until you use 'Stop Rifter'."
sleep 5
