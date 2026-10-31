require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { encode, Encoding } = require('@aeternity/aepp-sdk');
const dest = encode(Buffer.alloc(32, 1), Encoding.ContractAddress), sourceAddress = encode(Buffer.alloc(32, 2), Encoding.ContractAddress);
const destDecoded = encode(Buffer.alloc(32, 1), Encoding.AccountAddress);
const sourceDecoded = encode(Buffer.alloc(32, 2), Encoding.AccountAddress);
const { ShortsNativeImportService } = require('./shorts-native-import.service');

function fixture() {
  const service = new ShortsNativeImportService({ read: f => f() });
  service.release = { network: 'ae_uat', contract: dest, previousContract: sourceAddress, sourceHash: 'a'.repeat(64), previousArtifact: { bytecodeHash: 'b'.repeat(64) } };
  service.config = { maxRecords: 10, destinationConfig: {} };
  service.source = {}; service.destination = {};
  const video = { id: 'video', creator: 'ak_creator', cid: 'cid', size: 10n, withdrawn: true };
  const stats = { likes: 1n, comments: 1n, next_comment: 9n, comment_version: 12n };
  const comment = { author: 'ak_author', text: 'retained sparse comment', height: 70n, sequence: 4n };
  const author = { sequence: 5n, height: 71n };
  const records = [{ Video: [0n, video, stats] }, { Like: [0n, 'ak_liker'] }, { Comment: [0n, 8n, comment] }, { Author: ['ak_author', author] }, { Author: ['ak_deleted_only', { sequence: 6n, height: 72n }] }];
  const totals = { videos: 1n, likes: 1n, comments: 1n, authors: 2n };
  const digest = Buffer.alloc(32, 7);
  const source = { frozen: true, sealed: true, importing: false, abandoned: false, successor: destDecoded, snapshot_height: 80n, totals, digest };
  const destination = { frozen: false, abandoned: false, importing: false, import_started: true };
  service.sdk = { api: {
    getStatus: async () => ({ networkId: 'ae_uat' }),
    getCurrentKeyBlock: async () => ({ height: 100 }),
    getKeyBlockByHeight: async h => ({ height: h, hash: 'kh_cutoff' }),
    getGenerationByHeight: async h => h === 100 ? { keyBlock: { hash: 'kh_before_last_write', height: h }, microBlocks: ['mh_after_last_write'] } : { keyBlock: { hash: 'kh_cutoff', height: h }, microBlocks: [] },
    getCurrentGeneration: async () => ({ keyBlock: { hash: 'kh_before_last_write', height: 100 }, microBlocks: ['mh_after_last_write'] }),
  } };
  const seen = [];
  service.read = async (c, method, args = [], top) => {
    seen.push({ c, method, args, top });
    if (method === 'migration_status') return c === service.source ? source : destination;
    if (method === 'export_page') return { items: records, next_cursor: 5n, end_cursor: 5n };
    if (method === 'get_import_source') return [sourceDecoded, undefined];
    if (method === 'get_import_progress') return [5n, 5n, digest, digest, 0n, 0n];
    if (method === 'get_config') return [{}, 0n];
    if (method === 'get_totals') return totals;
    if (method === 'get_video_key') return 0n;
    if (method === 'get_video') return video;
    if (method === 'get_video_stats') return stats;
    if (method === 'has_liked') return true;
    if (method === 'get_comment') { assert.equal(args[1], '8'); return comment; }
    if (method === 'get_author') return args[0] === 'ak_deleted_only' ? records[4].Author[1] : author;
    throw new Error(method);
  };
  return { service, source, destination, records, seen };
}

test('native proof preserves sparse IDs, withdrawn history and deleted-only author controls using a microblock-pinned destination', async () => {
  const { service, seen } = fixture();
  const snapshot = await service.snapshot();
  assert.equal(snapshot.videos[0].withdrawn, true);
  assert.deepEqual(snapshot.videos[0].likes, ['ak_liker']);
  const result = await service.verifyDestination(snapshot, true);
  assert.equal(result.records, 5);
  assert.equal(result.top, 'mh_after_last_write');
  assert.ok(seen.some(x => x.method === 'get_author' && x.args[0] === 'ak_deleted_only'));
  assert.ok(seen.filter(x => ['get_video', 'get_comment', 'get_author', 'has_liked'].includes(x.method)).every(x => x.top === result.top));
});

test('tampered snapshot text, missing author, forged Like baseline and wrong predecessor cannot enroll', async () => {
  for (const edit of [s => { s.records[2].Comment[2].text = 'altered'; }, s => s.records.pop(), s => s.videos[0].likes.push('ak_fake'), s => { s.source = 'ct_storage'; }]) {
    const { service } = fixture(); const snapshot = await service.snapshot(); edit(snapshot);
    await assert.rejects(service.verifyBaseline(snapshot), /snapshot/i);
  }
});

test('mutable, unsealed, redirected or over-budget sources fail before copying', async () => {
  for (const edit of [f => { f.source.frozen = false; }, f => { f.source.sealed = false; }, f => { f.source.successor = encode(Buffer.alloc(32, 3), Encoding.ContractAddress); }, f => { f.service.config.maxRecords = 4; }]) {
    const f = fixture(); edit(f); await assert.rejects(f.service.snapshot(), /Snapshot|allowance/);
  }
});

test('partial imports, changed digest and abandoned destinations cannot provide a permanent baseline', async () => {
  for (const edit of [f => { f.destination.abandoned = true; }, f => { f.destination.importing = true; }, f => { f.destination.import_started = false; }, f => { const read = f.service.read; f.service.read = (...a) => a[1] === 'get_import_progress' ? [5n, 5n, Buffer.alloc(32), Buffer.alloc(32), 0n, 0n] : read(...a); }]) {
    const f = fixture(); const snapshot = await f.service.snapshot(); edit(f);
    await assert.rejects(f.service.verifyBaseline(snapshot), /proof/);
  }
});

test('missing membership or corrupted destination author sequence is detected independently of a valid import digest', async () => {
  for (const method of ['has_liked', 'get_author']) {
    const { service } = fixture(); const snapshot = await service.snapshot(); const read = service.read;
    service.read = (...a) => a[1] === method ? (method === 'has_liked' ? false : { sequence: 0n, height: 0n }) : read(...a);
    await assert.rejects(service.verifyDestination(snapshot), /membership|author/);
  }
});

test('changed canonical cutoff fails even when stored source data matches', async () => {
  const { service } = fixture(); const snapshot = await service.snapshot();
  service.sdk.api.getKeyBlockByHeight = async h => ({ height: h, hash: 'kh_reorg' });
  await assert.rejects(service.verifyBaseline(snapshot), /canonical/);
});

test('private migration journal excludes competing writers and refuses binding replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-proof-'));
  const first = fixture().service, second = fixture().service;
  try {
    await first.openJournal(join(dir, 'journal.jsonl'));
    assert.equal((await stat(join(dir, 'journal.jsonl'))).mode & 0o077, 0);
    await assert.rejects(second.openJournal(join(dir, 'journal.jsonl')), { code: 'EEXIST' });
    await first.append({ type: 'observation', safe: true });
    assert.equal((await readFile(join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').length, 2);
    await first.onModuleDestroy();
    second.release.contract = 'ct_other';
    await assert.rejects(second.openJournal(join(dir, 'journal.jsonl')), /binding changed/);
  } finally { await first.onModuleDestroy(); await second.onModuleDestroy(); await rm(dir, { recursive: true, force: true }); }
});

test('a confirmed cutover cannot be assembled from mixed heads or survive a reorganization during the record scan', async () => {
  const { service } = fixture(); const snapshot = await service.snapshot(); const read = service.read;
  service.read = (...a) => {
    if (a[0] === service.destination) assert.equal(a[3], 'kh_cutoff');
    return read(...a);
  };
  await service.verifyBaseline(snapshot);
  service.read = async (...a) => {
    const value = await read(...a);
    if (a[1] === 'get_author') service.sdk.api.getGenerationByHeight = async h => ({ keyBlock: { height: h, hash: 'kh_other' }, microBlocks: [] });
    return value;
  };
  await assert.rejects(service.verifyDestination(snapshot), /anchor changed/);
});

test('native signed journal rejects changed method/arguments, network, expiry and unrelated receipt identities', async () => {
  const { AccountMemory, buildTx, Tag, buildTxHash } = require('@aeternity/aepp-sdk');
  const { AciContractCallEncoder } = require('@aeternity/aepp-calldata');
  const account = AccountMemory.generate(), { service } = fixture();
  const encoder = new AciContractCallEncoder([{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [{ name: 'seal_next', arguments: [{ name: 'cursor', type: 'int' }, { name: 'limit', type: 'int' }], returns: { tuple: [] }, stateful: true, payable: false }] } }]);
  service.owner = account.address; service.encoders.set(sourceAddress, encoder);
  const unsigned = buildTx({ tag: Tag.ContractCallTx, callerId: account.address, contractId: sourceAddress, nonce: 3, amount: 0, abiVersion: 3, gasLimit: 100000, gasPrice: 1000000000, ttl: 140, callData: encoder.encodeCall('Shorts', 'seal_next', [0, 25]) });
  const raw = await account.signTransaction(unsigned, { networkId: 'ae_uat' });
  const row = { raw, hash: buildTxHash(raw), contract: sourceAddress, method: 'seal_next', args: [0, 25], height: 100 };
  assert.equal(service.validateSigned(row).ttl, 140);
  for (const patch of [{ args: [25, 25] }, { method: 'like' }, { height: 99 }, { contract: dest }]) assert.throws(() => service.validateSigned({ ...row, ...patch }));
  const wrongNetwork = await account.signTransaction(unsigned, { networkId: 'ae_mainnet' });
  assert.throws(() => service.validateSigned({ ...row, raw: wrongNetwork }), /signature\/network/);
  service.sdk.api.getTransactionByHash = async () => ({ hash: row.hash, blockHeight: 101, signatures: [], tx: {} });
  service.sdk.api.getTransactionInfoByHash = async () => ({ callInfo: { returnType: 'ok', callerId: 'ak_other', contractId: sourceAddress } });
  await assert.rejects(service.receipt(row), /envelope/);
});

test('destination configuration drift prevents baseline enrollment', async () => {
  const { service } = fixture(); const snapshot = await service.snapshot(), read = service.read;
  service.read = (...a) => a[1] === 'get_config' ? [{ operator: 'ak_other' }, 1n] : read(...a);
  await assert.rejects(service.verifyBaseline(snapshot), /configuration changed/);
});


test('lost activation acknowledgement reconciles active proof without signing finish_import twice', async () => {
  const { service, destination } = fixture(); const snapshot = await service.snapshot();
  destination.importing = true; let writes = 0;
  service.write = async () => { writes++; destination.importing = false; throw new Error('lost acknowledgement'); };
  await assert.rejects(service.activate(snapshot), /lost acknowledgement/);
  const result = await service.activate(snapshot);
  assert.equal(result.activated, true); assert.equal(result.requiresConfirmedVerification, true); assert.equal(writes, 1);
});
