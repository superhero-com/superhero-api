require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encode, Encoding } = require('@aeternity/aepp-sdk');
const { releaseFixture, digest } = require('./shorts-release.fixture.cjs');
const { shortsRelease, shortsLikeMode } = require('./shorts-release');
const { shortsInnerContractCall, shortsIndexedContractCall } = require('./shorts-contract-call');
const { ShortsPluginSyncService } = require('../plugins/shorts/shorts-plugin-sync.service');
const { ShortsPlugin } = require('../plugins/shorts/shorts.plugin');
const { ShortsBackfillService } = require('../plugins/shorts/shorts-backfill.service');
const { ShortsChainService } = require('./shorts-chain.service');

const like = { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'expected_config_version', type: 'int' }],
  returns: { tuple: [] }, payable: false, stateful: true };
const freeFixture = (fn = like) => {
  const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [fn] } }];
  return releaseFixture({ schemaVersion: 2, likeFeeAetto: '0' }, { aci });
};

test('free Like capability requires exact bound nonpayable ABI and zero live policy', () => {
  const f = freeFixture(), policy = { likeFeeAetto: '0' };
  assert.equal(shortsRelease(f.release).likeFeeAetto, '0');
  assert.equal(shortsLikeMode(f.release, f.artifact, policy), 'free');
  for (const fn of [{ ...like, payable: true }, { ...like, stateful: false }, { ...like, arguments: [like.arguments[0]] }]) {
    const wrong = freeFixture(fn);
    assert.throws(() => shortsLikeMode(wrong.release, wrong.artifact, policy), /capability/);
  }
  for (const changed of [
    { ...f.artifact, bytecode: f.artifact.bytecode + 'x' },
    { ...f.artifact, aci: [{ changed: true }] },
  ]) assert.throws(() => shortsLikeMode(f.release, changed, policy), /artifact/);
  assert.throws(() => shortsLikeMode(f.release, f.artifact, { likeFeeAetto: '1' }), /capability/);
  const both = structuredClone(f.artifact);
  both.aci[0].contract.functions.push({ ...like, name: 'paid_like', payable: true });
  assert.throws(() => shortsLikeMode({ ...f.release, aciHash: digest(JSON.stringify(both.aci)) }, both, policy), /capability/);
  const zeroWithoutLike = releaseFixture({ schemaVersion: 2, likeFeeAetto: '0' });
  assert.throws(() => shortsLikeMode(zeroWithoutLike.release, zeroWithoutLike.artifact, policy), /capability/);
});

const inner = (events = [{ name: 'Liked', args: ['ak_viewer', 17n, 'video'] }]) => ({
  type: 'ContractCallTx', callerId: 'ak_viewer', contractId: 'ct_current', function: 'like', returnType: 'ok',
  log: events.map(event => ({ address: 'ct_current', topics: [], decoded: [event] })),
});
const sponsored = call => ({
  hash: 'th_outer', type: 'PayingForTx', block_hash: 'mh_canonical', block_height: 5, micro_time: '1234',
  caller_id: 'ak_sponsor', raw: { type: 'PayingForTx', payerId: 'ak_sponsor', tx: { signatures: ['sig'], tx: call } },
});

test('sponsored normalization takes the inner account call and rejects unsupported nested authority', () => {
  const call = inner(), tx = sponsored(call);
  assert.equal(shortsInnerContractCall(tx.raw), call);
  assert.equal(shortsIndexedContractCall(tx), call);
  assert.equal(shortsInnerContractCall(call), call);
  for (const raw of [
    { type: 'PayingForTx' }, { type: 'PayingForTx', tx: { tx: { type: 'SpendTx' } } },
    { type: 'PayingForTx', tx: { tx: tx.raw } }, { type: 'GAMetaTx', tx: call },
  ]) assert.equal(shortsInnerContractCall(raw), undefined);
});

test('free Like indexing uses the outer hash, inner actor and zero accounting amount', async () => {
  const saved = [], calls = [], tx = sponsored(inner());
  const db = { transaction: fn => fn({ query: async (sql, args) => {
    if (sql.startsWith('SELECT block_hash')) {
      assert.equal(args[0], 'th_outer');
      return [{ block_hash: tx.block_hash, block_height: tx.block_height }];
    }
    if (sql.includes('INSERT INTO shorts_chain_events')) saved.push(args);
    return [];
  } }) };
  const contract = { $options: { address: 'ct_current' }, $decodeEvents: logs => logs.flatMap(log => log.decoded),
    $call: async (method, args) => { calls.push([method, args]); return { decodedResult: { creator: 'ak_creator' } }; } };
  const index = { assertNetwork: async () => {}, contracts: () => [contract], schema: () => 2, identity: () => ({}) };
  const network = { verify: async () => {}, bindings: () => ({}) };
  const processor = new ShortsPluginSyncService({}, db, index, network);
  const plugin = new ShortsPlugin({}, {}, processor, index, {}, {});
  assert.equal(plugin.filters()[0].predicate(tx), true);
  await processor.processTransaction(tx, 'live');
  assert.deepEqual(saved, [['ct_current', 'th_outer', 0, 5, '1234', 'Liked', 'ak_viewer', 'ak_creator', '0', 'video']]);
  assert.deepEqual(calls, [['get_video', ['video']]]);
  await assert.rejects(processor.processTransaction(sponsored(inner([])), 'live'), /Missing Shorts accounting event/);
  await assert.rejects(processor.processTransaction(sponsored(inner([{ name: 'Liked', args: ['ak_sponsor', 17n, 'video'] }])), 'live'), /Invalid Shorts Like event/);
  const reverted = sponsored(inner()); reverted.raw.tx.tx.returnType = 'revert';
  await processor.processTransaction(reverted, 'live');
  assert.equal(saved.length, 1);
});

test('backfill keeps a sponsored middleware transaction under its canonical outer hash', async () => {
  const outerHash = encode(Buffer.alloc(32, 6), Encoding.TxHash), saved = [], processed = [];
  const raw = { hash: outerHash, block_height: 5, block_hash: 'mh_canonical', micro_time: 1234,
    tx: { type: 'PayingForTx', payer_id: 'ak_sponsor', tx: { signatures: ['sig'], tx: {
      type: 'ContractCallTx', caller_id: 'ak_viewer', contract_id: 'ct_current', function: 'like',
      return_type: 'ok', log: [{ address: 'ct_current', topics: [] }],
    } } } };
  const db = { getRepository: () => ({ upsert: async tx => saved.push(tx) }), query: async sql =>
    sql.startsWith('SELECT *') ? [{ complete: false, covered_height: -1 }] : [] };
  const index = { assertNetwork: async () => {}, contracts: () => [{ $options: { address: 'ct_current' } }] };
  const network = { verify: async () => {}, bindings: () => ({ middleware: 'https://testnet.aeternity.io/mdw' }),
    generation: async () => ({ microBlocks: ['mh_canonical'] }), json: async url => url.includes('/transactions/')
      ? raw : { data: [{ call_tx_hash: outerHash }], next: null } };
  const backfill = new ShortsBackfillService(db, network, index, {
    processTransaction: async tx => processed.push(tx),
  }, { changed: async () => {} });
  await backfill.run(10, () => false);
  assert.equal(saved.length, 1); assert.equal(saved[0].hash, outerHash); assert.equal(saved[0].type, 'PayingForTx');
  assert.equal(shortsIndexedContractCall(saved[0]).callerId, 'ak_viewer');
  assert.equal(processed[0], saved[0]);
});

test('receipt verification stores sponsored outer identity and rejects sponsor-as-actor or failed calls', async () => {
  const tx = encode(Buffer.alloc(32, 1), Encoding.TxHash), blockHash = encode(Buffer.alloc(32, 2), Encoding.MicroBlockHash);
  const actor = encode(Buffer.alloc(32, 3), Encoding.AccountAddress), contract = encode(Buffer.alloc(32, 4), Encoding.ContractAddress);
  const sponsor = encode(Buffer.alloc(32, 5), Encoding.AccountAddress), saves = [];
  const chain = new ShortsChainService({ save: state => saves.push(state.receipts[0]) }, {});
  chain.state.contract = contract; chain.assertTestnet = async () => {};
  const mined = { hash: tx, blockHeight: 5, blockHash, tx: { type: 'PayingForTx', payerId: sponsor, tx: {
    signatures: ['sig'], tx: { type: 'ContractCallTx', callerId: actor, contractId: contract },
  } } };
  const info = { callInfo: { returnType: 'ok', callerId: actor, contractId: contract, height: 5 } };
  chain.sdk = { api: { getTransactionByHash: async () => mined, getTransactionInfoByHash: async () => info,
    getGenerationByHeight: async () => ({ microBlocks: [blockHash] }) } };
  await assert.rejects(chain.recordTransaction(sponsor, tx), /Successful mined wallet call/);
  assert.deepEqual(await chain.recordTransaction(actor, tx), { tx });
  assert.equal(saves[0].tx, tx); assert.equal(saves[0].actor, actor);
  info.callInfo.returnType = 'revert';
  await assert.rejects(chain.recordTransaction(actor, tx), /Successful mined wallet call/);
});
