import unittest
from riftbound.core import parse_cards, plan
from riftbound.deck_report import build, card_name, collector_stem

class DeckReportTests(unittest.TestCase):
    def test_rifty_headers_preserve_counts_and_code(self):
        cards=parse_cards('code,name,count\nOGN-135,Pakaa Cub,2\n',True)
        self.assertEqual(cards[0]['quantity'],2)
        self.assertEqual(cards[0]['collector_number'],'OGN-135')
    def test_rifty_source_code_can_choose_reprint_but_explicit_collector_cannot(self):
        from test_planner import stock
        products=stock()
        cards=parse_cards('code,name,count\nOGN-999,Example Card,1\n',True)
        result=plan(cards,[],products)[0]
        self.assertIsNotNone(result['selected'])
        self.assertIn('source set code unverified',result['status'])
        self.assertIsNone(plan(parse_cards('Example Card {OGN-999}'),[],products)[0]['selected'])

    def test_full_name_only_and_number_stems(self):
        self.assertEqual(card_name('Ahri, Inquisitive'),card_name('Ahri - Inquisitive (Alternate Art)'))
        self.assertNotEqual(card_name('Ahri, Inquisitive'),card_name('Ahri - Alluring'))
        self.assertEqual(collector_stem('066a/298'),collector_stem('066'))
        self.assertEqual(collector_stem('R03b'),collector_stem('R03'))
        self.assertNotEqual(collector_stem('R03'),collector_stem('003'))
    def test_split_cheapest_stock_and_keep_unresolved(self):
        def product(vid,stock,price):
            return dict(variant_id=vid,stock=stock,price_cad=price,name='Ahri - Inquisitive',collector_number='119/298',version='Epic',finish='',condition='New',url='https://www.gamekeeperverdun.com/catalog/origins/ahri/'+vid,checked_at='2026-01-01T00:00:00Z')
        rows,lots=build([dict(code='OGN-119',name='Ahri, Inquisitive',count='4'),dict(code='RAD-001',name='Missing',count='2')],[product('1','2','1.50'),product('2','1','2.00')])
        self.assertEqual(rows[0]['planned'],3);self.assertEqual(rows[0]['shortfall'],1)
        self.assertEqual(rows[0]['subtotal_cad'],'5.00');self.assertEqual(len(lots),2)
        self.assertEqual(rows[1]['shortfall'],2)
        self.assertIn('set prefix not independently verified',rows[0]['review'])
    def test_unknown_stock_does_not_become_out_of_stock(self):
        row=dict(variant_id='1',stock='',price_cad='1.00',name='Example',collector_number='1/219',url='https://www.gamekeeperverdun.com/catalog/origins/example/1')
        result,_=build([dict(code='RAD-001',name='Example',count='1')],[row])
        self.assertIn('Unknown',result[0]['status'])

if __name__=='__main__':unittest.main()
