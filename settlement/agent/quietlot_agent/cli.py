"""Match and negotiate mandates from a JSON file. Read-only: this never signs or sends transactions.

Usage:
    python -m quietlot_agent.cli mandates.json
"""
from __future__ import annotations

import json
import sys
import time

from .matcher import pair_mandates
from .models import Mandate
from .negotiator import negotiate


def load_mandates(path: str) -> list[Mandate]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    out = []
    for r in raw:
        out.append(
            Mandate(
                trader=r["trader"],
                base=r["base"],
                quote=r["quote"],
                qty=int(r["qty"]),
                limit=int(r["limit"]),
                expiry=int(r["expiry"]),
                nonce=int(r["nonce"]),
                is_seller=bool(r["is_seller"]),
                agreed_gross=int(r.get("agreed_gross", 0)),
                transcript_hash=r.get("transcript_hash", "0x" + "00" * 32),
            )
        )
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    now = int(time.time())
    mandates = load_mandates(argv[1])
    pairs = pair_mandates(mandates, now)
    if not pairs:
        print("No compatible pairs.")
        return 0
    for seller, buyer in pairs:
        result = negotiate(seller, buyer, now)
        if result.agreed:
            p = result.agreed
            print(json.dumps({
                "seller": p.seller.trader,
                "buyer": p.buyer.trader,
                "gross_quote": p.gross_quote,
                "fee": p.fee,
                "net_to_seller": p.net_to_seller,
                "rounds": result.rounds_used,
                "next_step": "Both principals sign the mandates in their own wallets, then a relayer calls settle().",
            }, indent=2))
        else:
            print(f"No deal for {seller.trader} / {buyer.trader}: {result.reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
