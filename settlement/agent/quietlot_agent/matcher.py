"""Pair complementary mandates. Refuses self-matches, expired mandates and duplicate pairs."""
from __future__ import annotations

from .models import Mandate


def pair_mandates(mandates: list[Mandate], now: int) -> list[tuple[Mandate, Mandate]]:
    live = [m for m in mandates if m.expiry >= now]
    sellers = [m for m in live if m.is_seller]
    buyers = [m for m in live if not m.is_seller]

    pairs: list[tuple[Mandate, Mandate]] = []
    used_sellers: set[tuple[str, int]] = set()
    used_buyers: set[tuple[str, int]] = set()

    for s in sellers:
        s_key = (s.trader.lower(), s.nonce)
        if s_key in used_sellers:
            continue
        for b in buyers:
            b_key = (b.trader.lower(), b.nonce)
            if b_key in used_buyers:
                continue
            if s.trader.lower() == b.trader.lower():
                continue  # no self-matching
            if (s.base, s.quote, s.qty) != (b.base, b.quote, b.qty):
                continue
            pairs.append((s, b))
            used_sellers.add(s_key)
            used_buyers.add(b_key)
            break
    return pairs
