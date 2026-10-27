import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from .core import parse_cards, inventory, plan, export_csv

PAGE = Path(__file__).with_name('templates').joinpath('index.html').read_bytes()

class Handler(BaseHTTPRequestHandler):
    def headers_out(self, status, kind):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()

    def trusted(self):
        allowed = {f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}'}
        return self.headers.get('Host') in allowed and self.headers.get('Origin', 'http://' + self.headers.get('Host', '')) in {'http://' + h for h in allowed}

    def do_GET(self):
        if not self.trusted() or self.path != '/':
            self.send_error(404)
            return
        self.headers_out(200, 'text/html; charset=utf-8')
        self.wfile.write(PAGE)

    def do_POST(self):
        if not self.trusted() or self.path != '/api/plan' or self.headers.get('Content-Type') != 'application/json':
            self.send_error(403)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 2000000:
                raise ValueError('Request must be between 1 byte and 2 MB')
            data = json.loads(self.rfile.read(length))
            cards = parse_cards(data.get('deck', ''), data.get('deck_csv', False))
            collection = parse_cards(data.get('collection', ''), True) if data.get('collection', '').strip() else []
            products, warnings = inventory(data.get('inventory', ''))
            rows = plan(cards, collection, products, data.get('shared', True), data.get('choices', {}))
            result = {'rows': rows, 'warnings': warnings,
                      'csv': export_csv(rows), 'live_status': ('Showing imported inventory observations; refresh separately with the authorized importer' if products else 'Not checked — no inventory loaded'),
                      'total_cad': sum((r['subtotal'] or 0) for r in rows)}
            body = json.dumps(result, default=str).encode()
            self.headers_out(200, 'application/json')
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            body = json.dumps({'error': str(error)}).encode()
            self.headers_out(400, 'application/json')
        self.wfile.write(body)


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Local Riftbound singles planner; no outgoing store requests.')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = HTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Local Riftbound planner listening on port {args.port}. Ctrl-C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
