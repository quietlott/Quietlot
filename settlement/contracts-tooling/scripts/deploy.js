// Deploy QuietlotSettlement to a live network.
// Secrets come from the environment only. Nothing is written to disk except the
// deployment record, which holds the public address and transaction hash.
//
//   RPC_URL=...  PRIVATE_KEY=...  TREASURY=0x...  \
//   DISCOUNT_TOKEN=0x...  DISCOUNT_THRESHOLD=0  node scripts/deploy.js
//
// Refuses to run unless the RPC reports chain ID 4663, unless ALLOW_OTHER_CHAIN=1.
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const EXPECTED_CHAIN_ID = 4663n;

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

(async () => {
  const rpc = need('RPC_URL');
  const provider = new ethers.JsonRpcProvider(rpc);
  const { chainId } = await provider.getNetwork();
  if (chainId !== EXPECTED_CHAIN_ID && process.env.ALLOW_OTHER_CHAIN !== '1') {
    throw new Error(`RPC reports chain ${chainId}, expected ${EXPECTED_CHAIN_ID}. Set ALLOW_OTHER_CHAIN=1 to override.`);
  }
  const wallet = new ethers.Wallet(need('PRIVATE_KEY'), provider);
  const treasury = ethers.getAddress(need('TREASURY'));
  const discountToken = ethers.getAddress(process.env.DISCOUNT_TOKEN || ethers.ZeroAddress);
  const threshold = BigInt(process.env.DISCOUNT_THRESHOLD || '0');

  const art = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts.json'), 'utf8')).QuietlotSettlement;
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);

  console.log(`deployer ${wallet.address} on chain ${chainId}`);
  console.log('warning: the contract is unaudited. Use test wallets and test tokens only.');
  const contract = await factory.deploy(treasury, discountToken, threshold);
  const tx = contract.deploymentTransaction();
  console.log(`deploy tx ${tx.hash}, waiting for confirmation...`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const record = {
    chainId: Number(chainId),
    address,
    deployer: wallet.address,
    txHash: tx.hash,
    treasury,
    discountToken,
    discountThreshold: threshold.toString(),
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  console.log(`QuietlotSettlement deployed at ${address}`);
  console.log(`record written to ${file}`);
})().catch(e => { console.error('deploy failed:', e.message); process.exit(1); });
