"""Local planning only. No store requests or cart operations."""
import csv
import io
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit, parse_qs


def norm(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def card_name(value):
    """Full-name normalization; no substring or fuzzy matching."""
    value=re.sub(r' \((?:Alternate Art|Signature Overnumbered|Overnumbered)\)$','',value,flags=re.I)
    value=value.replace('’',"'")
    return norm(re.sub(r'\s*,\s*|\s+-\s+',' | ',value))


def quantity(value, default=None):
    if value == '' and default is not None:
        return default
    if not re.fullmatch(r'\d+', str(value).strip()):
        raise ValueError(f'Invalid nonnegative integer: {value!r}')
    number = int(value)
    if number > 100000:
        raise ValueError('Quantity exceeds 100000')
    return number


def read_csv(text):
    reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
    if not reader.fieldnames or 'name' not in reader.fieldnames:
        raise ValueError('CSV requires a name column (lowercase headers).')
    return list(reader)


def parse_cards(text, is_csv=False):
    cards = []
    if is_csv:
        for row in read_csv(text):
            if not (row.get('name') or '').strip():
                raise ValueError('Every CSV row requires a name.')
            cards.append({'name': row['name'].strip(),
                          'quantity': quantity(row.get('quantity', row.get('count', '')), 1),
                          'collector_number': (row.get('collector_number') or row.get('code') or '').strip(),
                          'deck': (row.get('deck') or 'Deck 1').strip(),
                          'code': (row.get('code') or '').strip()})
    else:
        deck = 'Deck 1'
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('[') and line.endswith(']'):
                deck = line[1:-1].strip()
                if not deck:
                    raise ValueError('Deck heading cannot be empty')
                continue
            match = re.fullmatch(r'(\d+)(?:[xX]\s*|\s+)(.+)', line)
            count, name = (quantity(match[1]), match[2].strip()) if match else (1, line)
            # Explicit collector suffix avoids guessing digits inside a card name.
            collector = re.fullmatch(r'(.+?)\s+\{([^{}]+)\}', name)
            cards.append({'name': collector[1].strip() if collector else name,
                          'quantity': count, 'collector_number': collector[2].strip() if collector else '',
                          'deck': deck})
    return cards


def store_url(value):
    parsed = urlsplit(value)
    return (parsed.scheme == 'https' and parsed.hostname in
            {'www.gamekeeperverdun.com', 'gamekeeperverdun.com'} and
            parsed.port in (None, 443) and not parsed.username and not parsed.password and
            parsed.path not in ('', '/') and not parsed.query and not parsed.fragment and
            not any(word in parsed.path.casefold() for word in ('cart', 'checkout', 'login')))


def inventory(text):
    products, warnings = [], []
    if not text.strip():
        return products, warnings
    for index, row in enumerate(read_csv(text), 2):
        # Manual evidence is deliberately explicit; a matching name never establishes game.
        if norm(row.get('game', '')) != 'riftbound' or row.get('verification') not in ('manual', 'saved_html', 'authorized_fetch'):
            warnings.append(f'Inventory row {index} excluded: requires game=Riftbound and verification=manual or saved_html.')
            continue
        url = row.get('url', '').strip()
        evidence = row.get('evidence_url', '').strip()
        evidence_parts = urlsplit(evidence)
        snapshot_evidence = (row.get('verification') in ('saved_html', 'authorized_fetch') and
            store_url(evidence.split('?')[0]) and evidence_parts.path == '/catalog/origins/3953' and
            set(parse_qs(evidence_parts.query)) <= {'page', 'sort_by_price'})
        if not store_url(url) or not (store_url(evidence) or snapshot_evidence):
            raise ValueError(f'Inventory row {index}: requires HTTPS store product and Riftbound evidence URLs, without query strings.')
        if not row['name'].strip():
            raise ValueError(f'Inventory row {index}: missing name')
        stamp = row.get('checked_at', '').strip()
        try:
            checked = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            if checked.tzinfo is None or checked > datetime.now(timezone.utc):
                raise ValueError()
        except ValueError:
            if stamp or row.get('verification') != 'saved_html':
                raise ValueError(f'Inventory row {index}: checked_at must be a past ISO timestamp with timezone.') from None
        price = row.get('price_cad', '').strip()
        try:
            price = Decimal(price) if price else None
            if price is not None and (not price.is_finite() or price < 0 or price != price.quantize(Decimal('.01'))):
                raise ValueError()
        except (InvalidOperation, ValueError):
            raise ValueError(f'Inventory row {index}: invalid CAD price') from None
        stock = row.get('stock', '').strip()
        product = {key: row.get(key, '').strip() for key in
                   ('name', 'collector_number', 'version', 'finish', 'condition')}
        product.update(url=url, evidence_url=evidence, price=price,
                       stock=quantity(stock) if stock else None, checked_at=stamp,
                       verification=('Authorized public category fetch — checked ' + stamp if row.get('verification') == 'authorized_fetch' else
                                     'Saved Riftbound category HTML — not live verified; capture time ' + (stamp or 'unknown')
                                     if row.get('verification') == 'saved_html' else
                                     'Manual Riftbound identification — not live verified'))
        identity = tuple(product[key] for key in ('url', 'collector_number', 'version', 'finish', 'condition'))
        if any(p['_identity'] == identity for p in products):
            raise ValueError(f'Inventory row {index}: duplicate printing; combine only after verifying stock is not duplicated.')
        product['_identity'] = identity
        product['id'] = str(index)
        products.append(product)
    return products, warnings


def plan(cards, collection, products, shared=True, choices=None):
    choices = choices or {}
    per_deck = defaultdict(lambda: defaultdict(int))
    labels = {}
    source_code_keys = set()
    for card in cards:
        key = (norm(card['name']), norm(card['collector_number']))
        if card.get('code') and norm(card['code']) == key[1]:
            source_code_keys.add(key)
        labels.setdefault(key, card['name'])
        per_deck[key][card['deck']] += card['quantity']
    owned = defaultdict(int)
    for card in collection:
        owned[(norm(card['name']), norm(card['collector_number']))] += card['quantity']
    # Unspecified collection printings are never allocated to explicit collector requests.
    remaining_owned = dict(owned)
    remaining_stock = {p['id']: p['stock'] for p in products}
    results = []
    # Explicit collector requests allocate first; all rows share the same finite stock pool.
    for key in sorted(per_deck, key=lambda k: (not bool(k[1]), k)):
        name, collector = key
        requested = (max if shared else sum)(per_deck[key].values())
        pool_keys = [key] if collector else [k for k in remaining_owned if k[0] == name]
        available_owned = sum(remaining_owned.get(k, 0) for k in pool_keys)
        allocated = min(requested, available_owned)
        to_allocate = allocated
        for pool_key in pool_keys:
            amount = min(to_allocate, remaining_owned.get(pool_key, 0))
            remaining_owned[pool_key] = remaining_owned.get(pool_key, 0) - amount
            to_allocate -= amount
        needed = max(0, requested - allocated)
        source_code = key in source_code_keys
        candidates = [p for p in products if
                      (card_name(p['name']) == card_name(name) if source_code else norm(p['name']) == name) and
                      (source_code or not collector or norm(p['collector_number']) == collector)]
        row_id = str(len(results))
        selected = next((p for p in candidates if p['id'] == choices.get(row_id)), None)
        valid = [p for p in candidates if p['price'] is not None and
                 remaining_stock[p['id']] is not None and remaining_stock[p['id']] > 0]
        if selected is None and valid:
            selected = min(valid, key=lambda p: (p['price'], p['id']))
        if selected is None and len(candidates) == 1:
            selected = candidates[0]
        status = 'Owned' if needed == 0 else 'Unresolved — no manually verified exact match'
        stock = remaining_stock[selected['id']] if selected else None
        if needed and selected:
            if stock is None or selected['price'] is None:
                status = 'Unknown stock or price — lookup not verified'
            elif stock == 0:
                status = 'Unavailable'
            elif stock < needed:
                status = 'Insufficient stock'
            else:
                status = 'Available in imported snapshot'
        elif needed and len(candidates) > 1:
            status = 'Ambiguous — select a printing; price/stock unknown'
        if source_code and selected:
            status = 'Reprint selected; source set code unverified — ' + status
        buy = min(needed, stock) if selected and stock is not None else None
        if selected and stock is not None:
            remaining_stock[selected['id']] -= buy
        subtotal = (selected['price'] * buy if selected and selected['price'] is not None and buy is not None else None)
        results.append(dict(id=row_id, name=labels[key], collector_number=collector,
                            requested=requested, owned=allocated, needed=needed,
                            available=stock, buy=buy, status=status, selected=selected,
                            candidates=candidates, subtotal=subtotal))
    return results


def safe_cell(value):
    value = '' if value is None else str(value)
    return "'" + value if value.lstrip().startswith(('=', '+', '-', '@')) else value


def export_csv(rows):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['name', 'requested_collector_or_code', 'collector_number', 'requested', 'owned_allocated', 'needed',
                     'available', 'planned_quantity', 'version', 'finish', 'condition',
                     'price_cad', 'subtotal_cad', 'status', 'url', 'evidence_url', 'checked_at', 'verification'])
    for row in rows:
        product = row['selected'] or {}
        writer.writerow([safe_cell(v) for v in [row['name'], row['collector_number'], product.get('collector_number'),
            row['requested'], row['owned'], row['needed'], row['available'], row['buy'],
            product.get('version'), product.get('finish'), product.get('condition'),
            product.get('price'), row['subtotal'], row['status'], product.get('url'),
            product.get('evidence_url'), product.get('checked_at'), product.get('verification')]])
    return output.getvalue()
