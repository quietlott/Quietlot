"""Bounded negotiation between one seller and one buyer.

Deterministic by design: the agents never see each other's limits, and every
counteroffer is clamped to the feasible range before it is proposed.
"""
from __future__ import annotations

from .models import Mandate, NegotiationResult, Proposal

BPS = 10_000
STANDARD_FEE_BPS = 20
FEE_CAP_BPS = 50


def fee_for(gross: int, fee_bps: int = STANDARD_FEE_BPS) -> int:
    fee_bps = min(fee_bps, FEE_CAP_BPS)
    return gross * fee_bps // BPS


def feasible_range(seller: Mandate, buyer: Mandate, fee_bps: int = STANDARD_FEE_BPS) -> tuple[int, int] | None:
    """Return (lo, hi) for the gross quote both sides can accept, or None.

    The seller needs gross - fee(gross) >= seller.limit. Because the fee is
    floor-rounded, we search upward from the smallest gross that meets the floor
    rather than dividing, so rounding can never let a trade slip under it.
    """
    hi = buyer.limit
    # smallest gross such that net >= seller.limit
    lo = seller.limit
    while lo - fee_for(lo, fee_bps) < seller.limit:
        lo += 1
        if lo > hi:
            return None
    if lo > hi:
        return None
    return lo, hi


def negotiate(
    seller: Mandate,
    buyer: Mandate,
    now: int,
    max_rounds: int = 16,
    fee_bps: int = STANDARD_FEE_BPS,
) -> NegotiationResult:
    if not seller.is_seller or buyer.is_seller:
        return NegotiationResult(None, 0, "side mismatch")
    if seller.trader.lower() == buyer.trader.lower():
        return NegotiationResult(None, 0, "self-match refused")
    if seller.base != buyer.base or seller.quote != buyer.quote or seller.qty != buyer.qty:
        return NegotiationResult(None, 0, "pair or size mismatch")
    if now > seller.expiry or now > buyer.expiry:
        return NegotiationResult(None, 0, "expired mandate")
    if feasible_range(seller, buyer, fee_bps) is None:
        return NegotiationResult(None, 0, "no overlap between limits")

    # The rule lives in replay.transcript so that the recorded transcript and the
    # negotiated outcome cannot drift apart.
    from .replay import transcript

    steps, gross = transcript(seller, buyer, max_rounds, fee_bps)
    if gross is None:
        return NegotiationResult(None, len(steps), "no agreement within round limit")
    rounds_used = len(steps) - 1  # the last step is the settlement, not a proposal
    fee = fee_for(gross, fee_bps)
    return NegotiationResult(
        Proposal(seller, buyer, gross, fee, gross - fee, round_found=rounds_used),
        rounds_used,
        "agreed",
    )
