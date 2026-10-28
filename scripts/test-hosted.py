#!/usr/bin/env python3
"""Validate the Railway image against an isolated PostgreSQL 17/18 container."""
import argparse
import csv
from http.cookies import SimpleCookie
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']


def run(args, **kwargs):
    return subprocess.run(DOCKER + args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--postgres', default='17')
    parser.add_argument('--image', default='rifter-railway:review')
    args = parser.parse_args()
    token = secrets.token_hex(4)
    network, database, backend, mail = [f'rifter-hosted-{kind}-{token}' for kind in ('net', 'db', 'api', 'mail')]
    catalog_file = ROOT / '.local/run/hosted-catalog.json'
    if not catalog_file.exists():
        raise SystemExit('Save the public catalog/init JSON snapshot to .local/run/hosted-catalog.json first')
    ROOT.joinpath('.local').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hosted-test-', dir=ROOT / '.local') as directory:
        work = Path(directory)
        envfile = work / 'test.env'
        values = {
            'POSTGRES_USER': 'openrift', 'POSTGRES_DB': 'openrift',
            'POSTGRES_PASSWORD': secrets.token_hex(20),
            'BETTER_AUTH_SECRET': secrets.token_hex(32),
            'BETTER_AUTH_URL': 'https://rifter.example.test',
            'CORS_ORIGIN': 'https://rifter.example.test',
            'APP_ENV': 'production', 'RIFTER_DATABASE_PURPOSE': 'rifter',
            'SMTP_HOST': mail, 'SMTP_PORT': '1025', 'SMTP_SECURE': 'false',
            'SMTP_FROM': 'Rifter <test@example.test>', 'PORT': '8080',
        }
        # API and DB share this disposable container's network namespace. No
        # database port is exposed, and production TLS checks remain enabled.
        values['DATABASE_URL'] = 'postgres://openrift:' + values['POSTGRES_PASSWORD'] + '@localhost:5432/openrift'
        envfile.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
        envfile.chmod(0o600)
        quiet = {'stdout': subprocess.DEVNULL}
        def sql(statement):
            return subprocess.check_output(DOCKER + ['exec', database, 'psql', '-U', 'openrift', '-d', 'openrift', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement], text=True).strip()
        try:
            run(['network', 'create', network], **quiet)
            pgdata = '/var/lib/postgresql' if args.postgres.startswith('18') else '/var/lib/postgresql/data'
            run(['run', '-d', '--name', database, '--network', network, '--tmpfs', pgdata + ':rw,size=536870912', '--env-file', str(envfile), '-p', '127.0.0.1::8080', 'postgres:' + args.postgres, '-c', 'shared_preload_libraries=pg_stat_statements'], **quiet)
            run(['run', '-d', '--name', mail, '--network', network, 'axllent/mailpit:v1.30.0'], **quiet)
            for _ in range(60):
                if subprocess.run(DOCKER + ['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'openrift', '-d', 'openrift'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                    break
                time.sleep(0.5)
            else:
                raise AssertionError('Disposable PostgreSQL did not become ready')
            sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA extensions; CREATE EXTENSION pg_trgm WITH SCHEMA extensions; ALTER DATABASE openrift SET search_path=public,extensions; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated")
            predeploy = ['run', '--rm', '--network', 'container:' + database, '--env-file', str(envfile), '-v', str(catalog_file) + ':/snapshot.json:ro', '--entrypoint', 'bun', args.image, 'upstream/openrift/apps/api/src/modules/rifter/hosted-init.ts', '--catalog-if-empty', '--catalog-file', '/snapshot.json']
            with (work / 'init.log').open('w') as log:
                run(predeploy, stdout=log, stderr=subprocess.STDOUT)
            assert int(sql('SELECT count(*) FROM cards')) > 1000
            assert sql("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'") == 'extensions'
            assert sql("SELECT bool_and(NOT has_table_privilege(r.name,c.oid,'SELECT')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES ('anon'),('authenticated')) r(name) WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('users','collections','copies','rifter_imports','rifter_actions')") == 't'
            assert sql("SELECT bool_and(NOT has_function_privilege(r.name,p.oid,'EXECUTE')) FROM pg_proc p CROSS JOIN (VALUES ('anon'),('authenticated')) r(name) WHERE p.proname='rifter_undo'") == 't'
            assert sql("SELECT count(DISTINCT id)=1000 AND bool_and(substr(id::text,15,1)='7' AND substr(id::text,20,1) IN ('8','9','a','b')) FROM (SELECT uuidv7() id FROM generate_series(1,1000)) s") == 't'
            if args.postgres.startswith('18'):
                assert sql("SELECT to_regprocedure('public.uuidv7()') IS NULL") == 't'
            volume = work / 'persistent'
            media = volume / 'media/cards'
            media.mkdir(parents=True)
            (media / 'hosted-test.png').write_bytes(b'\x89PNG\r\n\x1a\ncache-fixture')
            run(['run', '-d', '--name', backend, '--network', 'container:' + database, '--env-file', str(envfile), '-v', str(volume) + ':/app/.local', args.image], **quiet)
            port = subprocess.check_output(DOCKER + ['port', database, '8080/tcp'], text=True).strip().rsplit(':', 1)[1]
            origin = 'http://127.0.0.1:' + port
            cookies = {}
            def request(path, data=None, method=None, supplied_origin=None):
                headers = {'Origin': supplied_origin or values['BETTER_AUTH_URL']}
                if cookies:
                    headers['Cookie'] = '; '.join(f'{key}={value}' for key, value in cookies.items())
                body = None if data is None else json.dumps(data).encode()
                if body:
                    headers['Content-Type'] = 'application/json'
                req = urllib.request.Request(origin + path, data=body, headers=headers, method=method)
                with urllib.request.urlopen(req, timeout=20) as response:
                    for header in response.headers.get_all('Set-Cookie', []):
                        parsed = SimpleCookie(header)
                        cookies.update({key: value.value for key, value in parsed.items()})
                    content = response.read()
                    return json.loads(content) if response.headers.get_content_type() == 'application/json' else content
            for _ in range(120):
                try:
                    if request('/api/health')['status'] == 'ok':
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(0.5)
            else:
                raise AssertionError('Railway gateway not ready')
            request('/api/auth/sign-up/email', {'name': 'Hosted fixture', 'email': 'hosted@example.test', 'password': 'Test-' + values['POSTGRES_PASSWORD']})
            sql("UPDATE users SET email_verified=true WHERE email='hosted@example.test'")
            request('/api/auth/sign-in/email', {'email': 'hosted@example.test', 'password': 'Test-' + values['POSTGRES_PASSWORD']})
            overview = request('/api/v1/rifter/overview')
            try:
                request('/api/v1/rifter/imports', {}, supplied_origin='https://other.example.test')
            except urllib.error.HTTPError as error:
                assert error.code == 403
            else:
                raise AssertionError('Untrusted mutation origin accepted')
            def apply(raw, destination):
                staged = request('/api/v1/rifter/imports', {'rawInput': raw, 'source': 'Hosted container test', 'format': 'text', 'destination': destination})
                choices = [{'index': index, 'printingId': row['candidates'][0]['printingId'], 'excluded': False} for index, row in enumerate(staged['rows'])]
                reviewed = request('/api/v1/rifter/imports/' + staged['id'], {'revision': staged['revision'], 'choices': choices}, 'PATCH')
                before = request('/api/v1/rifter/overview')
                assert sum(c['quantity'] for c in before['collections']) == 0
                result = request('/api/v1/rifter/imports/' + staged['id'] + '/confirm', {'revision': reviewed['revision']})
                repeated = request('/api/v1/rifter/imports/' + staged['id'] + '/confirm', {'revision': reviewed['revision']})
                assert repeated['id'] == result['id'] and repeated['alreadyApplied'] is True
                return result, staged
            deck, _ = apply('3 OGN-123', {'kind': 'new-deck', 'name': 'Hosted aspiring deck', 'status': 'aspiring'})
            acquired, printing = apply('1 OGN-123', {'kind': 'collection', 'id': overview['collections'][0]['id'], 'mode': 'add'})
            def missing():
                return sum(row['missing'] for row in request('/api/v1/rifter/decks/' + deck['deckId'] + '/gaps'))
            assert missing() == 2
            action = next(a for a in request('/api/v1/rifter/overview')['actions'] if a['label'] == 'Apply import / acquisition')
            request('/api/v1/rifter/actions/' + action['id'] + '/undo', {})
            assert missing() == 3
            inventory = io.StringIO()
            writer = csv.writer(inventory)
            writer.writerow(['name','game','verification','url','evidence_url','checked_at','collector_number','version','finish','condition','price_cad','stock'])
            writer.writerow([printing['rows'][0]['candidates'][0]['name'],'Riftbound','manual','https://www.gamekeeperverdun.com/fixture','https://www.gamekeeperverdun.com/category','2026-01-01T00:00:00Z','123','Base','Normal','NM','2.50','2'])
            request('/api/v1/rifter/shopping/snapshot', {'csv': inventory.getvalue()})
            assert request('/api/v1/rifter/shopping/status')['snapshot']['records'] == 1
            assert request('/media/cards/hosted-test.png').startswith(b'\x89PNG')
            run(['restart', backend], **quiet)
            for _ in range(90):
                try:
                    if missing() == 3:
                        break
                except OSError:
                    pass
                time.sleep(0.5)
            else:
                raise AssertionError('History/collection did not survive backend restart')
            assert request('/api/v1/rifter/shopping/status')['snapshot']['records'] == 1
            assert request('/media/cards/hosted-test.png').startswith(b'\x89PNG')
            with (work / 'repeat-init.log').open('w') as log:
                run(predeploy, stdout=log, stderr=subprocess.STDOUT)
            assert missing() == 3
            print(f'Railway image + PostgreSQL {args.postgres}: migration, private grants, UUIDv7, catalog, auth, imports/idempotency, gaps, undo, Python adapter, media and restart checks passed.')
        except Exception:
            for file in work.glob('*.log'):
                print(file.read_text()[-6000:])
            subprocess.run(DOCKER + ['logs', '--tail', '50', backend], check=False)
            raise
        finally:
            for name in (backend, mail, database):
                subprocess.run(DOCKER + ['rm', '-fv', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(DOCKER + ['network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
