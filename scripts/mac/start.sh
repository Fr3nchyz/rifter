#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
ensure_docker
# After pulling an update, re-apply the app code and database changes once.
HEAD_NOW="$(git rev-parse HEAD 2>/dev/null)"
HEAD_SETUP="$(cat .local/last-setup-head 2>/dev/null)"
if [ -f .local/compose.env ] && [ "$HEAD_NOW" != "$HEAD_SETUP" ]; then
  echo "Installing the latest Rifter update (a few minutes)..."
  python3 scripts/app.py stop >/dev/null 2>&1
  if python3 scripts/setup.py --skip-catalog; then
    mkdir -p .local && echo "$HEAD_NOW" > .local/last-setup-head
  else
    echo "The update step failed. Send this window's text to Claude."
    pause_and_exit 1
  fi
fi
python3 scripts/app.py start || { echo "Rifter did not start. See .local/run/supervisor.log or send this window's text to Claude."; pause_and_exit 1; }
i=0
until python3 scripts/app.py status >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 450 ]; then
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
