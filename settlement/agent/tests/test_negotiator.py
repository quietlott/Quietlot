import unittest

from quietlot_agent.matcher import pair_mandates
from quietlot_agent.models import Mandate
from quietlot_agent.negotiator import fee_for, feasible_range, negotiate

BASE = "0x" + "11" * 20
QUOTE = "0x" + "22" * 20
NOW = 1_800_000_000


def m(trader, is_seller, limit, qty=1_000_000, expiry=NOW + 3600, nonce=1):
    return Mandate(trader, BASE, QUOTE, qty, limit, expiry, nonce, is_seller)


class NegotiatorTests(unittest.TestCase):
    def test_net_floor_is_respected(self):
        seller = m("0xS", True, limit=99_000)
        buyer = m("0xB", False, limit=100_000)
        res = negotiate(seller, buyer, NOW)
        self.assertIsNotNone(res.agreed)
        p = res.agreed
        self.assertGreaterEqual(p.net_to_seller, seller.limit)
        self.assertLessEqual(p.gross_quote, buyer.limit)
        self.assertEqual(p.gross_quote - p.fee, p.net_to_seller)

    def test_no_overlap_refused(self):
        seller = m("0xS", True, limit=200_000)
        buyer = m("0xB", False, limit=100_000)
        res = negotiate(seller, buyer, NOW)
        self.assertIsNone(res.agreed)
        self.assertEqual(res.reason, "no overlap between limits")

    def test_self_match_refused(self):
        res = negotiate(m("0xA", True, 1000), m("0xa", False, 2000), NOW)
        self.assertIsNone(res.agreed)
        self.assertEqual(res.reason, "self-match refused")

    def test_expired_refused(self):
        res = negotiate(m("0xS", True, 1000, expiry=NOW - 1), m("0xB", False, 2000), NOW)
        self.assertEqual(res.reason, "expired mandate")

    def test_fee_is_capped(self):
        self.assertEqual(fee_for(10_000, 500), 10_000 * 50 // 10_000)

    def test_feasible_range_floor_holds_after_rounding(self):
        seller = m("0xS", True, limit=1_000)
        buyer = m("0xB", False, limit=5_000)
        lo, hi = feasible_range(seller, buyer)
        self.assertGreaterEqual(lo - fee_for(lo), seller.limit)
        self.assertLessEqual(hi, buyer.limit)

    def test_matcher_no_self_and_no_reuse(self):
        s1 = m("0xS", True, 1000, nonce=1)
        b_self = m("0xS", False, 2000, nonce=2)
        b_ok = m("0xB", False, 2000, nonce=3)
        pairs = pair_mandates([s1, b_self, b_ok], NOW)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0][1].trader, "0xB")


if __name__ == "__main__":
    unittest.main()
