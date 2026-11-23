# Quietlot settlement: audit scope and notes

Status: UNAUDITED prototype. Testnet only. Do not use with real funds until an independent audit is complete and its findings are resolved.

## 1. What is in scope

| Item | Path | Notes |
|---|---|---|
| Settlement contract | `contracts/src/QuietlotSettlement.sol` | Solidity 0.8.24. Single contract, no proxy, no upgrade path. |
| Test token (tests only) | `contracts/src/MockERC20.sol` | Not for production. |
| Compile pipeline | `contracts-tooling/compile.js` | solc-js, EVM target `paris`. |
| Off-chain transcript digest | `agent/quietlot_agent/replay.py` (`transcript_digest`) | Must match the frontend digest. |
| Mandate signing | `agent/quietlot_agent/signing.py` | EIP-712 types must match the contract. |
| Frontend | `frontend/app.js`, `frontend/abi.js` | Signs mandates, calls settle, computes and verifies the transcript digest. |

Out of scope for this prototype: the negotiation agent's strategy, the matcher, and the commitments scheme beyond the transcript hash.

## 2. Deployment

- Current testnet address (current version, with signed price and transcript): `0xdD29ca1ed33970d7019598E6a477B16b45aB27D7`.
- Network: Robinhood Chain testnet, chain ID 46630.
- Current deploy tx: `0xeaf08f876b03c7dc27f77f28f68e03b61294ab45c9098c85d027d9e7e4b5a6d2`.
- Current end-to-end test: `npm run trade-test` against the address above returned PASS. Balances matched: buyer 1000 base, seller 499 quote, treasury fee 1 quote. Settle tx hash: `0xe58a39352a5341f0e4b0c9a852255b3ebdec8eddae6cb42f005982f63ad767c5`. Receipt status verified as success (`0x1`) against the testnet RPC.
- Previous address (old version, no signed price or transcript, zero-address gap in finding A): `0x61d735EE5300f4695a34747654A442C348B7428C`. Do not use it.
- Previous deploy tx: `0x564a38450fcb914601cb2cd4be2f76798f9e6031033e052202c94a319f5723de`.
- Constructor: treasury `0x96b8415BDF4ceb4b0a8c1ef69CF2d775261e87FD`, discount token zero address, threshold 0.
- Mainnet (chain ID 4663) deploy, unaudited: address `0x61d735EE5300f4695a34747654A442C348B7428C`, deploy tx `0x74ca2a55d231231507ac5dafcc59fed892854f602a6c8c775d90343c54f9007c`, deployed 2026-11-23 12:10 UTC from `artifacts.json` built 18:15 local time (the current version). Deployer and treasury are both `0x96b8415BDF4ceb4b0a8c1ef69CF2d775261e87FD`.
- Note: the mainnet address equals the old testnet address above. The likely cause is the same deployer at the same nonce on a different chain, which gives the same CREATE address. That makes them separate contracts, though this is not yet confirmed. The "do not use" label applies to the testnet instance only. Bytecode on mainnet still needs to be checked on the explorer against `artifacts.json`.
- Current mainnet deploy (chain ID 4663), unaudited, with the $QLT fee discount: address `0xDDd679f005764138282b37C2B44Ca730FF6961e3`, deploy tx `0xb79cb8ca8b257e39e2ffd0e5323e1710559406f4e86bc422e72da87880d538cc`. Constructor: treasury `0x96b8415BDF4ceb4b0a8c1ef69CF2d775261e87FD`, discount token $QLT `0x4CD7d02382988703bA625cb9E705B8DF9798A5Fa` (18 decimals), threshold 1,000,000 QLT (`1000000000000000000000000`). Source differs from the first mainnet build only in one comment (`$INTP` renamed to `$QLT`); ABI and logic are unchanged and the EVM tests pass 14/14.
- The first mainnet contract `0x61d735EE5300f4695a34747654A442C348B7428C` has no discount token. It still exists on-chain and cannot be removed, but it is superseded and no longer promoted.
- Previous test settlement tx: `0x88506ce1fd932db3afe284431a40df98b1e6beba19bdf2cc1ca48c6dcabffe73`.

## 3. Intended behaviour (what the code is meant to guarantee)

1. A settlement needs one seller mandate (`isSeller = true`) and one buyer mandate (`isSeller = false`).
2. Both mandates name the same base token, quote token and quantity, and have different traders.
3. Both mandates are unexpired at `block.timestamp`.
4. Both mandates name the same `agreedGross` and the same `transcriptHash`, and `agreedGross` is positive.
5. Both EIP-712 signatures recover to the named trader and must not be the zero address. The domain is `Quietlot`, version `1`, the current chain ID and the contract address.
6. Each (trader, nonce) pair is used at most once. A trader can cancel a nonce.
7. The agreed gross is at most the buyer's limit.
8. Fee = gross × bps / 10,000, where bps is 20 by default, 10 for holders above the discount threshold, and capped at 50.
9. The net quote (gross minus fee) is at least the seller's limit.
10. Base moves seller → buyer, net quote moves buyer → seller, and the fee moves buyer → treasury.
11. Reentrancy is blocked by a lock on `settle`.

## 4. Findings and changes

**A. Zero-address trader could pass the signature check. Fixed in the current version.**
`_recover` returns `address(0)` on an invalid signature. Earlier code compared that result with `trader`, so a zero-address trader with a bad signature would pass. The current `_validate` rejects a zero trader before the comparison. The EVM suite has a test for this case.

**B. The price was not bound by the signatures. Fixed in the current version.**
Earlier, `grossQuote` was a parameter of `settle`, so the relayer could choose any price between the buyer's cap and the seller's floor. The current version puts `agreedGross` and `transcriptHash` into the EIP-712 mandate. `settle` takes no price or transcript argument, and it requires both mandates to match. Each principal signs the agreed outcome.

**C. The transcript hash was not bound. Fixed in the current version.**
`transcriptHash` is now part of both signed mandates. It is also still emitted in the `Settled` event. The contract does not check that the transcript follows the rules. A matching digest proves that the transcript was recorded for that trade, not that its steps were valid.

**D. Token assumptions. Open.**
Settlement assumes standard ERC-20 behaviour: no fee-on-transfer, no rebasing, and `transferFrom` returns `true` or reverts. `require` wraps each transfer. Non-standard tokens are not supported and should be listed as such.

**E. Nonce and cancellation model. Open.**
Settlement marks both nonces as used. There are no partial fills. A trader can cancel a nonce with `cancel(nonce)`. Check that this matches the intended UX.

**F. Discount logic. Open.**
`feeBpsFor` reads `balanceOf(seller)` in the discount token at settlement time. A seller can acquire the token just before settling. Confirm this is acceptable.

**G. Owner and treasury. Open.**
`owner` is set in the constructor and is not used for any privileged action in this version. `treasury` is immutable. Confirm there are no hidden admin paths.

**H. Stack depth. Note.**
`settle` was split into `_validate` and `_transfer` to compile without `viaIR`. Review the split for ordering: all checks run before any transfer.

**I. Fee cap is unreachable with current rates. Note.**
The standard rate is 20 bps and the discount rate is 10 bps. The cap is 50 bps, so the `fee > cap` branch in `_fee` never runs with the current constants. It is kept as a guard in case the rates change. Auditor: confirm the guard is still correct if the constants are ever raised above 50.

**Accepted positions for open items D to G (approved by the team):**
- D: Accept only standard ERC-20 tokens. Document this in the user-facing material. Do not list fee-on-transfer or rebasing tokens.
- E: Keep the current nonce model. Cancel affects only the trader's own nonce, which matches the one-mandate-per-nonce design.
- F: The discount is checked at settlement time. Accept this for the prototype, and decide before mainnet whether the check should use a snapshot or a lock period.
- G: `owner` has no privileges in this version. Remove it if no admin function is planned, or document the single exception if one is added later.

## 4a. Static analysis results (Slither and forge lint)

Run before the two low-severity fixes below. Slither: 7 results, all reviewed. Forge lint: 3 warnings, the same items as the first two rows. Both low items are now fixed in the source, but the testnet contract `0xdD29…27D7` predates the fix and needs redeployment to reflect it. Rerun Slither after the redeploy build to confirm the detectors are clear.

| Source | Detector | Location | Assessment |
|---|---|---|---|
| Slither, forge lint | arbitrary-send-erc20 | `_transfer`, `transferFrom` calls | False positive. Each `from` is a trader whose EIP-712 signature was verified in `_validate` before any transfer. Accepted. |
| Slither | missing-zero-check | constructor, `treasury_` | Fixed in the current version: the constructor reverts with `ZeroTreasury` if treasury is zero. `discountToken` zero is intentional. Covered by a Foundry test. |
| forge lint | reentrancy-events | `Settled` emit after transfers | Fixed in the current version: the event is emitted before the token calls. A revert in a transfer rolls the event back too. |
| Slither | timestamp | `_validate`, expiry comparison | Accepted. Expiry is an intended use of block time. |
| Slither | assembly | `_recover`, inline calldata reads | Accepted. Standard pattern for reading an ECDSA signature. |
| Slither | cyclomatic-complexity | `_validate` (13) | Informational. Accepted. |

## 5. Test status (current version)

- Contract tests: 14 of 14 pass on `@ethereumjs/evm` (`contracts-tooling/test/run-settlement-evm.js`). This covers the price and transcript binding, the zero-address case, and the existing tests. Foundry suite at `contracts/test/QuietlotSettlement.t.sol`: 11 of 11 pass (`forge test -vv`, fuzz tests at 256 runs each). Includes the high-s malleability tests (one fixed, one fuzzed) and the zero-treasury constructor check.
- Agent tests: 22 of 22 pass (`python3 -m unittest discover -s tests -t .`), including four digest tests.
- EIP-712 parity: the Python `typed_data` digest and ethers `TypedDataEncoder` produce the same digest for the same mandate.
- Digest parity: the JavaScript and Python transcript digests match on a sample transcript.
- Live testnet: the current version passed `trade-test` at `0xdD29ca1ed33970d7019598E6a477B16b45aB27D7`.

## 6. Recommended next steps before audit

1. Done: the settle receipt status is `0x1` for the hash in section 2.
2. Add fuzz tests for signature malleability. The Foundry suite already passes 8 of 8, but the fee cap is still untested because the current default rate never reaches it.
3. Resolve open items D to G, or document them as accepted limitations.
4. Send this file, the commit hash, and the test results to the auditor.
