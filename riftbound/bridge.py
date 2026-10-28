"""JSON bridge for the OpenRift adapter. Never fetches or modifies a cart."""
import csv
import io
import json
import sys
from decimal import Decimal
from .core import inventory
from .deck_report import build


def handle(data):
    raw = data.get('csv', '')
    if not raw or len(raw) > 5_000_000:
        raise ValueError('Inventory CSV is empty or too large')
    products, warnings = inventory(raw)
    records = list(csv.DictReader(io.StringIO(raw.lstrip('\ufeff'))))
    if not products or len(products) != len(records) or warnings:
        raise ValueError('Snapshot contains unverified or invalid inventory rows')
    if data.get('operation') == 'validate':
        return {'records': len(products), 'warnings': warnings}
    targets = data.get('targets', [])
    if len(targets) > 500:
        raise ValueError('Too many shopping targets')
    for target in targets:
        if not isinstance(target.get('count'), int) or not 0 <= target['count'] <= 5000:
            raise ValueError('Invalid shopping quantity')
        target.setdefault('code', '')
    for record in records:
        for field in ('variant_id', 'collector_number', 'version', 'finish', 'condition', 'checked_at'):
            record.setdefault(field, '')
    summaries, allocations = build(targets, records, any_printing=True)
    return {'rows': summaries, 'allocations': allocations,
            'subtotalCad': str(sum((Decimal(row['subtotal_cad']) for row in summaries), Decimal(0))),
            'planned': sum(row['planned'] for row in summaries),
            'unfilled': sum(row['shortfall'] for row in summaries),
            'limitations': 'Name-matched candidates require review. Set identity, pickup branch, tax and shipping are not independently verified. Missing listings are unresolved, not proof of zero stock.'}


def main():
    try:
        data = json.loads(sys.stdin.read(6_000_001))
        print(json.dumps(handle(data), default=str))
    except (ValueError, KeyError, TypeError) as error:
        print(json.dumps({'error': str(error)}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
