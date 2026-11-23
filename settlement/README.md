# Quietlot-style OTC negotiation (prototype)

An independent prototype of an on-chain OTC negotiation layer. Agents match
complementary mandates, negotiate a price inside each principal's private
limits, and prepare an atomic ERC-20 swap. This is not a copy of any existing
protocol.

**Unaudited. Do not use with real funds.**

## Layout

```
contracts/src/QuietlotSettlement.sol   settlement contract (EIP-712 mandates, net floor, fee tiers, cancel)
contracts/test/MockERC20.sol            test-only token
contracts-tooling/                      solc-js compile script + on-chain test harness (npm)
agent/quietlot_agent/                  off-chain matcher, negotiator, replayable transcripts, limit commitments, EIP-712 helpers, CLI
agent/tests/                            unit tests for the agent
frontend/                               static page: connect wallet, sign mandates, settle, cancel
```

## Status

| Part | State |
|---|---|
| Contract compiles | Yes, with solc 0.8.26, `evmVersion: paris`, no warnings (`node contracts-tooling/compile.js`) |
| Contract on-chain tests | 10/10 pass (`cd contracts-tooling && node test/run-settlement-evm.js`). Runs the compiled contract in-process on `@ethereumjs/evm`, with chain ID 4663. The earlier ganache harness was removed because it hung in this sandbox. A Foundry suite is still the planned long-term choice. |
| Agent unit tests | 22/22 pass (`cd agent && python3 -m unittest discover -s tests -t .`) |
| Frontend | Written. Syntax-checked, and element IDs cross-checked. **Not run in a browser.** |

## Security warnings

- Unaudited. Do not deploy to mainnet with real funds before an independent audit.
- Agents never hold keys. Principals sign mandates in their own wallets.
- The signature check is ECDSA only. Smart-contract wallets are not supported.
- Fee-on-transfer and rebasing tokens are not handled. Use standard ERC-20s only.
- The negotiator uses a fixed concession rule: each round the gap closes by about half, and the deal settles once the gap is within 1 base unit. It is deterministic and easy to audit, but it is not a tuned trading strategy.
- The round limit is a configuration choice. The default is 16, which covers gaps up to roughly 60,000 base units. Too few rounds means no trade, which is the intended behaviour.
- Replay (`agent/quietlot_agent/replay.py`) recomputes a transcript from both mandates. That needs the limits, so only the two principals, or an auditor they authorise, can run it. It is not a public log. A public check would need a commitment scheme, which is not built yet.
- Limit commitments (`agent/quietlot_agent/commitments.py`) let a principal publish `keccak256(limit || salt)` before negotiating. At settlement the principal opens it, and anyone can check that the limit was fixed in advance and that the transcript follows from it. This binds the limit. It does not let outsiders check the negotiation before settlement.
- The commitment code needs `eth-utils` with a keccak backend, for example `pip install "eth-hash[pycryptodome]" eth-utils`.
- Transcripts are not stored on-chain. Instead, `settle()` takes a `transcriptHash` (from `transcript_digest` in `replay.py`) and emits it in the `Settled` event. An auditor holding the transcript can recompute the digest and match it to the trade. The contract does not check the digest, so a match proves only that this transcript was recorded for this trade, not that it followed the rule. Full transcripts are not shown in the frontend yet.
- The frontend ships no RPC endpoint. Enter the official one for the chain yourself.
- Limits are private only until a mandate is shared. Once signed, the mandate JSON is shared with the counterparty, and the limit inside it is visible.

## Next steps before any real use

1. Install Foundry and port the contract tests to `forge test`, including replay, expiry, wrong signer, net floor, fee cap, reentrancy, and high-s.
2. Fix or replace the ganache harness so the tests run in CI.
3. Deploy to a testnet and run an end-to-end trade with two test wallets. `contracts-tooling/scripts/deploy.js` is ready. It reads `RPC_URL`, `PRIVATE_KEY`, and `TREASURY` from the environment and refuses to run unless the chain ID is 4663.
4. Independent audit.
5. Relayer service, monitoring, and a real UI test pass.

## Run the agent CLI

```bash
cd agent
python3 -m quietlot_agent.cli mandates.json
```

`mandates.json` is a list of objects with `trader, base, quote, qty, limit, expiry, nonce, is_seller`. The CLI only prints proposals. It never signs or sends transactions.

## Run the frontend

Serve the `frontend/` folder with any static server, for example `python3 -m http.server 8080`, then open it in a browser with a wallet extension. Fill in the RPC URL, chain ID, and deployed contract address.
