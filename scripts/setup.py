#!/usr/bin/env python3
"""Prepare the private home-network app without overwriting existing secrets."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
UP = ROOT / 'upstream/openrift'
DOCKER = ['docker', '--host=unix:///var/run/docker.sock'] if Path('/var/run/docker.sock').exists() else ['docker']

def values(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#'))

def bun_command():
    found = shutil.which('bun')
    if found:
        return found
    local = ROOT / '.local/tools/node_modules/.bin/bun'
    if not local.exists():
        subprocess.run(['npm', 'install', '--prefix', str(ROOT / '.local/tools'), '--cache', str(ROOT / '.local/npm-cache'), 'bun@1.4.3', '--no-audit', '--no-fund'], check=True)
    return str(local)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', help='Home-network origin, e.g. http://192.168.1.50:5173')
    parser.add_argument('--skip-catalog', action='store_true', help='Keep an existing catalog without refreshing it')
    args = parser.parse_args()
    if args.origin:
        origin = urlsplit(args.origin)
        if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
            parser.error('--origin must be a plain app origin, without credentials or a path')
    subprocess.run(['git', 'submodule', 'update', '--init', '--recursive'], cwd=ROOT, check=True)
    local = ROOT / '.local'
    local.mkdir(exist_ok=True)
    env_path = UP / '.env'
    if not env_path.exists():
        content = {'APP_ENV': 'development', 'DATABASE_URL': 'postgres://openrift:' + secrets.token_hex(24) + '@localhost:5432/openrift',
                   'BETTER_AUTH_SECRET': secrets.token_hex(32), 'BETTER_AUTH_URL': args.origin or 'http://localhost:5173',
                   'CORS_ORIGIN': args.origin or 'http://localhost:5173', 'CATALOG_SOURCE_URL': 'https://openrift.app',
                   'SMTP_HOST': '127.0.0.1', 'SMTP_PORT': '1025', 'SMTP_SECURE': 'false', 'SMTP_FROM': 'Rifter <hello@rifter.local>'}
        with env_path.open('x') as file:
            file.write(''.join(f'{key}={value}\n' for key, value in content.items()))
        env_path.chmod(0o600)
    content = values(env_path)
    db_url = urlsplit(content['DATABASE_URL'])
    if db_url.hostname not in ('localhost', '127.0.0.1') or db_url.path != '/openrift' or db_url.username != 'openrift':
        raise SystemExit('Existing DATABASE_URL is not the managed local openrift database; refusing automatic setup')
    if args.origin:
        content['BETTER_AUTH_URL'] = args.origin.rstrip('/')
        content['CORS_ORIGIN'] = args.origin.rstrip('/')
        env_path.write_text(''.join(f'{key}={value}\n' for key, value in content.items()))
    compose_env = local / 'compose.env'
    compose_env.write_text('POSTGRES_PASSWORD=' + (db_url.password or '') + '\n')
    compose_env.chmod(0o600)
    subprocess.run(DOCKER + ['volume', 'create', 'rifter-postgres'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(DOCKER + ['compose', '--env-file', str(compose_env), '-f', str(ROOT / 'compose.rifter.yml'), 'up', '-d', 'db', 'mail'], check=True)
    for attempt in range(60):
        if subprocess.run(DOCKER + ['exec', 'rifter-db', 'pg_isready', '-U', 'openrift', '-d', 'openrift'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(1)
    else:
        raise SystemExit('PostgreSQL did not become ready')
    bun = bun_command()
    if subprocess.check_output([bun, '--version'], text=True).strip() != '1.4.3':
        raise SystemExit('OpenRift pins Bun 1.4.3; install that version before setup')
    env = dict(os.environ, CI='1', NODE_USE_ENV_PROXY='1', BUN_INSTALL_CACHE_DIR=str(local / 'bun-cache'))
    env['PATH'] = str(Path(bun).parent) + os.pathsep + env.get('PATH', '')
    subprocess.run(['python3', str(ROOT / 'scripts/apply-openrift.py')], check=True)
    subprocess.run([bun, 'install', '--frozen-lockfile'], cwd=UP, env=env, check=True)
    subprocess.run([bun, '--env-file=.env', 'scripts/run-migrations.ts'], cwd=UP, env=env, check=True)
    with (ROOT / 'integrations/openrift/schema.sql').open('rb') as sql:
        subprocess.run(DOCKER + ['exec', '-i', 'rifter-db', 'psql', '-U', 'openrift', '-d', 'openrift', '-v', 'ON_ERROR_STOP=1'], stdin=sql, check=True)
    if not args.skip_catalog:
        subprocess.run([bun, '--env-file=.env', 'apps/api/src/modules/rifter/sync-catalog.ts'], cwd=UP, env=env, check=True)
    subprocess.run([bun, 'run', 'paraglide:compile'], cwd=UP / 'apps/web', env=env, check=True)
    from build import ensure_build
    ensure_build()
    print('Setup complete. Start with python3 scripts/app.py start; check readiness with python3 scripts/app.py status. Open the configured app address, not an HTML file. Verification emails are captured by local Mailpit.')
    print('Configured app address on this machine: ' + content['BETTER_AUTH_URL'])

if __name__ == '__main__':
    main()
