import unittest
from riftbound.bridge import handle
from test_planner import HEADER


def snapshot(stock='4', price='2.50'):
    return HEADER + f'Example Card,Riftbound,manual,https://www.gamekeeperverdun.com/card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,,,,,{price},{stock}\n'


def snapshot_rows(*rows):
    return HEADER + ''.join(
        f'{name},Riftbound,manual,{url},https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,,,,,{price},{stock}\n'
        for name, url, price, stock in rows
    )


class BridgeTests(unittest.TestCase):
    def test_validated_snapshot_and_split_comparison(self):
        self.assertEqual(handle({'operation': 'validate', 'csv': snapshot()})['records'], 1)
        result = handle({'operation': 'compare', 'csv': snapshot(), 'targets': [{'name': 'Example Card', 'count': 3, 'section': 'main'}]})
        self.assertEqual(result['planned'], 3)
        self.assertEqual(result['unfilled'], 0)
        self.assertEqual(result['subtotalCad'], '7.50')

    def test_unknown_stock_never_becomes_available_or_zero_stock(self):
        result = handle({'operation': 'compare', 'csv': snapshot(''), 'targets': [{'name': 'Example Card', 'count': 3}]})
        self.assertEqual(result['planned'], 0)
        self.assertEqual(result['unfilled'], 3)
        self.assertIn('unknown', result['rows'][0]['status'].lower())

    def test_invalid_or_empty_snapshots_rejected(self):
        for value in ['', snapshot().replace('Riftbound', 'Magic'), snapshot().replace('https://www.gamekeeperverdun.com/card', 'https://evil.example/card')]:
            with self.assertRaises(ValueError):
                handle({'operation': 'validate', 'csv': value})

    def test_finite_stock_is_shared_across_multiple_requests(self):
        result = handle({
            'operation': 'compare',
            'csv': snapshot('3'),
            'targets': [
                {'name': 'Example Card', 'count': 2, 'section': 'main'},
                {'name': 'Example Card', 'count': 2, 'section': 'sideboard'},
            ],
        })

        self.assertEqual([row['planned'] for row in result['rows']], [2, 1])
        self.assertEqual([row['shortfall'] for row in result['rows']], [0, 1])
        self.assertEqual([lot['quantity'] for lot in result['allocations']], [2, 1])
        self.assertEqual(result['planned'], 3)
        self.assertEqual(result['unfilled'], 1)
        self.assertEqual(result['subtotalCad'], '7.50')

    def test_missing_zero_and_unknown_stock_have_distinct_outcomes(self):
        inventory = snapshot_rows(
            ('Zero Stock Card', 'https://www.gamekeeperverdun.com/zero-card', '1.00', '0'),
            ('Unknown Stock Card', 'https://www.gamekeeperverdun.com/unknown-card', '1.00', ''),
        )
        result = handle({
            'operation': 'compare',
            'csv': inventory,
            'targets': [
                {'name': 'Missing Card', 'count': 1},
                {'name': 'Zero Stock Card', 'count': 1},
                {'name': 'Unknown Stock Card', 'count': 1},
            ],
        })

        missing, zero, unknown = result['rows']
        self.assertIn('No matching listing', missing['status'])
        self.assertEqual((missing['planned'], missing['shortfall']), (0, 1))
        self.assertIn('out of stock', zero['status'].lower())
        self.assertEqual((zero['planned'], zero['shortfall']), (0, 1))
        self.assertIn('unknown', unknown['status'].lower())
        self.assertEqual((unknown['planned'], unknown['shortfall']), (0, 1))

    def test_unsafe_product_listings_are_rejected(self):
        for bad_url in (
            'http://www.gamekeeperverdun.com/card',
            'https://evil.example/card',
            'https://www.gamekeeperverdun.com/cart',
        ):
            with self.subTest(url=bad_url):
                inventory = snapshot().replace('https://www.gamekeeperverdun.com/card', bad_url)
                with self.assertRaises(ValueError):
                    handle({'operation': 'compare', 'csv': inventory, 'targets': []})

    def test_allocations_do_not_invent_missing_store_variant_ids(self):
        result = handle({
            'operation': 'compare',
            'csv': snapshot('2'),
            'targets': [{'name': 'Example Card', 'count': 1}],
        })

        self.assertEqual(len(result['allocations']), 1)
        self.assertEqual(result['allocations'][0]['variant_id'], '')

    def test_malformed_targets_rejected(self):
        for targets in ('x', {'name': 'a'}, ['x'], [1], [{'name': 'Example Card', 'count': True}],
                        [{'name': 'Example Card', 'count': '3'}], [{'name': 'Example Card', 'count': 1.5}],
                        [{'name': 'Example Card', 'count': -1}], [{'name': 'Example Card'}]):
            with self.subTest(targets=targets):
                with self.assertRaises(ValueError):
                    handle({'operation': 'compare', 'csv': snapshot(), 'targets': targets})

    def test_main_reports_json_error_nonzero(self):
        import io, json, contextlib, sys
        from riftbound import bridge
        payload = json.dumps({'operation': 'compare', 'csv': snapshot(), 'targets': 'x'})
        out = io.StringIO()
        old = sys.stdin
        sys.stdin = io.StringIO(payload)
        try:
            with contextlib.redirect_stdout(out):
                code = bridge.main()
        finally:
            sys.stdin = old
        self.assertNotEqual(code, 0)
        self.assertIn('error', json.loads(out.getvalue()))


if __name__ == '__main__':
    unittest.main()
