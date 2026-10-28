#!/usr/bin/env python3
"""Run isolated PostgreSQL integration tests; never reset the personal database."""
from pathlib import Path
import os
import subprocess
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
UP = ROOT / 'upstream/openrift'

def main():
    values = dict(line.split('=', 1) for line in (UP / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
    uri = urlsplit(values['DATABASE_URL'])
    if uri.hostname not in ('localhost', '127.0.0.1'):
        raise SystemExit('Tests require local PostgreSQL')
    test_url = urlunsplit(uri._replace(path='/rifter_test'))
    docker = ['docker', '--host=unix:///var/run/docker.sock', 'exec', '-i', 'rifter-db']
    # This fixed, dedicated database is disposable. Never derive its name from
    # the configured personal database, and never run DROP against that URL.
    if uri.path == '/rifter_test':
        raise SystemExit('Personal DATABASE_URL must not point to the disposable test database')
    subprocess.run(docker + ['dropdb', '-U', 'openrift', '--if-exists', '--force', 'rifter_test'], check=True)
    subprocess.run(docker + ['createdb', '-U', 'openrift', 'rifter_test'], check=True)
    env = dict(os.environ, DATABASE_URL=test_url, RIFTER_TEST_DATABASE_URL=test_url)
    subprocess.run(['python3', str(ROOT / 'scripts/apply-openrift.py')], check=True)
    subprocess.run(['bun', '--env-file=.env', 'scripts/run-migrations.ts'], cwd=UP, env=env, check=True, stdout=subprocess.DEVNULL)
    with (ROOT / 'integrations/openrift/schema.sql').open('rb') as sql:
        subprocess.run(docker + ['psql', '-U', 'openrift', '-d', 'rifter_test', '-v', 'ON_ERROR_STOP=1'], stdin=sql, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['bun', 'test', './apps/api/src/modules/rifter/service.rifter-test.ts'], cwd=UP, env=env, check=True)

if __name__ == '__main__':
    main()
