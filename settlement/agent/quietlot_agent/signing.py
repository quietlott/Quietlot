"""EIP-712 helpers. The principal signs; the agent never holds the key.

Requires: pip install eth-account
"""
from __future__ import annotations

from .models import Mandate

DOMAIN_NAME = "Quietlot"
DOMAIN_VERSION = "1"


def typed_data(m: Mandate, chain_id: int, verifying_contract: str) -> dict:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Mandate": [
                {"name": "trader", "type": "address"},
                {"name": "base", "type": "address"},
                {"name": "quote", "type": "address"},
                {"name": "qty", "type": "uint256"},
                {"name": "limit", "type": "uint256"},
                {"name": "expiry", "type": "uint256"},
                {"name": "nonce", "type": "uint256"},
                {"name": "isSeller", "type": "bool"},
                {"name": "agreedGross", "type": "uint256"},
                {"name": "transcriptHash", "type": "bytes32"},
            ],
        },
        "primaryType": "Mandate",
        "domain": {
            "name": DOMAIN_NAME,
            "version": DOMAIN_VERSION,
            "chainId": chain_id,
            "verifyingContract": verifying_contract,
        },
        "message": {
            "trader": m.trader,
            "base": m.base,
            "quote": m.quote,
            "qty": m.qty,
            "limit": m.limit,
            "expiry": m.expiry,
            "nonce": m.nonce,
            "isSeller": m.is_seller,
            "agreedGross": m.agreed_gross,
            "transcriptHash": m.transcript_hash,
        },
    }


def sign_mandate(m: Mandate, private_key: str, chain_id: int, verifying_contract: str) -> str:
    """Run by the principal's own wallet, not by the agent process."""
    if m.agreed_gross <= 0:
        raise ValueError("agreed_gross must be set before signing")
    if not (m.transcript_hash.startswith("0x") and len(m.transcript_hash) == 66):
        raise ValueError("transcript_hash must be a 32-byte hex digest")
    from eth_account import Account
    from eth_account.messages import encode_typed_data

    signed = Account.sign_message(
        encode_typed_data(full_message=typed_data(m, chain_id, verifying_contract)),
        private_key=private_key,
    )
    return "0x" + signed.signature.hex().removeprefix("0x")
