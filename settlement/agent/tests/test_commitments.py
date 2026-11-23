import unittest

from quietlot_agent.commitments import commit, new_salt, opens, verify_opened
from quietlot_agent.models import Mandate
from quietlot_agent.replay import transcript

BASE = "0x" + "a" * 40
QUOTE = "0x" + "b" * 40


def mandate(trader, limit, is_seller):
    return Mandate(trader, BASE, QUOTE, 1_000_000, limit, 10**12, 1, is_seller)


class CommitmentTests(unittest.TestCase):
    def test_opening_with_right_limit_and_salt(self):
        salt = new_salt()
        c = commit(100_000, salt)
        self.assertTrue(opens(c, 100_000, salt))

    def test_wrong_limit_or_salt_fails(self):
        salt = new_salt()
        c = commit(100_000, salt)
        self.assertFalse(opens(c, 100_001, salt))
        self.assertFalse(opens(c, 100_000, new_salt()))

    def test_same_limit_different_salt_gives_different_commitment(self):
        self.assertNotEqual(commit(5, new_salt()), commit(5, new_salt()))

    def test_full_check_accepts_honest_opening(self):
        s_salt, b_salt = new_salt(), new_salt()
        seller = mandate("0x" + "1" * 40, 100_000, True)
        buyer = mandate("0x" + "2" * 40, 106_000, False)
        steps, gross = transcript(seller, buyer)
        ok = verify_opened(seller, buyer, commit(seller.limit, s_salt), commit(buyer.limit, b_salt),
                           s_salt, b_salt, steps, gross)
        self.assertTrue(ok)

    def test_full_check_rejects_limit_changed_after_commit(self):
        s_salt, b_salt = new_salt(), new_salt()
        seller = mandate("0x" + "1" * 40, 100_000, True)
        buyer = mandate("0x" + "2" * 40, 106_000, False)
        steps, gross = transcript(seller, buyer)
        moved_seller = mandate("0x" + "1" * 40, 101_000, True)
        ok = verify_opened(moved_seller, buyer, commit(seller.limit, s_salt), commit(buyer.limit, b_salt),
                           s_salt, b_salt, steps, gross)
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
