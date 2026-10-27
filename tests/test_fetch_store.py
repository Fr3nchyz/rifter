import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from io import BytesIO
from unittest.mock import Mock
from riftbound.fetch_store import crawl, StopFetch, canonical, Client, CATEGORY

FIXTURE=Path(__file__).with_name('fixtures').joinpath('riftbound-category-excerpt.html').read_text()

class FakeClient:
    interval=5
    def __init__(self,pages=66): self.calls=[];self.pages=pages
    def get(self,url):
        self.calls.append(url)
        if url.endswith('robots.txt'): return 'User-agent: *\nDisallow: /','2026-01-01T00:00:00Z',False
        page=1 if '?' not in url else int(url.split('page=')[1])
        html=FIXTURE.replace('page=2',f'page={page+1}')
        if page==self.pages: html=html.replace('rel="next"','rel=""')
        html=re.sub(r'data-vid="(\d+)"',lambda m:f'data-vid="{int(m[1])+page*10000000}"',html)
        return html+f'<!-- synthetic traversal page {page} -->','2026-01-01T00:00:00Z',False

class FetchTests(unittest.TestCase):
    def test_no_category_requests_without_permission(self):
        client=FakeClient()
        with self.assertRaises(StopFetch): crawl(client)
        self.assertEqual(len(client.calls),1)
    def test_all_66_pages_followed_and_reported(self):
        client=FakeClient();states=[]
        rows,report=crawl(client,True,progress=lambda state:states.append(state['pages']))
        self.assertEqual(report['pages'],66)
        self.assertEqual(len(rows),66*6)
        self.assertEqual(states,list(range(1,67)))
        self.assertEqual(len(client.calls),67)
        self.assertTrue(all(r['verification']=='authorized_fetch' for r in rows))
    def test_page_limit_does_not_claim_completion(self):
        with self.assertRaisesRegex(StopFetch,'Page limit'): crawl(FakeClient(),True,max_pages=2)
    def test_canonical_limits(self):
        self.assertEqual(canonical(CATEGORY+'?sort_by_price=0&page=1'),CATEGORY)
        for url in [CATEGORY+'?page=201',CATEGORY+'?page=2&page=3',CATEGORY+'?redirect=evil','https://evil.example/catalog/origins/3953']:
            with self.assertRaises(StopFetch):canonical(url)
    def test_cache_preserves_observation_and_reduces_requests(self):
        with TemporaryDirectory() as directory:
            client=Client(directory,clock=lambda:1000)
            response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=None)
            response.status=200;response.headers={'Content-Type':'text/plain'};response.read.return_value=b'User-agent: *\nDisallow: /'
            client.opener.open=Mock(return_value=response)
            first=client.get('https://www.gamekeeperverdun.com/robots.txt')
            second=client.get('https://www.gamekeeperverdun.com/robots.txt')
            self.assertFalse(first[2]);self.assertTrue(second[2]);self.assertEqual(first[1],second[1]);self.assertEqual(client.opener.open.call_count,1)
    def test_403_stops_and_429_honors_retry_after(self):
        with TemporaryDirectory() as directory:
            sleeps=[];client=Client(directory,sleep=sleeps.append,clock=lambda:1000)
            client.opener.open=Mock(side_effect=HTTPError(CATEGORY,403,'Forbidden',{},BytesIO()))
            with self.assertRaisesRegex(StopFetch,'403'): client.get(CATEGORY)
            self.assertEqual(client.opener.open.call_count,1)
            client.opener.open=Mock(side_effect=[HTTPError(CATEGORY,429,'Rate limit',{'Retry-After':'90'},BytesIO()),HTTPError(CATEGORY,403,'Forbidden',{},BytesIO())])
            with self.assertRaises(StopFetch):client.get(CATEGORY)
            self.assertIn(90,sleeps)

if __name__=='__main__': unittest.main()
