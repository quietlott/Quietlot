"""Hash commitments to limits.

A principal commits to a limit before negotiation starts:
    commitment = keccak256(limit as uint256 big-endian || salt)
The commitment can be published. Nothing about the limit is revealed.
At settlement the principal opens it by publishing (limit, salt). Anyone can
then check that the limit was fixed before the negotiation ran, and that the
recorded transcript follows from it.

This binds the limit. It does not hide a limit that is later revealed, and it
does not let outsiders check the negotiation before settlement.
"""
from __future__ import annotations

import secrets

from eth_utils import keccak

from .models import Mandate
from .replay import verify


def new_salt() -> bytes:
    return secrets.token_bytes(32)


def commit(limit: int, salt: bytes) -> bytes:
    if len(salt) != 32:
        raise ValueError("salt must be 32 bytes")
    if not 0 <= limit < 2**256:
        raise ValueError("limit out of range")
    return keccak(limit.to_bytes(32, "big") + salt)


def opens(commitment: bytes, limit: int, salt: bytes) -> bool:
    try:
        return commit(limit, salt) == commitment
    except ValueError:
        return False


def verify_opened(
    seller: Mandate,
    buyer: Mandate,
    seller_commitment: bytes,
    buyer_commitment: bytes,
    seller_salt: bytes,
    buyer_salt: bytes,
    steps,
    agreed_gross: int | None,
    max_rounds: int = 16,
    fee_bps: int | None = None,
) -> bool:
    """Check the openings against the commitments, then replay the transcript."""
    if not opens(seller_commitment, seller.limit, seller_salt):
        return False
    if not opens(buyer_commitment, buyer.limit, buyer_salt):
        return False
    kwargs = {} if fee_bps is None else {"fee_bps": fee_bps}
    return verify(seller, buyer, steps, agreed_gross, max_rounds, **kwargs)
