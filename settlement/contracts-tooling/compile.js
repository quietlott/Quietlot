const solc = require('solc');
const fs = require('fs');
const path = require('path');
const files = {
  'QuietlotSettlement.sol': path.resolve(__dirname, '../contracts/src/QuietlotSettlement.sol'),
  'MockERC20.sol': path.resolve(__dirname, '../contracts/test/MockERC20.sol'),
};
const sources = {};
for (const [name, p] of Object.entries(files)) sources[name] = { content: fs.readFileSync(p, 'utf8') };
const input = { language: 'Solidity', sources, settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = out.errors || [];
errs.forEach(e => console.log(e.severity, e.formattedMessage));
if (errs.some(e => e.severity === 'error')) process.exit(1);
const artifacts = {};
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    artifacts[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  }
}
fs.writeFileSync(path.join(__dirname, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
console.log('compiled:', Object.keys(artifacts).join(', '));
