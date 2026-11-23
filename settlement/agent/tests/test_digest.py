import unittest

from quietlot_agent.models import Mandate
from quietlot_agent.replay import Step, transcript, transcript_digest

BASE = "0x" + "a" * 40
QUOTE = "0x" + "b" * 40


def mandate(trader, limit, is_seller):
    return Mandate(trader, BASE, QUOTE, 1_000_000, limit, 10**12, 1, is_seller)


class DigestTests(unittest.TestCase):
    def setUp(self):
        seller = mandate("0x" + "1" * 40, 100_000, True)
        buyer = mandate("0x" + "2" * 40, 110_000, False)
        self.steps, self.gross = transcript(seller, buyer)
        self.assertIsNotNone(self.gross)

    def test_digest_is_32_bytes_and_deterministic(self):
        d1 = transcript_digest(self.steps, self.gross)
        d2 = transcript_digest(list(self.steps), self.gross)
        self.assertEqual(len(d1), 32)
        self.assertEqual(d1, d2)

    def test_changing_one_step_changes_digest(self):
        base = transcript_digest(self.steps, self.gross)
        s = self.steps[0]
        tweaked = [Step(s.round, s.seller_ask + 1, s.buyer_bid, s.offer, s.within_limits)] + self.steps[1:]
        self.assertNotEqual(base, transcript_digest(tweaked, self.gross))

    def test_no_trade_differs_from_trade(self):
        self.assertNotEqual(transcript_digest(self.steps, self.gross), transcript_digest(self.steps, None))

    def test_different_agreed_price_changes_digest(self):
        self.assertNotEqual(transcript_digest(self.steps, self.gross), transcript_digest(self.steps, self.gross + 1))


if __name__ == "__main__":
    unittest.main()
