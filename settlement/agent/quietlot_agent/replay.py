"""Replayable negotiation transcripts.

The concession rule, in integer base units:
  * The seller opens at the buyer's gross cap, and the buyer opens at the
    smallest gross that still meets the seller's net floor.
  * Each round the agents propose the midpoint, and each side concedes toward it.
    The gap closes roughly by half per round.
  * The deal settles at the first round where the gap is within `tol`.
    If the round limit runs out first, nobody trades.

Anyone holding both mandates, limits included, can recompute the transcript and
check it. Replay therefore serves the two principals or an auditor they
authorise. It is not a public log: publishing limits would defeat the privacy goal.
"""
from __future__ import annotations

from dataclasses import dataclass

from .models import Mandate
from .negotiator import STANDARD_FEE_BPS, feasible_range, fee_for

TOL = 1  # base units; the agents settle once bid and ask are this close


@dataclass(frozen=True)
class Step:
    round: int
    seller_ask: int
    buyer_bid: int
    offer: int          # gross quote for this round (the settlement price on the last step)
    within_limits: bool # offer respects the seller's net floor and the buyer's cap


def _within(offer: int, seller: Mandate, buyer: Mandate, fee_bps: int) -> bool:
    net = offer - fee_for(offer, fee_bps)
    return net >= seller.limit and offer <= buyer.limit


def transcript(
    seller: Mandate,
    buyer: Mandate,
    max_rounds: int = 16,
    fee_bps: int = STANDARD_FEE_BPS,
    tol: int = TOL,
) -> tuple[list[Step], int | None]:
    """Return (steps, agreed_gross).

    Proposal steps come first. A settlement step, whose offer is the agreed price,
    is appended only when the agents agree. agreed_gross is None when nobody trades.
    """
    rng = feasible_range(seller, buyer, fee_bps)
    if rng is None:
        return [], None
    lo, hi = rng

    def clamp(x: int) -> int:
        return max(lo, min(hi, x))

    steps: list[Step] = []
    ask, bid = hi, lo
    for r in range(1, max_rounds + 2):
        mid = clamp((ask + bid) // 2)
        if ask - bid <= tol:
            steps.append(Step(r, ask, bid, mid, _within(mid, seller, buyer, fee_bps)))
            return steps, mid
        if r > max_rounds:
            break
        steps.append(Step(r, ask, bid, mid, _within(mid, seller, buyer, fee_bps)))
        gap = ask - bid
        ask -= (gap + 3) // 4   # seller concedes, rounded up so the gap always closes
        bid += gap // 4         # buyer concedes, rounded down so the two never cross
    return steps, None


def verify(
    seller: Mandate,
    buyer: Mandate,
    steps: list[Step],
    agreed_gross: int | None,
    max_rounds: int = 16,
    fee_bps: int = STANDARD_FEE_BPS,
) -> bool:
    """True only if the recorded transcript is exactly what the rule produces."""
    expected_steps, expected_gross = transcript(seller, buyer, max_rounds, fee_bps)
    if list(steps) != expected_steps or agreed_gross != expected_gross:
        return False
    return all(s.within_limits for s in steps)


DIGEST_PREFIX = b"quietlot/transcript/v1"


def transcript_digest(steps: list[Step], agreed_gross: int | None) -> bytes:
    """32-byte keccak digest of a transcript, passed to settle() and logged on-chain.

    Every field is encoded as a 32-byte big-endian word, so the digest does not
    depend on Python or JSON formatting. Anyone holding the transcript can recompute
    it and compare it with the transcriptHash in the Settled event. The contract
    stores the digest but does not check it, so a matching digest only proves the
    transcript was recorded at settlement, not that it followed the rule.
    """
    from eth_utils import keccak

    buf = bytearray(DIGEST_PREFIX)
    buf += len(steps).to_bytes(32, "big")
    for s in steps:
        buf += s.round.to_bytes(32, "big")
        buf += s.seller_ask.to_bytes(32, "big")
        buf += s.buyer_bid.to_bytes(32, "big")
        buf += s.offer.to_bytes(32, "big")
        buf += (b"\x01" if s.within_limits else b"\x00").rjust(32, b"\x00")
    if agreed_gross is None:
        buf += (0).to_bytes(32, "big") + (0).to_bytes(32, "big")
    else:
        buf += (1).to_bytes(32, "big") + agreed_gross.to_bytes(32, "big")
    return keccak(bytes(buf))
