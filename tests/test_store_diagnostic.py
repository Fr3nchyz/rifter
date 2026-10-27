import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
import os
from tools.check_store import main

class Response:
    code = 200
    headers = {'Content-Type':'text/plain'}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit): return b'User-agent: *\nDisallow: /\n'

class DiagnosticTest(unittest.TestCase):
    def test_disallowed_robots_never_requests_home(self):
        with TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                with patch('tools.check_store.build_opener') as build:
                    build.return_value.open.return_value = Response()
                    main()
                    self.assertEqual(build.return_value.open.call_count, 1)
                    self.assertFalse(list(Path('store-check').glob('*/home.html')))
            finally:
                os.chdir(previous)
