#!/usr/bin/env python3
"""Back up PostgreSQL and auth configuration; restore only into a new database."""
import argparse
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
import shutil
import tarfile
import tempfile
from setup import ROOT, UP, DOCKER

def hosted(args, parser):
    """Back up/restore a hosted database using local pg_dump/pg_restore (PostgreSQL 17 client)."""
    if args.operation == 'create':
        url = os.environ.get('DATABASE_URL')
        if not url:
            parser.error('set DATABASE_URL in your shell first (never pass it on the command line)')
        folder = ROOT / '.local/backups'
        folder.mkdir(parents=True, exist_ok=True)
        output = folder / (datetime.now(timezone.utc).strftime('rifter-hosted-%Y%m%dT%H%M%S%fZ') + '.dump')
        with output.open('xb') as file:
            output.chmod(0o600)
            subprocess.run(['pg_dump', '--dbname', url, '-Fc', '--no-owner'], stdout=file, check=True)
        print('Private hosted backup created:', output)
        print('It does NOT contain BETTER_AUTH_SECRET: keep that in a password manager.')
    else:
        url = os.environ.get('RESTORE_DATABASE_URL')
        if not args.archive or not url:
            parser.error('restore requires an archive and RESTORE_DATABASE_URL pointing at a NEW EMPTY database')
        subprocess.run(['pg_restore', '--dbname', url, '--exit-on-error', '--no-owner', str(args.archive)], check=True)
        print('Restored into the database named by RESTORE_DATABASE_URL.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['create', 'restore'])
    parser.add_argument('archive', nargs='?', type=Path)
    parser.add_argument('--database', help='New empty restore database; existing databases are never overwritten')
    parser.add_argument('--database-url', action='store_true',
                        help='Hosted mode: dump/restore the PostgreSQL named by env DATABASE_URL (or RESTORE_DATABASE_URL) with local pg_dump/pg_restore')
    args = parser.parse_args()
    if args.database_url:
        hosted(args, parser)
        return
    if args.operation == 'create':
        folder = ROOT / '.local/backups'
        folder.mkdir(parents=True, exist_ok=True)
        output = folder / (datetime.now(timezone.utc).strftime('rifter-%Y%m%dT%H%M%S%fZ') + '.tar.gz')
        with tempfile.TemporaryDirectory(dir=folder) as temporary:
            dump = Path(temporary) / 'database.dump'
            with dump.open('xb') as file:
                subprocess.run(DOCKER + ['exec', 'rifter-db', 'pg_dump', '-U', 'openrift', '-d', 'openrift', '-Fc'], stdout=file, check=True)
            with output.open('xb') as file:
                output.chmod(0o600)
                with tarfile.open(fileobj=file, mode='w:gz') as archive:
                    archive.add(dump, arcname='database.dump')
                    archive.add(UP / '.env', arcname='openrift.env')
        print('Private backup created:', output)
    else:
        name = args.database or ''
        if not args.archive or not re.fullmatch(r'rifter_restore_[a-z0-9_]+', name):
            parser.error('restore requires an archive and --database rifter_restore_<name>')
        with tarfile.open(args.archive, 'r:gz') as archive:
            if set(archive.getnames()) != {'database.dump', 'openrift.env'} or any(not m.isfile() for m in archive.getmembers()):
                raise SystemExit('Invalid backup contents')
            subprocess.run(DOCKER + ['exec', 'rifter-db', 'createdb', '-U', 'openrift', name], check=True)
            with archive.extractfile('database.dump') as source, tempfile.TemporaryFile() as dump:
                shutil.copyfileobj(source, dump)
                dump.seek(0)
                subprocess.run(DOCKER + ['exec', '-i', 'rifter-db', 'pg_restore', '-U', 'openrift', '-d', name, '--exit-on-error', '--no-owner'], stdin=dump, check=True)
            output = ROOT / '.local/restored' / name
            output.mkdir(parents=True, exist_ok=False)
            with (output / 'openrift.env').open('xb') as file:
                (output / 'openrift.env').chmod(0o600)
                file.write(archive.extractfile('openrift.env').read())
        print('Restored into', name, '. Original database unchanged. Auth configuration saved privately under .local/restored/.')

if __name__ == '__main__':
    main()
