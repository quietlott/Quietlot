// Settlement checks run on @ethereumjs/evm in-process (no ganache).
// Run: node test/run-settlement-evm.js   (exit code 0 = all passed)
const { createEVM } = require('@ethereumjs/evm');
const { createCustomCommon, Mainnet } = require('@ethereumjs/common');
const { Address, hexToBytes, createZeroAddress } = require('@ethereumjs/util');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const art = JSON.parse(fs.readFileSync(path.join(__dirname, '../artifacts.json'), 'utf8'));
const CHAIN_ID = 4663;
const NOW = 1_700_000_000n;
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];
const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const MAX = ethers.MaxUint256;
const TH = ethers.id('transcript-digest-test');

const types = { Mandate: [
  { name: 'trader', type: 'address' }, { name: 'base', type: 'address' }, { name: 'quote', type: 'address' },
  { name: 'qty', type: 'uint256' }, { name: 'limit', type: 'uint256' }, { name: 'expiry', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'isSeller', type: 'bool' },
  { name: 'agreedGross', type: 'uint256' }, { name: 'transcriptHash', type: 'bytes32' } ] };

const erc = new ethers.Interface(art.MockERC20.abi);
const settleIf = new ethers.Interface(art.QuietlotSettlement.abi);
const errNames = {};
for (const f of settleIf.fragments) if (f.type === 'error') errNames[ethers.id(f.format('sighash')).slice(0, 10)] = f.name;

const common = createCustomCommon({ name: 'robinhood-chain-test', chainId: CHAIN_ID, networkId: CHAIN_ID }, Mainnet);
const ZERO = createZeroAddress();
const toAddr = (h) => new Address(hexToBytes(h));

function block(ts) {
  return { header: {
    number: 1n, coinbase: ZERO, timestamp: ts, difficulty: 0n, prevRandao: new Uint8Array(32),
    gasLimit: 30_000_000n, baseFeePerGas: 0n, slotNumber: 0n, getBlobGasPrice: () => undefined,
  } };
}

let evm;
let lastLogs = [];
async function run(from, to, data, ts = NOW) {
  const opts = { block: block(ts), caller: toAddr(from), data: ethers.getBytes(data), gasLimit: 30_000_000n, skipBalance: true, origin: toAddr(from) };
  if (to) opts.to = toAddr(to);
  const r = await evm.runCall(opts);
  lastLogs = r.execResult.logs ?? [];
  return r;
}
async function deploy(artifact, args, from) {
  const iface = new ethers.Interface(artifact.abi);
  const data = artifact.bytecode + iface.encodeDeploy(args).slice(2);
  const r = await run(from, undefined, data);
  if (r.execResult.exceptionError) throw new Error('deploy failed: ' + r.execResult.exceptionError.error);
  return r.createdAddress.toString();
}
async function send(from, to, ifc, fn, args, ts = NOW) {
  const r = await run(from, to, ifc.encodeFunctionData(fn, args), ts);
  return r.execResult;
}
async function read(to, ifc, fn, args) {
  const r = await run('0x' + '0'.repeat(40), to, ifc.encodeFunctionData(fn, args));
  if (r.execResult.exceptionError) throw new Error(`read ${fn} failed`);
  return ifc.decodeFunctionResult(fn, ethers.hexlify(r.execResult.returnValue))[0];
}
function expectRevert(exec, name) {
  if (!exec.exceptionError) throw new Error(`expected revert ${name}, but call succeeded`);
  const sel = ethers.hexlify(exec.returnValue ?? new Uint8Array()).slice(0, 10);
  const got = errNames[sel] ?? `selector ${sel} (${exec.exceptionError.error})`;
  if (got !== name) throw new Error(`expected ${name}, got ${got}`);
  return 'reverted';
}
function settleLog() {
  const topic = settleIf.getEvent('Settled').topicHash;
  const log = lastLogs.find(l => ethers.hexlify(l[1][0]) === topic);
  if (!log) throw new Error('Settled event not emitted');
  return settleIf.parseLog({ topics: log[1].map(t => ethers.hexlify(t)), data: ethers.hexlify(log[2]) });
}
function mustPass(exec, what) {
  if (exec.exceptionError) throw new Error(`${what} failed: ${exec.exceptionError.error}`);
}

(async () => {
  evm = await createEVM({ common });
  const wallets = KEYS.map(k => new ethers.Wallet(k));
  const [owner, seller, buyer] = [wallets[0].address, wallets[1].address, wallets[2].address];
  const treasury = wallets[9].address;

  const base = await deploy(art.MockERC20, ['BASE'], owner);
  const quote = await deploy(art.MockERC20, ['QUOTE'], owner);
  const intp = await deploy(art.MockERC20, ['QLT'], owner);
  const settle = await deploy(art.QuietlotSettlement, [treasury, intp, 1000n], owner);
  const domain = { name: 'Quietlot', version: '1', chainId: CHAIN_ID, verifyingContract: settle };

  mustPass(await send(owner, base, erc, 'mint', [seller, 10_000_000n]), 'mint base');
  mustPass(await send(owner, quote, erc, 'mint', [buyer, 10_000_000n]), 'mint quote');
  mustPass(await send(seller, base, erc, 'approve', [settle, MAX]), 'approve base');
  mustPass(await send(buyer, quote, erc, 'approve', [settle, MAX]), 'approve quote');

  const settleC = { iface: settleIf };
  let nonce = 100n;
  // agreedGross and transcriptHash are part of the signed mandate.
  const mandate = (w, isSeller, o = {}) => ({
    trader: w.address, base, quote,
    qty: o.qty ?? 1000n, limit: o.limit ?? (isSeller ? 900n : 1000n),
    expiry: o.expiry ?? NOW + 3600n, nonce: o.nonce ?? nonce, isSeller,
    agreedGross: o.agreedGross ?? 1000n, transcriptHash: o.transcriptHash ?? TH,
  });
  const sign = (w, m) => w.signTypedData(domain, types, m);
  async function pair({ s = {}, b = {}, gross = 1000n, th = TH } = {}) {
    nonce += 1n;
    const sm = mandate(wallets[1], true, { nonce, agreedGross: gross, transcriptHash: th, ...s });
    const bm = mandate(wallets[2], false, { nonce, agreedGross: gross, transcriptHash: th, ...b });
    return { sm, bm, sSig: await sign(wallets[1], sm), bSig: await sign(wallets[2], bm) };
  }
  // Relayer call. The price and transcript come from the mandates, not from arguments.
  const settleCall = (from, sm, sSig, bm, bSig, ts) =>
    send(from, settle, settleC.iface, 'settle', [sm, sSig, bm, bSig], ts);

  const results = [];
  async function check(name, fn) {
    try { const info = await fn(); results.push(['PASS', name, info || '']); }
    catch (e) { results.push(['FAIL', name, String(e.message).slice(0, 300)]); }
  }

  await check('happy path: tokens move, fee to treasury, seller gets net', async () => {
    const gross = 100_000n, fee = gross * 20n / 10000n;
    const { sm, bm, sSig, bSig } = await pair({ gross, b: { limit: 100_000n }, s: { limit: 1n } });
    const sBefore = await read(quote, erc, 'balanceOf', [seller]);
    const tBefore = await read(quote, erc, 'balanceOf', [treasury]);
    const bBase = await read(base, erc, 'balanceOf', [buyer]);
    mustPass(await settleCall(owner, sm, sSig, bm, bSig), 'settle');
    const settled = settleLog();
    assert.equal(settled.args.transcriptHash, TH);
    assert.equal(settled.args.grossQuote, gross);
    assert.equal(settled.args.fee, fee);
    assert.equal(await read(quote, erc, 'balanceOf', [seller]), sBefore + gross - fee);
    assert.equal(await read(quote, erc, 'balanceOf', [treasury]), tBefore + fee);
    assert.equal(await read(base, erc, 'balanceOf', [buyer]), bBase + 1000n);
  });

  await check('reverts when agreed gross exceeds buyer limit', async () => {
    const { sm, bm, sSig, bSig } = await pair({ gross: 1001n, b: { limit: 1000n } });
    return expectRevert(await settleCall(owner, sm, sSig, bm, bSig), 'AboveBuyerLimit');
  });

  await check('reverts when net is below seller floor', async () => {
    // gross 1000, fee 2, net 998 < floor 999
    const { sm, bm, sSig, bSig } = await pair({ gross: 1000n, s: { limit: 999n } });
    return expectRevert(await settleCall(owner, sm, sSig, bm, bSig), 'BelowSellerFloor');
  });

  await check('reverts when the two mandates name different prices', async () => {
    nonce += 1n;
    const sm = mandate(wallets[1], true, { nonce, agreedGross: 1000n });
    const bm = mandate(wallets[2], false, { nonce, agreedGross: 1100n });
    return expectRevert(await settleCall(owner, sm, await sign(wallets[1], sm), bm, await sign(wallets[2], bm)), 'Mismatch');
  });

  await check('reverts when the two mandates name different transcripts', async () => {
    nonce += 1n;
    const sm = mandate(wallets[1], true, { nonce, transcriptHash: TH });
    const bm = mandate(wallets[2], false, { nonce, transcriptHash: ethers.id('other-transcript') });
    return expectRevert(await settleCall(owner, sm, await sign(wallets[1], sm), bm, await sign(wallets[2], bm)), 'Mismatch');
  });

  await check('reverts on zero agreed gross', async () => {
    nonce += 1n;
    const sm = mandate(wallets[1], true, { nonce, agreedGross: 0n });
    const bm = mandate(wallets[2], false, { nonce, agreedGross: 0n });
    return expectRevert(await settleCall(owner, sm, await sign(wallets[1], sm), bm, await sign(wallets[2], bm)), 'Mismatch');
  });

  await check('reverts on signature from wrong signer', async () => {
    const { sm, bm, bSig } = await pair();
    const bad = await sign(wallets[4], sm);
    return expectRevert(await settleCall(owner, sm, bad, bm, bSig), 'BadSignature');
  });

  await check('zero-address trader with an invalid signature is rejected', async () => {
    const { sm, bm, bSig } = await pair();
    const zeroSeller = { ...sm, trader: ethers.ZeroAddress };
    const junkSig = '0x' + '00'.repeat(65);
    return expectRevert(await settleCall(owner, zeroSeller, junkSig, bm, bSig), 'BadSignature');
  });

  await check('reverts on replay (nonce reuse)', async () => {
    const { sm, bm, sSig, bSig } = await pair({ b: { limit: 10_000n }, s: { limit: 1n } });
    mustPass(await settleCall(owner, sm, sSig, bm, bSig), 'first settle');
    return expectRevert(await settleCall(owner, sm, sSig, bm, bSig), 'NonceUsed');
  });

  await check('reverts on expired mandate', async () => {
    const { sm, bm, bSig } = await pair({ s: { expiry: NOW - 1n } });
    return expectRevert(await settleCall(owner, sm, await sign(wallets[1], sm), bm, bSig), 'Expired');
  });

  await check('cancel blocks settlement', async () => {
    const { sm, bm, sSig, bSig } = await pair();
    mustPass(await send(seller, settle, settleC.iface, 'cancel', [sm.nonce]), 'cancel');
    return expectRevert(await settleCall(owner, sm, sSig, bm, bSig), 'NonceUsed');
  });

  await check('reverts on self-trade', async () => {
    nonce += 1n;
    const sm = mandate(wallets[1], true, { nonce });
    const bm = mandate(wallets[1], false, { nonce: nonce + 1000n });
    return expectRevert(await settleCall(owner, sm, await sign(wallets[1], sm), bm, await sign(wallets[1], bm)), 'Mismatch');
  });

  await check('rejects high-s (malleable) signature', async () => {
    const { sm, bm, sSig, bSig } = await pair();
    const r = sSig.slice(0, 66);
    const sVal = BigInt('0x' + sSig.slice(66, 130));
    const v = sSig.slice(130, 132);
    const highS = N - sVal;
    assert.ok(highS > HALF_N, 'test setup: s must be low before flipping');
    const bad = '0x' + r.slice(2) + highS.toString(16).padStart(64, '0') + (v === '1b' ? '1c' : '1b');
    return expectRevert(await settleCall(owner, sm, bad, bm, bSig), 'BadSignature');
  });

  await check('discount token holders pay 10 bps', async () => {
    const gross = 100_000n;
    mustPass(await send(owner, intp, erc, 'mint', [seller, 1000n]), 'mint intp');
    assert.equal(await read(settle, settleC.iface, 'feeBpsFor', [seller]), 10n);
    const { sm, bm, sSig, bSig } = await pair({ gross, b: { limit: 10_000_000n }, s: { limit: 1n } });
    const tBefore = await read(quote, erc, 'balanceOf', [treasury]);
    mustPass(await settleCall(owner, sm, sSig, bm, bSig), 'settle');
    assert.equal(await read(quote, erc, 'balanceOf', [treasury]), tBefore + gross * 10n / 10000n);
  });

  let failed = 0;
  for (const [status, name, info] of results) {
    console.log(`${status}  ${name}${info && status === 'FAIL' ? '\n      ' + info : ''}`);
    if (status === 'FAIL') failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('SETUP ERROR', e.stack || e.message); process.exit(2); });
