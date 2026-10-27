"""Authorized, read-only category inventory retrieval. No browser/cart endpoints."""
import argparse
import csv
import hashlib
import json
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.robotparser import RobotFileParser
from .store_html import CATEGORY, FIELDS, extract

AGENT='RiftboundInventoryPlanner/0.1 (store-authorized read-only inventory fetch)'

class StopFetch(RuntimeError): pass
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl): return None

def canonical(url):
    p=urlsplit(url)
    query=parse_qsl(p.query,keep_blank_values=True)
    if (p.scheme!='https' or p.hostname!='www.gamekeeperverdun.com' or p.port not in (None,443)
        or p.username or p.password or p.path!='/catalog/origins/3953' or p.fragment
        or any(k not in ('page','sort_by_price') for k,v in query)
        or len({k for k,v in query})!=len(query)):
        raise StopFetch('Refusing unexpected category/pagination URL')
    values=dict(query)
    if 'page' in values and (not values['page'].isdigit() or not 1<=int(values['page'])<=200):
        raise StopFetch('Invalid page number')
    if 'sort_by_price' in values and values['sort_by_price'] not in ('0','1'):
        raise StopFetch('Invalid sorting parameter')
    if values.get('page')=='1': values.pop('page')
    if values.get('sort_by_price')=='0': values.pop('sort_by_price')
    return urlunsplit((p.scheme,p.netloc,p.path,urlencode(sorted(values.items())),''))

class Client:
    def __init__(self,cache,interval=5,ttl=900,sleep=time.sleep,clock=time.time):
        self.cache=Path(cache);self.cache.mkdir(parents=True,exist_ok=True)
        self.interval=interval;self.ttl=ttl;self.sleep=sleep;self.clock=clock;self.last=None
        self.opener=build_opener(NoRedirect())
    def get(self,url):
        digest=hashlib.sha256(url.encode()).hexdigest()
        meta_path=self.cache/(digest+'.json');body_path=self.cache/(digest+'.html')
        if meta_path.exists() and body_path.exists():
            meta=json.loads(meta_path.read_text())
            age=self.clock()-meta['epoch']
            data=body_path.read_bytes()
            if 0<=age<self.ttl and hashlib.sha256(data).hexdigest()==meta['sha256'] and meta['url']==url:
                return data.decode('utf-8-sig'),meta['checked_at'],True
        for attempt in range(4):
            if self.last is not None:
                self.sleep(max(0,self.interval-(self.clock()-self.last)))
            self.last=self.clock()
            try:
                response=self.opener.open(Request(url,headers={'User-Agent':AGENT,'Accept':'text/html,text/plain;q=0.9'}),timeout=30)
                with response:
                    if response.status!=200: raise StopFetch('Unexpected HTTP status '+str(response.status))
                    data=response.read(10_000_001)
                    if len(data)>10_000_000: raise StopFetch('Oversized response')
                    kind=response.headers.get('Content-Type','').lower()
                    if 'html' not in kind and 'text/plain' not in kind: raise StopFetch('Unexpected response type '+kind)
                text=data.decode('utf-8-sig')
                if any(marker in text.lower() for marker in ('cf-chl-', 'challenge-platform', '<title>just a moment')):
                    raise StopFetch('Browser challenge detected; no bypass attempted')
                stamp=datetime.now(timezone.utc).isoformat()
                meta=dict(url=url,epoch=self.clock(),checked_at=stamp,sha256=hashlib.sha256(data).hexdigest())
                body_path.write_bytes(data);meta_path.write_text(json.dumps(meta,indent=2))
                return text,stamp,False
            except HTTPError as error:
                status=error.code;retry_after=error.headers.get('Retry-After');error.close()
                if status not in (429,503) or attempt==3:
                    raise StopFetch(f'HTTP {status}; stopped. Previous snapshot preserved.') from None
                delay=30*(2**attempt)
                if retry_after:
                    try: delay=max(delay,float(retry_after))
                    except ValueError:
                        try: delay=max(delay,parsedate_to_datetime(retry_after).timestamp()-self.clock())
                        except (ValueError,TypeError,OverflowError): pass
                if delay>3600: raise StopFetch('Retry-After exceeds one hour; retry later')
                print(f'HTTP {status}; backing off {delay:.0f}s (retry {attempt+1}/3)',flush=True)
                self.sleep(delay)
            except (URLError,TimeoutError,OSError) as error:
                if attempt==3: raise StopFetch('Connection failed after bounded retries; inventory remains unknown') from None
                delay=30*(2**attempt)
                print(f'Connection failure; backing off {delay}s (retry {attempt+1}/3)',flush=True)
                self.sleep(delay)
        raise StopFetch('Request incomplete')

def crawl(client, store_permission=False, max_pages=100, progress=None):
    robots,_,_=client.get('https://www.gamekeeperverdun.com/robots.txt')
    policy=RobotFileParser();policy.parse(robots.splitlines())
    if not policy.can_fetch(AGENT,CATEGORY) and not store_permission:
        raise StopFetch('robots.txt disallows general crawlers. Store permission is required; no category pages fetched.')
    interval=policy.crawl_delay(AGENT)
    if interval: client.interval=max(client.interval,interval)
    rate=policy.request_rate(AGENT)
    if rate and rate.requests: client.interval=max(client.interval,rate.seconds/rate.requests)
    url=CATEGORY;seen=set();records={};reports=[];content_hashes=set()
    while url:
        url=canonical(url)
        if url in seen: raise StopFetch('Pagination cycle; full coverage not established')
        if len(seen)>=max_pages: raise StopFetch('Page limit reached; full coverage not established')
        seen.add(url)
        html,stamp,cached=client.get(url)
        try: rows,report=extract(html,stamp)
        except ValueError as error: raise StopFetch('Category parser failed: '+str(error)) from None
        # Repeated bodies often indicate a server ignoring the page parameter.
        if report['sha256'] in content_hashes: raise StopFetch('Repeated page body; pagination may be ignored')
        content_hashes.add(report['sha256'])
        if any(w.startswith('Unparsed') for w in report['warnings']):
            raise StopFetch('Unparsed products encountered; stopping for parser review, not dropping cards')
        report.update(source_url=url,cache_hit=cached)
        reports.append(report)
        for row in rows:
            row.update(evidence_url=url,verification='authorized_fetch')
            vid=row['variant_id']
            if vid in records:
                if any(records[vid][k]!=row[k] for k in FIELDS if k not in ('evidence_url','checked_at')):
                    raise StopFetch('Variant conflict across pages: '+vid)
                continue
            records[vid]=row
        state=dict(status='in_progress',pages=len(reports),variants=len(records),next_page=report['next_page'],reports=reports)
        if progress: progress(state)
        print(f"Page {len(reports)}: {len(rows)} variants; {len(records)} unique; {'cached' if cached else 'fetched'}",flush=True)
        url=report['next_page']
    return list(records.values()),dict(status='complete_pagination_traversal',pages=len(reports),variants=len(records),reports=reports,
        permission_confirmed=store_permission,completed_at=datetime.now(timezone.utc).isoformat(),
        limitations='Non-atomic public category snapshot; availability may change during or after collection. Numeric page size/total may vary. Product details/cart not checked.')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cache',type=Path,default=Path('.local/store-cache'))
    parser.add_argument('--store-permission',action='store_true',help='Confirm you have store permission for this retrieval despite general robots restrictions')
    args=parser.parse_args()
    report_file=args.output.with_suffix('.report.json')
    if args.output.exists() or report_file.exists(): parser.error('Output already exists; choose a new filename.')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    progress_file=args.output.with_suffix('.progress.json')
    state={}
    def progress(value):
        state.clear();state.update(value)
        progress_file.write_text(json.dumps(state,indent=2))
    try:
        rows,report=crawl(Client(args.cache),args.store_permission,progress=progress)
    except (StopFetch,KeyboardInterrupt) as error:
        state.update(status='failed_or_cancelled',error=str(error) or 'Cancelled; rerun to reuse fresh cache')
        progress_file.write_text(json.dumps(state,indent=2))
        parser.exit(1,str(state['error'])+'\nNo complete CSV published. Cached pages retained.\n')
    # Write complete results only; never replace a previous successful snapshot with failure.
    with args.output.open('x',newline='',encoding='utf-8') as file:
        writer=csv.DictWriter(file,fieldnames=FIELDS);writer.writeheader();writer.writerows(rows)
    report_file.write_text(json.dumps(report,indent=2))
    progress(report)
    print(f'Saved {len(rows)} variants across {report["pages"]} pages to {args.output}',flush=True)

if __name__=='__main__': main()
