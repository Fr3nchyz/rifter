"""Read user-saved category HTML only. No network, scripts, images or forms run."""
import argparse
import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from .core import store_url

CATEGORY = 'https://www.gamekeeperverdun.com/catalog/origins/3953'
FIELDS = ['name','game','verification','url','evidence_url','checked_at',
          'collector_number','version','finish','condition','price_cad','stock','variant_id']
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())

class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []
    def has(self, cls):
        return cls in (self.attrs.get('class') or '').split()
    def find(self, predicate):
        for child in self.children:
            if isinstance(child, Node):
                if predicate(child): yield child
                yield from child.find(predicate)
    def text(self):
        return ' '.join(' '.join(c.text() if isinstance(c,Node) else c for c in self.children).split())

class Document(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root=Node(); self.stack=[self.root]
    def handle_starttag(self,tag,attrs):
        node=Node(tag,attrs);self.stack[-1].children.append(node)
        if tag not in VOID: self.stack.append(node)
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)
        if tag not in VOID: self.handle_endtag(tag)
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag==tag:
                self.stack=self.stack[:i];break
    def handle_data(self,data): self.stack[-1].children.append(data)


def category_link(url):
    p=urlsplit(urljoin(CATEGORY,url))
    return (p.scheme=='https' and p.hostname=='www.gamekeeperverdun.com' and
            p.path=='/catalog/origins/3953' and not p.username and not p.password and p.port in (None,443))


def extract(html, checked_at=''):
    if len(html)>10_000_000: raise ValueError('Saved HTML exceeds 10 MB')
    doc=Document();doc.feed(html);root=doc.root
    meta=list(root.find(lambda n:n.tag=='meta' and n.has('site-settings')))
    if len(meta)!=1 or meta[0].attrs.get('data-category-id')!='3953' or meta[0].attrs.get('data-category')!='Riftbound Singles':
        raise ValueError('Not a verified Riftbound Singles category snapshot (expected site category 3953).')
    if not any(n.text()=='Riftbound Singles' for n in root.find(lambda n:n.tag=='h1' and n.has('page-title'))):
        raise ValueError('Missing Riftbound Singles page heading')
    source=re.search(r'saved from url=\(\d+\)(https://[^\s<>]+)', html)
    if source and not category_link(source[1]):
        raise ValueError('Saved source URL is not the Riftbound category')
    source=source[1] if source else CATEGORY
    rows=[];warnings=[];seen={}
    containers=list(root.find(lambda n:n.has('products-container') and n.has('browse')))
    if len(containers)!=1: raise ValueError('Expected one category product listing; markup changed or incomplete.')
    products=list(containers[0].find(lambda n:n.tag=='li' and n.has('product')))
    if not products: raise ValueError('No product records found; empty/error pages are not zero stock.')
    for product in products:
        names=list(product.find(lambda n:n.attrs.get('itemprop')=='name' and n.has('name')))
        links=list(product.find(lambda n:n.tag=='a' and n.attrs.get('itemprop')=='url'))
        if not names or not links: raise ValueError('Product missing title or link')
        title=names[0].text();url=urljoin(CATEGORY,links[0].attrs.get('href',''))
        if not store_url(url) or not re.fullmatch(r'/catalog/origins/[^/]+/\d+',urlsplit(url).path):
            raise ValueError('Product link outside verified category: '+title)
        parsed=re.fullmatch(r'(.+?) - ([A-Za-z]*\d+[A-Za-z*]*(?:/[A-Za-z0-9]+)?) - (.+)',title)
        if parsed:
            name,number,version=parsed.groups()
        elif re.fullmatch(r'.+ - Token(?: - Foil)?',title):
            name,version=title.rsplit(' - Token',1);number='';version='Token'+version
        else:
            name=title;number='';version=''
            warnings.append('Unrecognized collector format; full title retained with unknown collector: '+title)
        finish='Foil' if re.search(r'(?:^| - )Foil$',version,re.I) else ''
        # Only the expanded variant region: grid/list/mobile duplicates share the same data-vid.
        variants=list(product.find(lambda n:n.has('variants')))
        if len(variants)!=1: raise ValueError('Expected one expanded variant region: '+title)
        variant_rows=list(variants[0].find(lambda n:n.has('variant-row')))
        if not variant_rows: raise ValueError('No variants: '+title)
        for variant_index, variant in enumerate(variant_rows):
            forms=list(variant.find(lambda n:n.tag=='form' and n.attrs.get('data-vid')))
            short=list(variant.find(lambda n:n.has('variant-short-info')))
            info=short[0].text() if short else ''
            amounts=set(re.findall(r'\b(\d+)\s+En stock\b',info,re.I))
            if len(amounts)>1: raise ValueError('Conflicting stock counts: '+title)
            stock=next(iter(amounts)) if amounts else ('0' if 'Hors stock' in info else '')
            if len(forms)==1:
                vid=forms[0].attrs['data-vid']
            elif not forms and stock=='0':
                vid='unavailable-product-'+url.rsplit('/',1)[1]+'-'+str(variant_index)
                warnings.append('No exposed purchasable variant ID for unavailable product: '+title)
            else:
                raise ValueError('Missing or ambiguous variant identifier: '+title)
            # Do not infer stock from qty-select maxima: it could be a purchase limit.
            price_nodes=list(variant.find(lambda n:n.has('price') and n.has('regular')))
            if not price_nodes:
                price_nodes=list(variant.find(lambda n:n.has('price') and n.has('no-stock')))
            prices=set(re.findall(r'CAD\$\s*(\d+(?:,\d{3})*\.\d{2})', ' '.join(n.text() for n in price_nodes)))
            if len(prices)>1: raise ValueError('Conflicting variant prices: '+title)
            price=next(iter(prices)).replace(',','') if prices else ''
            condition=info.split(',')[0].strip() if ',' in info else ''
            row=dict(zip(FIELDS,[name,'Riftbound','saved_html',url,source,checked_at,number,version,finish,condition,price,stock,vid]))
            if vid in seen:
                if seen[vid]!=row: raise ValueError('Conflicting duplicate variant '+vid)
                continue
            seen[vid]=row;rows.append(row)
            if not stock or not price: warnings.append('Unknown stock/price: '+title)
    next_links=sorted({urljoin(CATEGORY,n.attrs['href']) for n in root.find(lambda n:n.tag=='a' and 'next' in (n.attrs.get('rel') or '').split() and category_link(n.attrs.get('href','')))})
    if len(next_links)>1: raise ValueError('Conflicting next-page links')
    return rows,dict(source_url=source,product_count=len(products),variant_count=len(rows),
                     next_page=next_links[0] if next_links else None,
                     coverage='Partial category snapshot; not the full inventory',
                     checked_at=checked_at or None,imported_at=datetime.now(timezone.utc).isoformat(),
                     sha256=hashlib.sha256(html.encode()).hexdigest(),warnings=warnings,
                     provenance='User-supplied saved HTML; category markup checked, not live authenticated')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pages',nargs='+',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--checked-at',default='',help='Actual capture time, ISO 8601 with timezone; omit if unknown')
    args=parser.parse_args()
    if args.output.exists() or args.output.with_suffix('.report.json').exists():
        parser.error('Output already exists; choose a new filename to preserve prior snapshots.')
    if args.checked_at:
        try:
            stamp=datetime.fromisoformat(args.checked_at.replace('Z','+00:00'))
            if stamp.tzinfo is None or stamp>datetime.now(timezone.utc): raise ValueError()
        except ValueError: parser.error('Capture time must be a past ISO timestamp with timezone')
    rows={};reports=[]
    for page in args.pages:
        products,report=extract(page.read_text(encoding='utf-8-sig'),args.checked_at)
        reports.append(report)
        for row in products:
            vid=row['variant_id']
            if vid in rows and any(rows[vid][k]!=row[k] for k in FIELDS if k!='evidence_url'):
                parser.error('Conflicting snapshots for variant '+vid+'; choose the intended snapshot explicitly.')
            rows[vid]=row
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('w',newline='',encoding='utf-8') as f:
        writer=csv.DictWriter(f,fieldnames=FIELDS);writer.writeheader();writer.writerows(rows.values())
    args.output.with_suffix('.report.json').write_text(json.dumps(reports,indent=2),encoding='utf-8')
    print(f'Extracted {len(rows)} distinct variants to {args.output}. No network requests made.')
    for report in reports:
        print(f"{report['source_url']}: {report['product_count']} products; next page: {report['next_page'] or 'none shown'}")
    if not args.checked_at: print('Capture time unknown: import time is NOT the inventory check time.')

if __name__=='__main__': main()
