// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title QuietlotSettlement
/// @notice Atomic ERC-20 settlement for OTC trades negotiated off-chain.
/// Both principals sign an EIP-712 mandate that includes the agreed gross quote and the
/// digest of the negotiation transcript. Anyone may relay the settlement, but the relayer
/// cannot choose the price or the transcript: both signatures must commit to the same values.
/// The relayer never holds funds: tokens move directly between the principals' wallets.
/// @dev UNAUDITED. Do not deploy to mainnet with real funds before an independent audit.
contract QuietlotSettlement {
    struct Mandate {
        address trader;
        address base;     // asset being sold by the seller
        address quote;    // asset used to pay
        uint256 qty;      // base units of `base`
        uint256 limit;    // seller: minimum NET quote to receive; buyer: maximum GROSS quote to pay
        uint256 expiry;   // unix timestamp
        uint256 nonce;    // per-trader replay / cancellation handle
        bool isSeller;
        uint256 agreedGross;   // gross quote both principals agreed to, in quote units
        bytes32 transcriptHash; // digest of the off-chain negotiation transcript
    }

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address trader,address base,address quote,uint256 qty,uint256 limit,uint256 expiry,uint256 nonce,bool isSeller,uint256 agreedGross,bytes32 transcriptHash)"
    );
    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    uint256 public constant STANDARD_FEE_BPS = 20;
    uint256 public constant DISCOUNT_FEE_BPS = 10;
    uint256 public constant FEE_CAP_BPS = 50;      // immutable ceiling, enforced in code
    uint256 private constant BPS = 10_000;
    // secp256k1 n/2, used to reject malleable high-s signatures
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable owner;
    address public immutable treasury;
    IERC20 public immutable discountToken;   // $INTP
    uint256 public immutable discountThreshold;

    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    uint256 private _locked = 1;

    event Settled(
        address indexed seller,
        address indexed buyer,
        address base,
        address quote,
        uint256 qty,
        uint256 grossQuote,
        uint256 fee,
        bytes32 transcriptHash
    );
    event Cancelled(address indexed trader, uint256 nonce);

    error Unauthorized();
    error Reentrancy();
    error Expired();
    error BadSignature();
    error NonceUsed();
    error Mismatch();
    error AboveBuyerLimit();
    error BelowSellerFloor();
    error ZeroTreasury();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address treasury_, address discountToken_, uint256 discountThreshold_) {
        owner = msg.sender;
        if (treasury_ == address(0)) revert ZeroTreasury();
        treasury = treasury_;
        discountToken = IERC20(discountToken_);
        discountThreshold = discountThreshold_;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256("Quietlot"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    function hashMandate(Mandate calldata m) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            MANDATE_TYPEHASH,
            m.trader, m.base, m.quote, m.qty, m.limit, m.expiry, m.nonce, m.isSeller,
            m.agreedGross, m.transcriptHash
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Fee in bps for a seller. Holders of the discount token above the threshold pay less.
    function feeBpsFor(address seller) public view returns (uint256) {
        if (address(discountToken) != address(0) && discountToken.balanceOf(seller) >= discountThreshold) {
            return DISCOUNT_FEE_BPS;
        }
        return STANDARD_FEE_BPS;
    }

    /// @notice Cancel one of your own mandates before it is settled.
    function cancel(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }

    /// @notice Settle a matched pair. The price and transcript come from the signed mandates,
    /// not from the caller, so the relayer cannot change either.
    function settle(
        Mandate calldata sell,
        bytes calldata sellSig,
        Mandate calldata buy,
        bytes calldata buySig
    ) external nonReentrant {
        _validate(sell, sellSig, buy, buySig);
        _transfer(sell, buy);
    }

    /// @dev All checks and the nonce updates. Runs before any token movement.
    function _validate(
        Mandate calldata sell,
        bytes calldata sellSig,
        Mandate calldata buy,
        bytes calldata buySig
    ) internal {
        if (!sell.isSeller || buy.isSeller) revert Mismatch();
        if (sell.base != buy.base || sell.quote != buy.quote || sell.qty != buy.qty) revert Mismatch();
        if (sell.trader == buy.trader) revert Mismatch();
        // Both principals must commit to the same agreed price and the same transcript.
        if (sell.agreedGross != buy.agreedGross || sell.transcriptHash != buy.transcriptHash) revert Mismatch();
        if (sell.agreedGross == 0) revert Mismatch();
        if (block.timestamp > sell.expiry || block.timestamp > buy.expiry) revert Expired();

        // A zero trader is never a valid principal. _recover returns address(0) on a bad
        // signature, so this check also stops an invalid signature from matching a zero trader.
        if (sell.trader == address(0) || buy.trader == address(0)) revert BadSignature();
        if (_recover(hashMandate(sell), sellSig) != sell.trader) revert BadSignature();
        if (_recover(hashMandate(buy), buySig) != buy.trader) revert BadSignature();

        if (nonceUsed[sell.trader][sell.nonce] || nonceUsed[buy.trader][buy.nonce]) revert NonceUsed();
        nonceUsed[sell.trader][sell.nonce] = true;
        nonceUsed[buy.trader][buy.nonce] = true;

        if (sell.agreedGross > buy.limit) revert AboveBuyerLimit();
        uint256 net = sell.agreedGross - _fee(sell.trader, sell.agreedGross);
        if (net < sell.limit) revert BelowSellerFloor();
    }

    /// @dev Token movement and the Settled event. Assumes _validate passed.
    function _transfer(Mandate calldata sell, Mandate calldata buy) internal {
        uint256 grossQuote = sell.agreedGross;
        uint256 fee = _fee(sell.trader, grossQuote);
        uint256 net = grossQuote - fee;

        // Emit before the external token calls, so the log order matches the settlement order
        // even if a token misbehaves. A revert below rolls the event back too.
        emit Settled(sell.trader, buy.trader, sell.base, sell.quote, sell.qty, grossQuote, fee, sell.transcriptHash);

        require(IERC20(sell.base).transferFrom(sell.trader, buy.trader, sell.qty), "base transfer failed");
        require(IERC20(sell.quote).transferFrom(buy.trader, sell.trader, net), "quote transfer failed");
        if (fee > 0) {
            require(IERC20(sell.quote).transferFrom(buy.trader, treasury, fee), "fee transfer failed");
        }
    }

    /// @dev Fee for a seller's trade at `gross`, capped at FEE_CAP_BPS.
    function _fee(address seller, uint256 gross) internal view returns (uint256 fee) {
        fee = (gross * feeBpsFor(seller)) / BPS;
        uint256 cap = (gross * FEE_CAP_BPS) / BPS;
        if (fee > cap) fee = cap;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > HALF_N) return address(0);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
