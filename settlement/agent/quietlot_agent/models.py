"""Mandate and proposal types. All amounts are integer base units; no floats."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class Mandate:
    trader: str          # 0x address of the principal
    base: str            # asset sold by the seller
    quote: str           # asset used to pay
    qty: int             # base units of `base`
    limit: int           # seller: min NET quote; buyer: max GROSS quote
    expiry: int          # unix seconds
    nonce: int
    is_seller: bool
    agreed_gross: int = 0                       # gross quote both principals agreed to, signed
    transcript_hash: str = "0x" + "00" * 32     # digest of the negotiation transcript, signed

    def __post_init__(self) -> None:
        if self.qty <= 0:
            raise ValueError("qty must be positive")
        if self.limit <= 0:
            raise ValueError("limit must be positive")
        if self.base.lower() == self.quote.lower():
            raise ValueError("base and quote must differ")


@dataclass(frozen=True)
class Proposal:
    seller: Mandate
    buyer: Mandate
    gross_quote: int     # total quote paid by buyer, before fee
    fee: int
    net_to_seller: int
    round_found: int = 0
    notes: list[str] = field(default_factory=list)


@dataclass
class NegotiationResult:
    agreed: Optional[Proposal]
    rounds_used: int
    reason: str
