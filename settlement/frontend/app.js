// Quietlot prototype UI. Uses ethers v6 (UMD) and the ABI from abi.js.
// All user-supplied text is written with textContent, never innerHTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { provider: null, signer: null, account: null, lastSigned: null };

  const setStatus = (el, msg, cls = '') => {
    el.textContent = msg;
    el.className = 'status ' + cls;
  };
  const isAddr = (a) => /^0x[a-fA-F0-9]{40}$/.test(a || '');
  const toBig = (s) => {
    if (!/^\d+$/.test((s || '').trim())) throw new Error('Use whole numbers in base units, no decimals.');
    return BigInt(s.trim());
  };

  // EIP-712 types must match QuietlotSettlement.sol exactly.
  const TYPES = {
    Mandate: [
      { name: 'trader', type: 'address' }, { name: 'base', type: 'address' }, { name: 'quote', type: 'address' },
      { name: 'qty', type: 'uint256' }, { name: 'limit', type: 'uint256' }, { name: 'expiry', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'isSeller', type: 'bool' },
      { name: 'agreedGross', type: 'uint256' }, { name: 'transcriptHash', type: 'bytes32' },
    ],
  };

  function domain() {
    return {
      name: 'Quietlot',
      version: '1',
      chainId: Number($('chainId').value),
      verifyingContract: $('contract').value.trim(),
    };
  }

  function contractRead() {
    const c = $('contract').value.trim();
    if (!isAddr(c)) throw new Error('Enter the settlement contract address first.');
    return new ethers.Contract(c, window.QUIETLOT_ABI, state.provider);
  }
  function contractWrite() {
    const c = $('contract').value.trim();
    if (!isAddr(c)) throw new Error('Enter the settlement contract address first.');
    return new ethers.Contract(c, window.QUIETLOT_ABI, state.signer);
  }

  function refreshButtons() {
    const ready = !!state.signer;
    $('sign').disabled = !ready;
    $('cancelNonce').disabled = !ready || !state.lastSigned;
    $('approve').disabled = !ready;
    $('settle').disabled = !ready;
  }

  // ---- 1. Wallet ----
  $('connect').addEventListener('click', async () => {
    try {
      if (!window.ethereum) throw new Error('No injected wallet found (e.g. MetaMask).');
      const rpc = $('rpc').value.trim();
      const chainId = Number($('chainId').value);
      if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('Invalid chain ID.');

      const browser = new ethers.BrowserProvider(window.ethereum);
      await browser.send('eth_requestAccounts', []);
      const net = await browser.getNetwork();
      if (Number(net.chainId) !== chainId) {
        if (!rpc) throw new Error('Wallet is on a different chain. Enter the RPC URL so it can be added.');
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: '0x' + chainId.toString(16), rpcUrls: [rpc], chainName: 'Quietlot target chain' }],
        });
      }
      state.provider = new ethers.BrowserProvider(window.ethereum);
      state.signer = await state.provider.getSigner();
      state.account = await state.signer.getAddress();
      $('account').textContent = 'Connected: ' + state.account;
      refreshButtons();
    } catch (e) {
      $('account').textContent = 'Error: ' + e.message;
    }
  });

  // ---- 2. Sign a mandate ----
  $('role').addEventListener('change', () => {
    $('limitLabel').firstChild.textContent = $('role').value === 'seller'
      ? 'Limit (min net quote, quote units)'
      : 'Limit (max gross quote, quote units)';
  });

  $('sign').addEventListener('click', async () => {
    const st = $('signStatus');
    try {
      const isSeller = $('role').value === 'seller';
      const base = $('base').value.trim();
      const quote = $('quote').value.trim();
      if (!isAddr(base) || !isAddr(quote)) throw new Error('Enter valid base and quote token addresses.');
      if (base.toLowerCase() === quote.toLowerCase()) throw new Error('Base and quote must differ.');
      const qty = toBig($('qty').value);
      const limit = toBig($('limit').value);
      if (qty === 0n || limit === 0n) throw new Error('Quantity and limit must be positive.');
      const ttl = Number($('ttl').value);
      if (!(ttl > 0)) throw new Error('Validity must be at least 1 minute.');
      // Both principals sign the agreed price and the transcript digest, so the relayer cannot change them.
      const agreed = toBig($('agreed').value);
      if (agreed === 0n) throw new Error('Agreed gross quote must be positive.');
      const digest = $('digest').value.trim();
      if (!/^0x[a-fA-F0-9]{64}$/.test(digest)) throw new Error('Transcript digest must be 0x followed by 64 hex characters.');

      const now = Math.floor(Date.now() / 1000);
      const mandate = {
        trader: state.account,
        base, quote,
        qty: qty.toString(),
        limit: limit.toString(),
        expiry: (now + ttl * 60).toString(),
        // Random 64-bit nonce so mandates are unique per signature.
        nonce: BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')).toString(),
        isSeller,
        agreedGross: agreed.toString(),
        transcriptHash: digest.toLowerCase(),
      };

      setStatus(st, 'Waiting for wallet signature...');
      const sig = await state.signer.signTypedData(domain(), TYPES, {
        ...mandate,
        qty, limit, expiry: BigInt(mandate.expiry), nonce: BigInt(mandate.nonce),
        agreedGross: agreed,
      });
      const signed = { mandate, signature: sig, domain: domain() };
      state.lastSigned = signed;
      $('signedOut').value = JSON.stringify(signed, null, 2);
      setStatus(st, 'Mandate signed. Share the JSON above, not your limit separately.', 'ok');
      refreshButtons();
    } catch (e) {
      setStatus(st, e.message, 'bad');
    }
  });

  // ---- Cancel ----
  $('cancelNonce').addEventListener('click', async () => {
    const st = $('signStatus');
    try {
      if (!state.lastSigned) throw new Error('Nothing to cancel.');
      const c = contractWrite();
      setStatus(st, 'Sending cancel transaction...');
      const tx = await c.cancel(BigInt(state.lastSigned.mandate.nonce));
      await tx.wait();
      setStatus(st, 'Cancelled on-chain. The mandate can no longer settle.', 'ok');
    } catch (e) {
      setStatus(st, e.message, 'bad');
    }
  });

  // ---- 3. Settle ----
  function parseSigned(text, label) {
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error(label + ': invalid JSON.'); }
    if (!obj.mandate || !obj.signature) throw new Error(label + ': missing mandate or signature.');
    const m = obj.mandate;
    return {
      mandate: {
        trader: m.trader, base: m.base, quote: m.quote,
        qty: BigInt(m.qty), limit: BigInt(m.limit), expiry: BigInt(m.expiry),
        nonce: BigInt(m.nonce), isSeller: !!m.isSeller,
        agreedGross: BigInt(m.agreedGross), transcriptHash: m.transcriptHash,
      },
      signature: obj.signature,
    };
  }

  async function currentFeeBps(sellerAddr) {
    return Number(await contractRead().feeBpsFor(sellerAddr));
  }

  async function refreshFeePreview() {
    try {
      const s = parseSigned($('sellerIn').value, 'Seller');
      const gross = s.mandate.agreedGross;
      const bps = await currentFeeBps(s.mandate.trader);
      const fee = (gross * BigInt(bps)) / 10000n;
      $('feePreview').textContent = `Fee ${fee} (${bps} bps). Seller nets ${gross - fee}.`;
    } catch {
      $('feePreview').textContent = '';
    }
  }
  $('sellerIn').addEventListener('input', refreshFeePreview);

  $('approve').addEventListener('click', async () => {
    const st = $('settleStatus');
    try {
      const s = parseSigned($('sellerIn').value, 'Seller');
      const b = parseSigned($('buyerIn').value, 'Buyer');
      const contract = $('contract').value.trim();
      if (!state.account) throw new Error('Connect your wallet first.');
      const me = state.account.toLowerCase();
      const need = [];
      if (s.mandate.trader.toLowerCase() === me) need.push({ token: s.mandate.base, amount: s.mandate.qty });
      if (b.mandate.trader.toLowerCase() === me) need.push({ token: b.mandate.quote, amount: b.mandate.agreedGross });
      if (need.length === 0) throw new Error('Your wallet is neither the seller nor the buyer in these mandates.');
      for (const { token, amount } of need) {
        const erc = new ethers.Contract(token, window.ERC20_ABI, state.signer);
        const tx = await erc.approve(contract, amount);
        setStatus(st, 'Approving ' + token + '...');
        await tx.wait();
      }
      setStatus(st, 'Approvals confirmed. You can settle now.', 'ok');
    } catch (e) {
      setStatus(st, e.message, 'bad');
    }
  });

  // Transcript digest. Must match transcript_digest() in agent/quietlot_agent/replay.py:
  // keccak256 over the prefix "quietlot/transcript/v1" followed by 32-byte big-endian words:
  // step count, then per step (round, seller_ask, buyer_bid, offer, within_limits as 0/1),
  // then the agreed-gross marker (1) and the gross quote.
  const DIGEST_PREFIX = 'quietlot/transcript/v1';
  const word = (v) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

  function parseTranscript(text) {
    let steps;
    try { steps = JSON.parse(text); } catch { throw new Error('Transcript: invalid JSON.'); }
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('Transcript: expected a non-empty array of steps.');
    return steps.map((s, i) => {
      const fields = ['round', 'seller_ask', 'buyer_bid', 'offer'];
      for (const f of fields) {
        if (s[f] === undefined || s[f] === null) throw new Error(`Transcript step ${i + 1}: missing ${f}.`);
        const v = BigInt(s[f]);
        if (v < 0n) throw new Error(`Transcript step ${i + 1}: ${f} must not be negative.`);
      }
      if (typeof s.within_limits !== 'boolean') throw new Error(`Transcript step ${i + 1}: within_limits must be true or false.`);
      return {
        round: BigInt(s.round), seller_ask: BigInt(s.seller_ask), buyer_bid: BigInt(s.buyer_bid),
        offer: BigInt(s.offer), within_limits: s.within_limits,
      };
    });
  }

  function digestOf(steps, gross) {
    const parts = [ethers.toUtf8Bytes(DIGEST_PREFIX), word(BigInt(steps.length))];
    for (const s of steps) {
      parts.push(word(s.round), word(s.seller_ask), word(s.buyer_bid), word(s.offer), word(s.within_limits ? 1n : 0n));
    }
    parts.push(word(1n), word(gross));
    return ethers.keccak256(ethers.concat(parts));
  }

  $('settle').addEventListener('click', async () => {
    const st = $('settleStatus');
    try {
      const s = parseSigned($('sellerIn').value, 'Seller');
      const b = parseSigned($('buyerIn').value, 'Buyer');
      if (s.mandate.agreedGross !== b.mandate.agreedGross) throw new Error('The two mandates name different prices.');
      if (s.mandate.transcriptHash.toLowerCase() !== b.mandate.transcriptHash.toLowerCase()) throw new Error('The two mandates name different transcripts.');
      const c = contractWrite();
      setStatus(st, 'Sending settlement transaction...');
      const tx = await c.settle(s.mandate, s.signature, b.mandate, b.signature);
      const rcpt = await tx.wait();
      setStatus(st, 'Settled in tx ' + rcpt.hash, 'ok');
    } catch (e) {
      setStatus(st, 'Settlement failed: ' + (e.shortMessage || e.message), 'bad');
    }
  });

  function updateDigest() {
    const out = $('digestOut');
    try {
      const digest = digestOf(parseTranscript($('transcriptIn').value), toBig($('verifyGross').value));
      out.textContent = 'Transcript digest: ' + digest;
    } catch (e) {
      out.textContent = e.message;
    }
  }
  $('transcriptIn').addEventListener('input', updateDigest);
  $('verifyGross').addEventListener('input', updateDigest);

  $('verify').addEventListener('click', async () => {
    const st = $('verifyStatus');
    try {
      const txHash = $('verifyTx').value.trim();
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('Enter a transaction hash (0x + 64 hex characters).');
      const gross = toBig($('verifyGross').value);
      const digest = digestOf(parseTranscript($('transcriptIn').value), gross);
      const settlement = $('contract').value.trim();
      if (!isAddr(settlement)) throw new Error('Enter the settlement contract address in the connection section.');
      if (!state.provider) throw new Error('Connect a wallet or set the RPC first.');

      setStatus(st, 'Reading the transaction...');
      const rcpt = await state.provider.getTransactionReceipt(txHash);
      if (!rcpt) throw new Error('Transaction not found on this chain.');
      const iface = new ethers.Interface(window.QUIETLOT_ABI);
      let settled = null;
      for (const log of rcpt.logs) {
        if (log.address.toLowerCase() !== settlement.toLowerCase()) continue;
        let parsed = null;
        try { parsed = iface.parseLog(log); } catch { parsed = null; }
        if (parsed && parsed.name === 'Settled') { settled = parsed.args; break; }
      }
      if (!settled) throw new Error('No Settled event from this contract in that transaction.');

      const digestMatch = settled.transcriptHash.toLowerCase() === digest.toLowerCase();
      const grossMatch = settled.grossQuote === gross;
      const summary = `seller ${settled.seller}, buyer ${settled.buyer}, qty ${settled.qty}, gross ${settled.grossQuote}, fee ${settled.fee}`;
      if (digestMatch && grossMatch) {
        setStatus(st, 'Match. The transcript is the one recorded for this settlement. ' + summary, 'ok');
      } else {
        const why = [];
        if (!digestMatch) why.push(`digest differs (on-chain ${settled.transcriptHash}, computed ${digest})`);
        if (!grossMatch) why.push(`gross differs (on-chain ${settled.grossQuote})`);
        setStatus(st, 'No match: ' + why.join('; ') + '. ' + summary, 'bad');
      }
    } catch (e) {
      setStatus(st, 'Verification failed: ' + (e.shortMessage || e.message), 'bad');
    }
  });

  refreshButtons();
})();
