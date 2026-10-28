#!/usr/bin/env python3
"""Build and validate the web app's Vercel Build Output API artifact."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlsplit
from setup import ROOT, UP


def backend_origin(value):
    url = urlsplit(value or '')
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment
            or url.hostname in ('localhost', '127.0.0.1', '::1')):
        raise ValueError('API_INTERNAL_URL must be the hosted backend HTTPS origin, without credentials or a path')
    return value.rstrip('/')


def main():
    try:
        origin = backend_origin(os.environ.get('API_INTERNAL_URL'))
    except ValueError as error:
        raise SystemExit(str(error))
    bun = ROOT / '.local/tools/node_modules/.bin/bun'
    if not bun.exists():
        raise SystemExit('Run python3 scripts/install-vercel.py first')
    subprocess.run(['python3', str(ROOT / 'scripts/apply-openrift.py')], check=True)
    env = dict(os.environ, RIFTER_WEB_TARGET='vercel', API_INTERNAL_URL=origin)
    env['PATH'] = str(bun.parent) + os.pathsep + env.get('PATH', '')
    subprocess.run([str(bun), 'run', '--cwd', 'apps/web', 'build'], cwd=UP, env=env, check=True)
    source = UP / 'apps/web/.vercel/output'
    config = json.loads((source / 'config.json').read_text())
    if config.get('version') != 3:
        raise SystemExit('Unexpected Vercel Build Output API version')
    routes = config.get('routes', [])
    filesystem = next((i for i, route in enumerate(routes) if route.get('handle') == 'filesystem'), len(routes))
    for prefix in ('api', 'media'):
        matches = [(i, route) for i, route in enumerate(routes)
                   if route.get('dest', '').startswith(origin + '/' + prefix + '/')]
        if not matches or any(i >= filesystem for i, _ in matches):
            raise SystemExit(f'Missing or incorrectly ordered same-origin /{prefix} rewrite')
    if not list((source / 'functions').rglob('.vc-config.json')):
        raise SystemExit('No Vercel server function generated')
    output = ROOT / '.vercel/output'
    # Replace only generated output, preserving any Vercel project/account link.
    if output.exists():
        shutil.rmtree(output)
    output.parent.mkdir(exist_ok=True)
    shutil.copytree(source, output)
    print('Vercel frontend artifact validated at .vercel/output. No deployment was made.')


if __name__ == '__main__':
    main()
