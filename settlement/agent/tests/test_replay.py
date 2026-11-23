import random
import unittest

from quietlot_agent.models import Mandate
from quietlot_agent.negotiator import negotiate
from quietlot_agent.replay import Step, transcript, verify

BASE = "0x" + "a" * 40
QUOTE = "0x" + "b" * 40
FAR_FUTURE = 10**12


def mandate(trader, limit, is_seller, qty=1_000_000):
    return Mandate(trader, BASE, QUOTE, qty, limit, FAR_FUTURE, 1, is_seller)


class ReplayTests(unittest.TestCase):
    def test_transcript_matches_negotiate_outcome(self):
        rng = random.Random(7)
        checked = 0
        for _ in range(300):
            seller = mandate("0x" + "1" * 40, rng.randint(90_000, 110_000), True)
            buyer = mandate("0x" + "2" * 40, rng.randint(90_000, 120_000), False)
            rounds = rng.randint(12, 24)
            steps, gross = transcript(seller, buyer, rounds)
            result = negotiate(seller, buyer, now=0, max_rounds=rounds)
            if result.agreed is None:
                self.assertIsNone(gross)
            else:
                self.assertEqual(gross, result.agreed.gross_quote)
                checked += 1
            self.assertTrue(all(s.within_limits for s in steps))
        self.assertGreater(checked, 150)

    def test_verify_accepts_honest_transcript(self):
        seller = mandate("0x" + "1" * 40, 100_000, True)
        buyer = mandate("0x" + "2" * 40, 106_000, False)
        steps, gross = transcript(seller, buyer, 16)
        self.assertIsNotNone(gross)
        self.assertTrue(verify(seller, buyer, steps, gross, 16))

    def test_verify_rejects_altered_offer(self):
        seller = mandate("0x" + "1" * 40, 100_000, True)
        buyer = mandate("0x" + "2" * 40, 106_000, False)
        steps, gross = transcript(seller, buyer, 16)
        tampered = list(steps)
        first = tampered[0]
        tampered[0] = Step(first.round, first.seller_ask, first.buyer_bid, first.offer + 500, first.within_limits)
        self.assertFalse(verify(seller, buyer, tampered, gross, 16))

    def test_verify_rejects_wrong_outcome(self):
        seller = mandate("0x" + "1" * 40, 100_000, True)
        buyer = mandate("0x" + "2" * 40, 106_000, False)
        steps, gross = transcript(seller, buyer, 16)
        self.assertFalse(verify(seller, buyer, steps, gross + 1, 16))

    def test_too_few_rounds_means_no_trade(self):
        seller = mandate("0x" + "1" * 40, 100_000, True)
        buyer = mandate("0x" + "2" * 40, 106_000, False)
        steps, gross = transcript(seller, buyer, 3)
        self.assertIsNone(gross)
        self.assertEqual(len(steps), 3)

    def test_no_overlap_gives_empty_transcript(self):
        seller = mandate("0x" + "1" * 40, 108_000, True)
        buyer = mandate("0x" + "2" * 40, 106_000, False)
        self.assertEqual(transcript(seller, buyer, 16), ([], None))


if __name__ == "__main__":
    unittest.main()
