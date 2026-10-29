# Shared helpers for the double-click launchers. Works with macOS's bash 3.2.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

pause_and_exit() {
  echo
  read -r -p "Press Return to close this window." _
  exit "${1:-1}"
}

need_devtools() {
  # On stock macOS, git and python3 are stubs until the developer tools are installed.
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "macOS needs its developer tools first. A window will offer to install them."
    echo "Click Install, wait until it finishes, then double-click this launcher again."
    xcode-select --install >/dev/null 2>&1
    pause_and_exit 1
  fi
}

need_tool() {
  # $1 = command, $2 = help text
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing: $1"
    echo "$2"
    pause_and_exit 1
  fi
}

ensure_docker() {
  if [ ! -d "/Applications/Docker.app" ] && ! command -v docker >/dev/null 2>&1; then
    echo "Docker Desktop is not installed."
    echo "Opening the download page. Install it, open it once, then run this launcher again."
    open "https://www.docker.com/products/docker-desktop/"
    pause_and_exit 1
  fi
  if docker info >/dev/null 2>&1; then return 0; fi
  echo "Starting Docker Desktop (this can take a minute)..."
  open -a Docker
  i=0
  while ! docker info >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 90 ]; then
      echo "Docker did not start in time. Open Docker Desktop yourself, wait until it says it is running, then try again."
      pause_and_exit 1
    fi
    sleep 2
  done
  echo "Docker is running."
}

app_address() {
  grep '^BETTER_AUTH_URL=' upstream/openrift/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'"
}
