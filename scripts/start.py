#!/usr/bin/env python3
"""Start OpenRift and the integrated Rifter workspace; Ctrl-C stops both servers."""
import os
import fcntl
import argparse
import atexit
import json
import signal
import subprocess
import time
import urllib.request
from app import process_identity
from setup import ROOT, UP, DOCKER, bun_command

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dev',action='store_true',help='Use hot-reloading Vite instead of the normal bundled app')
    args=parser.parse_args()
    run = ROOT / '.local/run'
    run.mkdir(parents=True, exist_ok=True)
    lock = (run / 'start.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Rifter is already running. Stop its supervisor before starting another.')
    # The controller verifies process start time before signalling this PID.
    # A stale record must never allow an unrelated reused PID to be stopped.
    record = run / 'supervisor.json'
    identity = {'pid': os.getpid(), 'started': process_identity(os.getpid())[0]}
    record.write_text(json.dumps(identity))
    record.chmod(0o600)
    def remove_record():
        try:
            if json.loads(record.read_text()) == identity:
                record.unlink()
        except (OSError, ValueError):
            pass
    atexit.register(remove_record)
    def stop(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    compose_env = ROOT / '.local/compose.env'
    if not compose_env.exists():
        raise SystemExit('Run python3 scripts/setup.py first')
    subprocess.run(DOCKER + ['compose', '--env-file', str(compose_env), '-f', str(ROOT / 'compose.rifter.yml'), 'up', '-d', 'db', 'mail'], check=True)
    bun = bun_command()
    if not args.dev:
        from build import ensure_build
        ensure_build()
    env = dict(os.environ, NODE_USE_ENV_PROXY='1', RIFTER_ROOT=str(ROOT))
    env['PATH'] = str(os.path.dirname(bun)) + os.pathsep + env.get('PATH', '')
    children = []
    try:
        processes=[('api',[bun,'--env-file=.env','apps/api/src/index.ts'],{'PORT':'3000'})]
        if args.dev:
            processes.append(('web',[bun,'--env-file=.env','run','dev:web'],{'PORT':'5173','API_INTERNAL_URL':'http://localhost:3000','VITE_API_PROXY_TARGET':'http://localhost:3000'}))
        else:
            processes.extend([('web',[bun,'--env-file=.env','apps/web/.output/server/index.mjs'],{'PORT':'5174','HOST':'127.0.0.1','API_INTERNAL_URL':'http://localhost:3000'}),('proxy',[bun,'--env-file=.env','apps/api/src/modules/rifter/local-proxy.ts'],{})])
        for name, command, extra in processes:
            path = run / (name + '.log')
            log = path.open('a')
            path.chmod(0o600)
            children.append(subprocess.Popen(command, cwd=UP, env=dict(env, **extra), stdout=log, stderr=subprocess.STDOUT, start_new_session=True))
            log.close()
        for attempt in range(90):
            if any(p.poll() is not None for p in children):
                raise SystemExit('A server exited. Inspect .local/run/api.log and web.log.')
            try:
                with urllib.request.urlopen('http://localhost:3000/api/v1/catalog', timeout=2) as response:
                    api_ready = response.status == 200
                with urllib.request.urlopen('http://localhost:5173/login', timeout=5) as response:
                    if api_ready and response.status == 200:
                        break
            except OSError:
                time.sleep(1)
        else:
            raise SystemExit('API readiness timed out; inspect .local/run/')
        print('Rifter is running. Open the configured app origin and choose Rifter from the navigation. Logs: .local/run/. Ctrl-C stops app servers; database remains persistent.', flush=True)
        while all(p.poll() is None for p in children):
            time.sleep(1)
        raise SystemExit('A server stopped unexpectedly. Inspect .local/run/ before restarting the app.')
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)

if __name__ == '__main__':
    main()
