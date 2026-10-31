const { createHash, randomBytes } = require('node:crypto');
const { AccountMemory, encode, Encoding } = require('@aeternity/aepp-sdk');
const digest = value => createHash('sha256').update(value).digest('hex');

// Synthetic identities and ABI; never a deployment or funded account.
function releaseFixture(overrides = {}, artifactOverrides = {}) {
  const operator = AccountMemory.generate().address;
  const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
    { name: 'get_config', arguments: [], returns: { tuple: ['address', 'address', 'int', 'int'] }, payable: false, stateful: false },
    { name: 'get_previous', arguments: [], returns: { option: ['address'] }, payable: false, stateful: false },
    { name: 'publish', arguments: [{ name: 'id', type: 'string' }, { name: 'creator', type: 'address' }, { name: 'cid', type: 'string' }, { name: 'size', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true },
  ] } }];
  const bytecode = encode(randomBytes(32), Encoding.ContractBytearray);
  const artifact = { compiler: '8.0.0', sourceHash: 'a'.repeat(64), bytecodeHash: digest(bytecode), bytecode, aci, ...artifactOverrides };
  const release = { schemaVersion: 1, network: 'ae_uat', node: 'https://testnet.aeternity.io', middleware: 'https://testnet.aeternity.io/mdw',
    contract: encode(randomBytes(32), Encoding.ContractAddress), previousContract: null, operator, treasury: operator,
    compiler: artifact.compiler, sourceHash: artifact.sourceHash, bytecodeHash: artifact.bytecodeHash,
    aciHash: digest(JSON.stringify(artifact.aci)), likeFeeAetto: '100000000000000000', treasuryBps: 2000, ...overrides };
  return { artifact, release };
}
module.exports = { releaseFixture, digest };
