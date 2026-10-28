#!/usr/bin/env python3
"""Start Rifter in the background, report its health, or stop its app servers."""
import argparse
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / '.local/run'


def configured_origin():
    try:
        for line in (ROOT / 'upstream/openrift/.env').read_text().splitlines():
            if line.startswith('BETTER_AUTH_URL='):
                return line.split('=', 1)[1].strip().strip('"\'')
    except OSError:
        pass
    return None


def process_identity(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()
        if stat[0] == 'Z':
            return None
        command = Path(f'/proc/{pid}/cmdline').read_bytes().decode().split('\0')
        return stat[19], command
    except FileNotFoundError:
        # macOS has no /proc; start time still protects against PID reuse.
        started = subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='], text=True).strip()
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True).strip()
        return (started, shlex.split(command)) if started else None


def supervisor():
    try:
        record = json.loads((RUN / 'supervisor.json').read_text())
        pid = record['pid']
        if not isinstance(pid, int) or pid <= 1:
            return None
        identity = process_identity(pid)
        if not identity or identity[0] != record['started']:
            return None
        if not any(arg in ('scripts/start.py', str(ROOT / 'scripts/start.py')) for arg in identity[1]):
            return None
        return pid
    except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.CalledProcessError):
        return None


def health():
    checks = {}
    for name, url in [('API', 'http://127.0.0.1:3000/api/v1/catalog'),
                      ('app', 'http://127.0.0.1:5173/login')]:
        try:
            # Local health checks should not depend on outbound proxy settings.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(url, timeout=3) as response:
                checks[name] = response.status == 200
        except (OSError, urllib.error.URLError):
            checks[name] = False
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'status', 'stop'])
    args = parser.parse_args()
    pid = supervisor()
    if args.command == 'status':
        checks = health()
        print('Supervisor: ' + ('running' if pid else 'stopped'))
        for name, ready in checks.items():
            print(f'{name}: ' + ('ready' if ready else 'unavailable'))
        if all(checks.values()) and configured_origin():
            print('App address on this machine: ' + configured_origin())
            print('Open that address in a browser and sign in; do not open an HTML file.')
        return 0 if pid and all(checks.values()) else 1
    if args.command == 'stop':
        if not pid:
            print('No managed Rifter supervisor is running.')
            return 0
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if not supervisor():
                print('App servers stopped. Collection data and database are preserved.')
                return 0
            time.sleep(0.2)
        print('Shutdown has not finished. Inspect .local/run/supervisor.log.', file=sys.stderr)
        return 1
    if pid:
        print('Rifter is already running. Use scripts/app.py status to check health.')
        return 0 if all(health().values()) else 1
    RUN.mkdir(parents=True, exist_ok=True)
    with (RUN / 'supervisor.log').open('a') as log:
        os.chmod(log.name, 0o600)
        process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/start.py')],
                                   cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
    # A frontend rebuild can take minutes; report progress instead of blocking.
    for _ in range(40):
        if process.poll() is not None:
            print('Startup failed. Inspect .local/run/supervisor.log.', file=sys.stderr)
            return 1
        if supervisor() == process.pid and all(health().values()):
            print('Rifter is ready. Open your configured app origin; use scripts/app.py status to check it.')
            return 0
        time.sleep(0.5)
    print('Rifter is starting in the background. Run scripts/app.py status; logs: .local/run/supervisor.log.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
