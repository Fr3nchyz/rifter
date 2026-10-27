from pathlib import Path
import unittest
from riftbound.store_html import extract
from riftbound.core import inventory, plan, parse_cards
import csv
import io

FIXTURE=Path(__file__).with_name('fixtures').joinpath('riftbound-category-excerpt.html').read_text()

class SavedHTMLTest(unittest.TestCase):
    def test_actual_saved_markup_and_layout_dedup(self):
        rows,report=extract(FIXTURE)
        self.assertEqual(len(rows),6)
        self.assertEqual(report['product_count'],6)
        self.assertEqual(rows[0]['name'],'Abandon')
        self.assertEqual((rows[0]['price_cad'],rows[0]['stock'],rows[0]['condition']),('0.99','4','New'))
        self.assertEqual((rows[1]['price_cad'],rows[1]['stock'],rows[1]['finish']),('5.99','0','Foil'))
        self.assertEqual(report['next_page'],'https://www.gamekeeperverdun.com/catalog/origins/3953?page=2&sort_by_price=0')
        self.assertIsNone(report['checked_at'])
        self.assertEqual(report['warnings'],[])

    def test_unusual_collectors_and_full_names_preserved(self):
        rows,_=extract(FIXTURE)
        self.assertEqual(rows[2]['collector_number'],'066a/298')
        self.assertEqual(rows[3]['collector_number'],'227*/221')
        self.assertEqual(rows[4]['collector_number'],'SP3/006')
        self.assertEqual(rows[4]['name'],'Ahri, Inquisitive')

    def test_other_game_and_unexpected_links_fail_closed(self):
        with self.assertRaises(ValueError): extract(FIXTURE.replace('data-category-id="3953"','data-category-id="8"'))
        with self.assertRaises(ValueError): extract(FIXTURE.replace('/catalog/origins/abandon__131219__uncommon/661497','/catalog/magic/abandon/661497'))
        with self.assertRaises(ValueError): extract('<h1>Server error</h1>')

    def test_dont_infer_stock_from_purchase_selector(self):
        rows,_=extract(FIXTURE.replace('4 En stock','Availability unknown'))
        self.assertEqual(rows[0]['stock'],'')
        self.assertEqual(rows[1]['stock'],'0')

    def test_observed_runes_tokens_and_unavailable_without_variant_id(self):
        source=Path(__file__).with_name('fixtures').joinpath('riftbound-special-formats.html').read_text()
        rows,report=extract(source)
        self.assertEqual(len(rows),4)
        unavailable=next(r for r in rows if r['variant_id'].startswith('unavailable-product-'))
        self.assertEqual(unavailable['stock'],'0')
        self.assertEqual(unavailable['price_cad'],'0.14')
        self.assertEqual(unavailable['collector_number'],'R04')
        self.assertTrue(any(r['name']=='Recruit (271) // Buff' and r['collector_number']=='' for r in rows))
        self.assertTrue(any(r['name']=='Buff' and r['version']=='Token' for r in rows))

    def test_csv_roundtrip_and_functional_planning(self):
        rows,_=extract(FIXTURE)
        output=io.StringIO();writer=csv.DictWriter(output,fieldnames=rows[0].keys())
        writer.writeheader();writer.writerows(rows)
        products,warnings=inventory(output.getvalue())
        self.assertEqual(len(products),6)
        self.assertFalse(warnings)
        result=plan(parse_cards('3 Abandon {131/219}'),[],products)[0]
        self.assertEqual(result['buy'],3)
        self.assertEqual(str(result['subtotal']),'2.97')
        self.assertIn('capture time unknown', result['selected']['verification'])

if __name__=='__main__': unittest.main()
