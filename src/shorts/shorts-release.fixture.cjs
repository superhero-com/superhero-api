const { createHash, randomBytes } = require('node:crypto');
const { AccountMemory, encode, Encoding } = require('@aeternity/aepp-sdk');
const digest = value => createHash('sha256').update(value).digest('hex');

// Synthetic identities and ABI; never a deployment or funded account.
function releaseFixture(overrides = {}, artifactOverrides = {}) {
  const operator = AccountMemory.generate().address;
  const record = fields => ({ record: Object.entries(fields).map(([name, type]) => ({ name, type })) });
  const config = record({ operator: 'address', max_video_bytes: 'int', max_comment_chars: 'int', max_comment_bytes: 'int',
    comment_cooldown: 'int', publishing_enabled: 'bool', likes_enabled: 'bool', comments_enabled: 'bool' });
  const status = record({ schema: 'int', importing: 'bool', import_started: 'bool', abandoned: 'bool', frozen: 'bool',
    reserved_source: {option:['contract_pubkey']} });
  const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
    { name: 'get_config', arguments: [], returns: { tuple: [config, 'int'] }, payable: false, stateful: false },
    { name: 'migration_status', arguments: [], returns: status, payable: false, stateful: false },
    { name: 'publish', arguments: [{ name: 'id', type: 'string' }, { name: 'creator', type: 'address' }, { name: 'cid', type: 'string' }, { name: 'size', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true },
  ] } }];
  const bytecode = encode(randomBytes(32), Encoding.ContractBytearray);
  const artifact = { compiler: '8.0.0', sourceHash: 'a'.repeat(64), bytecodeHash: digest(bytecode), bytecode, aci, ...artifactOverrides };
  const release = { schemaVersion: 2, network: 'ae_uat', node: 'https://testnet.aeternity.io', middleware: 'https://testnet.aeternity.io/mdw',
    contract: encode(randomBytes(32), Encoding.ContractAddress), previousContract: null, operator, treasury: operator,
    compiler: artifact.compiler, sourceHash: artifact.sourceHash, bytecodeHash: artifact.bytecodeHash,
    aciHash: digest(JSON.stringify(artifact.aci)), likeFeeAetto: '100000000000000000', treasuryBps: 2000, ...overrides };
  return { artifact, release };
}
module.exports = { releaseFixture, digest };
