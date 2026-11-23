// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// NOT YET COMPILED OR RUN. Foundry was not available in the build environment.
// Run locally with:
//   forge install foundry-rs/forge-std --no-commit
//   forge test -vv
// If forge reports errors, fix them before trusting any result from this file.

import {Test} from "forge-std/Test.sol";
import {QuietlotSettlement} from "../src/QuietlotSettlement.sol";
import {MockERC20} from "./MockERC20.sol";

contract QuietlotSettlementTest is Test {
    QuietlotSettlement internal settle;
    MockERC20 internal base;
    MockERC20 internal quote;

    address internal treasury = address(0x7111);
    uint256 internal constant SELLER_PK = 0xA11CE;
    uint256 internal constant BUYER_PK = 0xB0B;
    address internal seller;
    address internal buyer;
    bytes32 internal constant TH = keccak256("transcript-test");

    function setUp() public {
        seller = vm.addr(SELLER_PK);
        buyer = vm.addr(BUYER_PK);
        settle = new QuietlotSettlement(treasury, address(0), 0);
        base = new MockERC20("BASE");
        quote = new MockERC20("QUOTE");

        base.mint(seller, 1e30);
        quote.mint(buyer, 1e30);
        vm.prank(seller);
        base.approve(address(settle), type(uint256).max);
        vm.prank(buyer);
        quote.approve(address(settle), type(uint256).max);
    }

    function _mandate(
        address trader,
        bool isSeller,
        uint256 nonce,
        uint256 gross,
        uint256 limit,
        bytes32 th
    ) internal view returns (QuietlotSettlement.Mandate memory m) {
        m = QuietlotSettlement.Mandate({
            trader: trader,
            base: address(base),
            quote: address(quote),
            qty: 1000,
            limit: limit,
            expiry: block.timestamp + 3600,
            nonce: nonce,
            isSeller: isSeller,
            agreedGross: gross,
            transcriptHash: th
        });
    }

    function _sign(uint256 pk, QuietlotSettlement.Mandate memory m) internal view returns (bytes memory) {
        bytes32 digest = settle.hashMandate(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_happyPath_movesTokensAndFee() public {
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 1, 100_000, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 1, 100_000, 100_000, TH);
        settle.settle(sm, _sign(SELLER_PK, sm), bm, _sign(BUYER_PK, bm));

        uint256 fee = 100_000 * 20 / 10_000;
        assertEq(base.balanceOf(buyer), 1000);
        assertEq(quote.balanceOf(seller), 100_000 - fee);
        assertEq(quote.balanceOf(treasury), fee);
    }

    /// Fee is exactly the standard rate for any gross amount that fits the buyer's limit.
    function testFuzz_feeIsStandardRate(uint128 gross) public {
        vm.assume(gross >= 10_000 && gross <= 1e24);
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 2, gross, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 2, gross, gross, TH);
        settle.settle(sm, _sign(SELLER_PK, sm), bm, _sign(BUYER_PK, bm));

        uint256 fee = uint256(gross) * 20 / 10_000;
        assertEq(quote.balanceOf(treasury), fee);
        assertEq(quote.balanceOf(seller), uint256(gross) - fee);
    }

    /// Agreed gross above the buyer's cap always reverts, for any amount.
    function testFuzz_revertsAboveBuyerCap(uint128 cap, uint128 extra) public {
        vm.assume(cap > 0 && extra > 0);
        uint256 gross = uint256(cap) + extra;
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 3, gross, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 3, gross, cap, TH);
        bytes memory ss = _sign(SELLER_PK, sm);
        bytes memory bs = _sign(BUYER_PK, bm);
        vm.expectRevert(QuietlotSettlement.AboveBuyerLimit.selector);
        settle.settle(sm, ss, bm, bs);
    }

    function test_revertsWhenMandatesNamePriceDifferently() public {
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 4, 1000, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 4, 1100, 1100, TH);
        bytes memory ss = _sign(SELLER_PK, sm);
        bytes memory bs = _sign(BUYER_PK, bm);
        vm.expectRevert(QuietlotSettlement.Mismatch.selector);
        settle.settle(sm, ss, bm, bs);
    }

    function test_revertsWhenMandatesNameTranscriptDifferently() public {
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 5, 1000, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 5, 1000, 1000, keccak256("other"));
        bytes memory ss = _sign(SELLER_PK, sm);
        bytes memory bs = _sign(BUYER_PK, bm);
        vm.expectRevert(QuietlotSettlement.Mismatch.selector);
        settle.settle(sm, ss, bm, bs);
    }

    function test_revertsOnReplay() public {
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 6, 1000, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 6, 1000, 1000, TH);
        bytes memory ss = _sign(SELLER_PK, sm);
        bytes memory bs = _sign(BUYER_PK, bm);
        settle.settle(sm, ss, bm, bs);
        vm.expectRevert(QuietlotSettlement.NonceUsed.selector);
        settle.settle(sm, ss, bm, bs);
    }

    function test_revertsOnZeroTraderWithJunkSignature() public {
        QuietlotSettlement.Mandate memory sm = _mandate(address(0), true, 7, 1000, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 7, 1000, 1000, TH);
        bytes memory junk = new bytes(65);
        bytes memory bs = _sign(BUYER_PK, bm);
        vm.expectRevert(QuietlotSettlement.BadSignature.selector);
        settle.settle(sm, junk, bm, bs);
    }

    /// A signature with high s (the malleable twin of a valid one) must be rejected.
    function test_revertsOnHighSMalleableSignature() public {
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 9, 1000, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 9, 1000, 1000, TH);
        bytes memory bs = _sign(BUYER_PK, bm);

        bytes32 digest = settle.hashMandate(sm);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SELLER_PK, digest);
        uint256 highS = n - uint256(s);
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, bytes32(highS), flippedV);

        vm.expectRevert(QuietlotSettlement.BadSignature.selector);
        settle.settle(sm, malleable, bm, bs);
    }

    function testFuzz_revertsOnAnyHighS(uint256 seedS) public {
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        uint256 halfN = n / 2;
        // Any s above n/2 is malleable and must be rejected.
        uint256 s = halfN + 1 + (seedS % (n - halfN - 1));
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 10, 1000, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 10, 1000, 1000, TH);
        bytes memory bs = _sign(BUYER_PK, bm);

        (uint8 v, bytes32 r, ) = vm.sign(SELLER_PK, settle.hashMandate(sm));
        bytes memory bad = abi.encodePacked(r, bytes32(s), v);

        vm.expectRevert(QuietlotSettlement.BadSignature.selector);
        settle.settle(sm, bad, bm, bs);
    }

    function test_constructorRejectsZeroTreasury() public {
        vm.expectRevert(QuietlotSettlement.ZeroTreasury.selector);
        new QuietlotSettlement(address(0), address(0), 0);
    }

    function test_revertsOnZeroAgreedGross() public {
        QuietlotSettlement.Mandate memory sm = _mandate(seller, true, 8, 0, 1, TH);
        QuietlotSettlement.Mandate memory bm = _mandate(buyer, false, 8, 0, 0, TH);
        bytes memory ss = _sign(SELLER_PK, sm);
        bytes memory bs = _sign(BUYER_PK, bm);
        vm.expectRevert(QuietlotSettlement.Mismatch.selector);
        settle.settle(sm, ss, bm, bs);
    }
}
