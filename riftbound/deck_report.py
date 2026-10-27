"""Build a reviewable shopping report from a Rifty export and fetched inventory."""
import argparse
import csv
import html
import re
from decimal import Decimal
from pathlib import Path
from .core import norm, safe_cell, card_name


def collector_stem(value):
    value=value.split('/')[0].upper()
    # Keep a rune/promo prefix; only printing suffixes follow the numeric part.
    match=re.fullmatch(r'([A-Z]*)(\d+)[A-Z*]*',value)
    return (match[1],int(match[2])) if match else value



def build(targets,inventory,any_printing=False):
    remaining={r['variant_id']:int(r['stock']) if r['stock']!='' else None for r in inventory}
    summaries=[];allocations=[]
    for request in targets:
        wanted=int(request['count']);name=request['name'];code=request['code']
        section=request.get('section','')
        number=code.split('-',1)[1] if '-' in code else code
        same_name=[r for r in inventory if card_name(r['name'])==card_name(name)]
        suggestions=[] if same_name else [r for r in inventory if card_name(r['name']).rstrip('s') == card_name(name).rstrip('s')]
        candidates=same_name if any_printing else [r for r in same_name if collector_stem(r['collector_number'])==collector_stem(number)]
        eligible=[r for r in candidates if r['price_cad'] and remaining[r['variant_id']] is not None and remaining[r['variant_id']]>0]
        eligible.sort(key=lambda r:(Decimal(r['price_cad']),r['variant_id']))
        missing=wanted;subtotal=Decimal(0);purchases=[]
        for product in eligible:
            count=min(missing,remaining[product['variant_id']])
            if not count:continue
            remaining[product['variant_id']]-=count;missing-=count
            total=Decimal(product['price_cad'])*count;subtotal+=total
            lot=dict(section=section,code=code,name=name,quantity=count,price_cad=product['price_cad'],subtotal_cad=str(total),
                collector_number=product['collector_number'],version=product['version'],finish=product['finish'],condition=product['condition'],
                url=product['url'],checked_at=product['checked_at'],variant_id=product['variant_id'])
            purchases.append(lot);allocations.append(lot)
        if not candidates:status='No matching listing in traversed category' if not same_name else 'Review: name found, collector differs'
        elif any(r['stock']=='' or r['price_cad']=='' for r in candidates):status='Unknown price/stock in candidate listings' if missing else 'Covered in snapshot; review versions'
        elif missing==0:status='Covered in snapshot; review versions'
        elif wanted==missing:status='Observed matching listings out of stock'
        else:status='Insufficient stock'
        if not candidates and suggestions: status='Unresolved — possible name difference; no copies allocated'
        summaries.append(dict(section=section,code=code,name=name,requested=wanted,owned='Not supplied',planned=wanted-missing,
            shortfall=missing,subtotal_cad=str(subtotal),status=status,
            review=('Same full card name; alternate collectors/sets permitted for review. Set prefix not independently verified.' if any_printing else 'Full name punctuation and collector stem matched; set prefix not independently verified. Alternative art/foil may be selected.'),
            product_links=' | '.join(dict.fromkeys(r['url'] for r in candidates or same_name or suggestions)),purchases=purchases,candidates=candidates or same_name,suggestions=suggestions))
    return summaries,allocations


def write_csv(path,rows,fields):
    with path.open('x',newline='',encoding='utf-8') as file:
        writer=csv.DictWriter(file,fieldnames=fields,extrasaction='ignore');writer.writeheader()
        writer.writerows({k:safe_cell(v) for k,v in row.items() if k in fields} for row in rows)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('deck',type=Path);parser.add_argument('inventory',type=Path)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--printing-policy',choices=['same-collector','any-printing'],default='same-collector')
    args=parser.parse_args()
    targets=list(csv.DictReader(args.deck.open(encoding='utf-8-sig')))
    inventory=list(csv.DictReader(args.inventory.open(encoding='utf-8-sig')))
    summaries,allocations=build(targets,inventory,args.printing_policy=='any-printing')
    args.output_dir.mkdir(parents=True,exist_ok=True)
    write_csv(args.output_dir/'shopping-summary.csv',summaries,['section','code','name','requested','owned','planned','shortfall','subtotal_cad','status','review','product_links'])
    fields=['section','code','name','quantity','collector_number','version','finish','condition','price_cad','subtotal_cad','url','checked_at','variant_id']
    write_csv(args.output_dir/'shopping-printings.csv',allocations,fields)
    esc=lambda value:html.escape(str(value),quote=True)
    total=sum((Decimal(r['subtotal_cad']) for r in summaries),Decimal(0))
    requested=sum(r['requested'] for r in summaries);planned=sum(r['planned'] for r in summaries)
    section_totals={}
    for request in targets:
        if request.get('section'):section_totals[request['section']]=section_totals.get(request['section'],0)+int(request['count'])
    section_note=' · '.join(esc(k)+': '+str(v) for k,v in section_totals.items())
    policy_note=('Any full-name matched printing is included; collector numbers may differ from your CSV.' if args.printing_policy=='any-printing' else 'Collector stems are constrained to your CSV; set prefixes remain unverified.')
    page=['<!doctype html><meta charset="utf-8"><title>Deck completion — Game Keeper Verdun</title><style>body{font:16px system-ui;margin:24px;color:#162a35}table{border-collapse:collapse;width:100%}th,td{padding:12px;border-bottom:1px solid #ccc;text-align:left;vertical-align:top}small{display:block}details{max-width:550px}</style><h1>Your deck completion report</h1>',f'<p>{len(targets)} entries · {requested} requested copies · {planned} planned copies · {requested-planned} unfilled copies · CAD {total:.2f} available-copies subtotal (tax/shipping excluded).</p>',
    '<p>'+policy_note+'</p><p>'+section_note+'</p>',
    '<p>Owned collection not supplied: all requested copies are treated as needed. Prices/stock are a non-atomic snapshot and can change. Exact set prefix is not independently verified by listing markup: review the selected printings and collector numbers. Name punctuation is normalized only for comma versus subtitle dash; explicit alternate-art annotations are treated as printings. The report may split quantities across valid named foil/art versions. It never orders or adds to cart.</p><table><tr><th>Section</th><th>Code / full name</th><th>Requested</th><th>Planned</th><th>Unfilled</th><th>CAD subtotal</th><th>Status / printings</th></tr>']
    for row in summaries:
        detail='<details><summary>Review candidate printings</summary>'
        for p in row['candidates']+row['suggestions']:
            detail+=f'<p><a href="{esc(p["url"])}" rel="noopener noreferrer">{esc(p["name"])} · {esc(p["collector_number"])} · {esc(p["version"])} · {esc(p["condition"])}</a><small>CAD {esc(p["price_cad"] or "unknown")} · stock {esc(p["stock"] or "unknown")} · checked {esc(p["checked_at"])}</small></p>'
        if row['suggestions']: detail+='<p>Possible name difference only: no stock allocated. Confirm the intended card before purchasing.</p>'
        detail+='</details>'
        lots=''.join(f'<p>Plan {p["quantity"]} × <a href="{esc(p["url"])}">{esc(p["version"])}</a> at CAD {esc(p["price_cad"])}</p>' for p in row['purchases'])
        page.append('<tr>'+''.join('<td>'+esc(v)+'</td>' for v in [row['section'],row['code']+' '+row['name'],row['requested'],row['planned'],row['shortfall'],row['subtotal_cad']])+'<td>'+esc(row['status'])+lots+detail+'</td></tr>')
    page.append('</table>')
    output=args.output_dir/'shopping-report.html'
    if output.exists():parser.error('Report exists; use a new output directory')
    output.write_text('\n'.join(page),encoding='utf-8')
    print(f'{planned}/{requested} copies planned; {requested-planned} unfilled; CAD {total:.2f} subtotal. Review set/printing identity in {output}')

if __name__=='__main__': main()
