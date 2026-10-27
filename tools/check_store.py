"""Check two public store pages, with no login, cookies or cart actions.

Run locally: python tools/check_store.py
Writes a public-response report in store-check/ (HTML may be shared for diagnosis).
Does not follow redirects; their safe destination is recorded for review.
"""
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.robotparser import RobotFileParser

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def safe_location(value):
    p = urlsplit(value)
    return urlunsplit((p.scheme, p.hostname or '', p.path, '', ''))

def main():
    output = Path('store-check') / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output.mkdir(parents=True, exist_ok=False)
    report = []
    opener = build_opener(NoRedirect())
    for index, (label, url) in enumerate([
        ('robots', 'https://www.gamekeeperverdun.com/robots.txt'),
        ('home', 'https://www.gamekeeperverdun.com/')
    ]):
        if index:
            time.sleep(5)
        record = {'url': url, 'checked_at': datetime.now(timezone.utc).isoformat()}
        try:
            try:
                response = opener.open(Request(url, headers={'User-Agent': 'RiftboundInventoryDiagnostic/0.1 (public-page connectivity check)'}), timeout=30)
            except HTTPError as error:
                response = error
            with response:
                record['status'] = response.code
                record['headers'] = {name: response.headers[name] for name in
                    ('Content-Type', 'Server', 'Retry-After') if name in response.headers}
                if response.headers.get('Location'):
                    record['redirect_to_without_query'] = safe_location(response.headers['Location'])
                body = response.read(2_000_001)
                record['truncated'] = len(body) > 2_000_000
                body = body[:2_000_000]
                # Save public response bodies only, no cookies, auth or full header dumps.
                filename = label + '.html'
                (output / filename).write_bytes(body)
                record.update(body_file=filename, bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
        except (URLError, TimeoutError, OSError) as error:
            # Avoid exposing environment-specific proxy strings or credential details.
            record['error'] = type(error).__name__ + ': connection failed; no inventory conclusion'
        report.append(record)
        if label == 'robots':
            if record.get('status') != 200 or record.get('truncated'):
                print('Robots policy unavailable; stopping before homepage request.')
                break
            policy = RobotFileParser()
            policy.parse(body.decode('utf-8', errors='replace').splitlines())
            if not policy.can_fetch('RiftboundInventoryDiagnostic', 'https://www.gamekeeperverdun.com/'):
                record['robots_blocks_homepage'] = True
                print('robots.txt disallows this diagnostic crawler. Stopping; no homepage request.')
                break
        print(label + ': ' + str(record.get('status', record.get('error'))))
        if record.get('status') in (401, 403, 429, 503):
            print('Stopping on access denial or throttling. No retry or bypass attempted.')
            break
    (output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Report and public response bodies saved to ' + str(output.resolve()))
    print('Review before sharing. No inventory extraction has been attempted.')

if __name__ == '__main__':
    main()
