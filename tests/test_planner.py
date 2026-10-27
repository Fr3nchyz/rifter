import csv
import io
import json
import threading
import unittest
import urllib.request
import urllib.error
from decimal import Decimal
from http.server import HTTPServer
from riftbound.core import parse_cards, inventory, plan, export_csv, store_url
from riftbound.server import Handler

HEADER = 'name,game,verification,url,evidence_url,checked_at,collector_number,version,finish,condition,price_cad,stock\n'
def stock(rows='Example Card,Riftbound,manual,https://www.gamekeeperverdun.com/example-card.html,https://www.gamekeeperverdun.com/riftbound-singles/,2026-01-01T00:00:00Z,DEMO-001,Base,Normal,NM,2.50,4\n'):
    return inventory(HEADER + rows)[0]

class PlannerTests(unittest.TestCase):
    def test_formats_and_decks(self):
        cards = parse_cards('[A]\n3 Example Card\n2x Another Card\nOne Card\n[B]\n1X Example Card {DEMO-001}')
        self.assertEqual([c['quantity'] for c in cards], [3,2,1,1])
        self.assertEqual(cards[-1]['collector_number'], 'DEMO-001')
        self.assertEqual(cards[-1]['deck'], 'B')

    def test_csv_bom_and_quoted_names(self):
        cards = parse_cards('\ufeffname,quantity,collector_number,deck\n"Card, Full Name",3,SET-1,A\n', True)
        self.assertEqual(cards[0]['name'], 'Card, Full Name')
        with self.assertRaises(ValueError):
            parse_cards('name,quantity\nBad,-1\n', True)

    def test_shared_and_separate(self):
        cards = parse_cards('[A]\n3 Example Card\n[B]\n2 Example Card')
        collection = parse_cards('name,quantity\nExample Card,1\n', True)
        self.assertEqual(plan(cards,collection,stock(),True)[0]['needed'],2)
        self.assertEqual(plan(cards,collection,stock(),False)[0]['needed'],4)

    def test_exact_game_and_name(self):
        products, warnings = inventory(HEADER + 'Example Card,Magic,manual,https://www.gamekeeperverdun.com/card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,,,,,1,5\n')
        self.assertEqual(products, [])
        self.assertEqual(len(warnings),1)
        self.assertIsNone(plan(parse_cards('Example'), [], stock())[0]['selected'])
        self.assertIsNone(plan(parse_cards('Example Card {DEMO-999}'), [], stock())[0]['selected'])

    def test_unknown_is_not_zero(self):
        products=stock('Example Card,Riftbound,manual,https://www.gamekeeperverdun.com/card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,,,,,,\n')
        row=plan(parse_cards('Example Card'),[],products)[0]
        self.assertIsNone(row['available'])
        self.assertIsNone(row['subtotal'])
        self.assertIn('Unknown',row['status'])
        self.assertIn('Unresolved',plan(parse_cards('Missing'),[],products)[0]['status'])

    def test_stock_shortfall_and_subtotal(self):
        row=plan(parse_cards('6 Example Card'),[],stock())[0]
        self.assertEqual(row['status'],'Insufficient stock')
        self.assertEqual(row['buy'],4)
        self.assertEqual(row['subtotal'],Decimal('10.00'))

    def test_stock_and_collection_never_double_allocated(self):
        cards=parse_cards('3 Example Card {DEMO-001}\n3 Example Card')
        owned=parse_cards('name,quantity,collector_number\nExample Card,2,DEMO-001\n',True)
        rows=plan(cards,owned,stock())
        self.assertEqual(sum(r['owned'] for r in rows),2)
        self.assertEqual(sum(r['buy'] for r in rows),4)

    def test_cheapest_available_and_manual_selection(self):
        products=stock()
        p=dict(products[0],id='other',price=Decimal('1.00'),stock=1,version='Alternate')
        products.append(p)
        row=plan(parse_cards('Example Card'),[],products)[0]
        self.assertEqual(row['selected']['id'],'other')
        self.assertEqual(plan(parse_cards('3 Example Card'),[],products)[0]['selected']['id'],'other')
        self.assertEqual(plan(parse_cards('3 Example Card'),[],products,choices={'0':'other'})[0]['status'],'Insufficient stock')

    def test_inventory_validation(self):
        for price in ['NaN','-1','Infinity','1.234']:
            with self.assertRaises(ValueError):
                stock(f'Example Card,Riftbound,manual,https://www.gamekeeperverdun.com/card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,,,,,{price},4\n')
        with self.assertRaises(ValueError):
            inventory(HEADER + ('Example Card,Riftbound,manual,https://www.gamekeeperverdun.com/card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,,,,,1,4\n'*2))
        self.assertFalse(store_url('https://evil.example/card'))
        self.assertFalse(store_url('https://www.gamekeeperverdun.com/cart'))

    def test_exports_unresolved_and_formula_safety(self):
        rows=plan(parse_cards('Missing\n=HYPERLINK("bad")'),[],[])
        exported=list(csv.DictReader(io.StringIO(export_csv(rows))))
        self.assertEqual(len(exported),2)
        self.assertEqual(exported[0]['available'],'')
        self.assertTrue(any(row['name'].startswith("'=") for row in exported))
        self.assertTrue(all('Unresolved' in row['status'] for row in exported))

class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=HTTPServer(('127.0.0.1',0),Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def test_page_and_end_to_end_plan(self):
        with urllib.request.urlopen(self.base) as response:
            self.assertIn(b'Riftbound singles planner',response.read())
        req=urllib.request.Request(self.base+'/api/plan',data=json.dumps({'deck':'3 Example Card\nMissing','inventory':HEADER+'Example Card,Riftbound,manual,https://www.gamekeeperverdun.com/card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,,,,,2.50,4\n'}).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req) as response:
            result=json.load(response)
        self.assertEqual(result['rows'][0]['subtotal'],'7.50')
        self.assertIn('Missing',result['csv'])
        self.assertIn('imported inventory',result['live_status'])

    def test_cross_origin_rejected(self):
        req=urllib.request.Request(self.base+'/api/plan',data=b'{}',headers={'Content-Type':'application/json','Origin':'https://evil.example'})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code,403)

if __name__=='__main__':
    unittest.main()
