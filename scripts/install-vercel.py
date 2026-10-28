#!/usr/bin/env python3
"""Install just the web workspace; never start Docker or initialize a database."""
import os
from pathlib import Path
import subprocess
from setup import ROOT, UP


def pinned_bun():
    # Vercel's preinstalled Bun may differ from the upstream lockfile's version.
    directory = ROOT / '.local/tools'
    binary = directory / 'node_modules/.bin/bun'
    if not binary.exists() or subprocess.check_output([str(binary), '--version'], text=True).strip() != '1.4.3':
        subprocess.run(['npm', 'install', '--prefix', str(directory), 'bun@1.4.3', '--no-audit', '--no-fund'], check=True)
    return str(binary)


def main():
    subprocess.run(['git', 'submodule', 'update', '--init', '--recursive'], cwd=ROOT, check=True)
    subprocess.run(['python3', str(ROOT / 'scripts/apply-openrift.py')], check=True)
    bun = pinned_bun()
    env = dict(os.environ, CI='1')
    env['PATH'] = str(Path(bun).parent) + os.pathsep + env.get('PATH', '')
    subprocess.run([bun, 'install', '--frozen-lockfile'], cwd=UP, env=env, check=True)


if __name__ == '__main__':
    main()
