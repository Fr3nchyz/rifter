#!/bin/bash
# Run once. Installs what Rifter needs and starts it. Needs internet and about 10-20 minutes.
source "$(dirname "$0")/scripts/mac/common.sh"
need_devtools
need_tool git "macOS will offer to install the developer tools. Accept, wait for it to finish, then run this again."
need_tool python3 "macOS will offer to install the developer tools. Accept, wait for it to finish, then run this again."
ensure_docker
echo "Setting up Rifter. Leave this window open until it says it is finished."
if ! python3 scripts/setup.py; then
  echo
  echo "Setup stopped with an error. Copy the last lines above and send them to Claude."
  pause_and_exit 1
fi
mkdir -p .local && git rev-parse HEAD > .local/last-setup-head 2>/dev/null
bash "$ROOT/scripts/mac/start.sh"
