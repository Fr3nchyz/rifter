#!/usr/bin/env python3
"""Back up PostgreSQL and auth configuration; restore only into a new database."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
import shutil
import tarfile
import tempfile
from setup import ROOT, UP, DOCKER

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['create', 'restore'])
    parser.add_argument('archive', nargs='?', type=Path)
    parser.add_argument('--database', help='New empty restore database; existing databases are never overwritten')
    args = parser.parse_args()
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
