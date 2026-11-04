const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { AccountMemory, encode, Encoding } = require('@aeternity/aepp-sdk');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsReceipts1791763208000 } = require('../migrations/1791763208000-ShortsReceipts');
const { ShortsSharedCutover1791763214000 } = require('../migrations/1791763214000-ShortsSharedCutover');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsReceiptsService } = require('./shorts-receipts.service');
const { ShortsChainService } = require('./shorts-chain.service');

test('shared receipt history: scoped identity, idempotent persistence and honest chain observations', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_receipts_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 },
    migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsReceipts1791763208000, ShortsSharedCutover1791763214000, ShortsUploadBudget1791763224000] };
  const one = new DataSource(options), two = new DataSource(options);
  const originalEnv = { ...process.env };
  t.after(async () => { process.env = originalEnv; await two.destroy(); await one.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await one.initialize(); await two.initialize(); await one.runMigrations({ transaction: 'all' });
  const a = new ShortsReceiptsService(one), b = new ShortsReceiptsService(two), meta = new ShortsMetadataService(one);
  const actor = AccountMemory.generate().address, other = AccountMemory.generate().address, sourceHash = 'a'.repeat(64);
  const txHash = () => encode(randomBytes(32), Encoding.TxHash), blockHash = () => encode(randomBytes(32), Encoding.MicroBlockHash);
  const params = s => [s.network, s.contract];
  async function scope(initialize = true) {
    const s = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
    await meta.initialize(s, sourceHash); if (initialize) await a.initialize(s, sourceHash, 'ct_previous', []); return s;
  }
  const submitted = (s, extra = {}) => ({ tx: txHash(), actor, action: 'wallet_transaction', verification: 'submitted', calledContract: s.contract, ...extra });
  const observed = (s, extra = {}) => ({ ...submitted(s), verification: 'node_observed', blockHash: blockHash(), blockHeight: 12, ...extra });
  async function rows(s) { return one.query('SELECT * FROM shorts_transaction_receipts WHERE network=$1 AND contract=$2 ORDER BY at,tx', params(s)); }
  async function runtime(s, repository = a) {
    const chain = new ShortsChainService({ save() { assert.fail('Hosted receipts must not write the local snapshot'); } }, {}, repository);
    chain.release = { ...s };
    chain.state = { contract: s.contract, sourceHash, shorts: [], receipts: [] };
    chain.previous = { $options: { address: 'ct_previous' } }; chain.operator = { address: actor };
    await chain.onApplicationBootstrap();
    return chain;
  }
  function node(chain, tx = txHash(), contract = chain.state.contract) {
    const block = blockHash();
    const state = { network: 'ae_uat', transaction: { hash: tx, blockHash: block, blockHeight: 12,
      tx: { type: 'ContractCallTx', callerId: actor, contractId: contract } },
      info: { callInfo: { callerId: actor, contractId: contract, height: 12, returnType: 'ok' } }, generation: { microBlocks: [block] }, calls: 0 };
    chain.sdk = { api: {
      getStatus: async () => ({ networkId: state.network }),
      getTransactionByHash: async () => { state.calls++; return state.transaction; }, getTransactionInfoByHash: async () => state.info,
      getGenerationByHeight: async height => { assert.equal(height, state.transaction.blockHeight); return state.generation; },
    } };
    return { tx, state };
  }

  await t.test('deployment binding is shared, initialization fails closed and startup precedes any writes', async () => {
    const s = await scope(false); await Promise.all([a.initialize(s, sourceHash, 'ct_previous', []), b.initialize(s, sourceHash, 'ct_previous', [])]);
    await assert.rejects(b.initialize(s, 'b'.repeat(64), 'ct_previous', []), { status: 503 });
    await assert.rejects(b.initialize(s, sourceHash, 'ct_other', []), { status: 409 });
    await assert.rejects(new ShortsReceiptsService().list(s, actor), { status: 503 });
    const chain = new ShortsChainService({}, {}, a); chain.state.contract = s.contract; chain.release = { ...s };
    let sent = 0; chain.contract = { $call: async () => { sent++; } };
    await assert.rejects(chain.write('publish', []), /Hosted API cannot sign/); assert.equal(sent, 0);
  });
  await t.test('concurrent duplicates create one receipt and conflicting identities never overwrite it', async () => {
    const s = await scope(), receipt = observed(s);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).record(s, receipt)));
    assert.equal((await rows(s)).length, 1);
    await assert.rejects(b.record(s, { ...receipt, actor: other }), { status: 409 });
    await assert.rejects(b.record(s, { ...receipt, calledContract: 'ct_previous' }), { status: 409 });
    await assert.rejects(b.record(s, { ...receipt, tx: txHash(), calledContract: 'ct_unrelated' }), { status: 400 });
    assert.equal((await rows(s))[0].actor, actor);
    const alien = await scope(); await a.record(alien, { ...receipt, calledContract: alien.contract });
    assert.equal((await b.list(alien, actor)).items.length, 1); assert.equal((await b.list(s, other)).items.length, 0);
  });
  await t.test('late submissions cannot downgrade observations or reorder original activity', async () => {
    const s = await scope(), receipt = submitted(s, { action: 'publish' }); await a.record(s, receipt);
    const at = (await rows(s))[0].at; const proof = observed(s, { tx: receipt.tx });
    await b.record(s, proof); await a.record(s, receipt);
    const [stored] = await rows(s);
    assert.equal(stored.verification, 'node_observed'); assert.equal(stored.block_hash, proof.blockHash);
    assert.equal(stored.action, 'publish'); assert.equal(stored.at, at);
    await assert.rejects(a.record(s, { ...proof, blockHeight: undefined }), { status: 400 });
    await assert.rejects(one.query('UPDATE shorts_transaction_receipts SET block_height=NULL WHERE contract=$1', [s.contract]), { code: '23514' });
  });
  await t.test('historical import is explicit, deduplicated and never replayed over newer observations', async () => {
    const s = await scope(false), tx = txHash(), legacy = [{ actor, tx, action: 'publish', at: 100 }, { actor, tx, action: 'publish', at: 200 }];
    await assert.rejects(a.initialize(s, sourceHash, 'ct_previous', legacy), { status: 409 });
    assert.equal((await rows(s)).length, 0);
    await a.initialize(s, sourceHash, 'ct_previous', legacy, true);
    assert.equal((await rows(s)).length, 1); assert.equal((await rows(s))[0].verification, 'legacy');
    assert.equal((await rows(s))[0].called_contract, null); assert.equal((await rows(s))[0].at, '100');
    const proof = observed(s, { tx }); await b.record(s, proof);
    await a.initialize(s, sourceHash, 'ct_previous', legacy);
    assert.equal((await rows(s))[0].verification, 'node_observed'); assert.equal((await rows(s))[0].block_hash, proof.blockHash);
    await assert.rejects(a.initialize(s, sourceHash, 'ct_previous', [...legacy, { ...legacy[0], at: 300 }], true), { status: 409 });
    const otherScope = await scope(); await assert.rejects(a.initialize(otherScope, sourceHash, 'ct_previous', legacy, true), { status: 409 });
  });
  await t.test('conflicting history rolls back the whole import and malformed identifiers are rejected', async () => {
    const s = await scope(false), tx = txHash();
    await assert.rejects(a.initialize(s, sourceHash, undefined, [
      { actor, tx, action: 'claim', at: 10 }, { actor: other, tx, action: 'claim', at: 20 },
    ], true), { status: 409 });
    assert.equal((await rows(s)).length, 0);
    assert.equal((await one.query('SELECT * FROM shorts_receipt_scopes WHERE contract=$1', [s.contract])).length, 0);
    await assert.rejects(a.initialize(s, sourceHash, undefined, [{ actor, tx: 'th_badchecksum', action: 'claim', at: 10 }], true), { status: 400 });
    await a.initialize(s, sourceHash, undefined, [{ actor, tx, action: 'claim', at: 10 }], true);
    await assert.rejects(a.record(s, { ...observed(s), blockHash: txHash() }), { status: 400 });
    await assert.rejects(a.record(s, submitted(s, { actor: 'ak_invalid' })), { status: 400 });
  });
  await t.test('bounded cursor pages keep actor/deployment isolation and stable ordering', async () => {
    const s = await scope();
    for (let i = 0; i < 38; i++) await (i % 2 ? a : b).record(s, submitted(s, { actor: i < 35 ? actor : other }));
    const first = await a.list(s, actor); assert.equal(first.items.length, 15); assert.ok(first.next);
    const second = await b.list(s, actor, 15, first.next), third = await a.list(s, actor, 15, second.next);
    assert.equal(second.items.length, 15); assert.equal(third.items.length, 5); assert.equal(third.next, undefined);
    const ids = [...first.items, ...second.items, ...third.items].map(r => r.tx); assert.equal(new Set(ids).size, 35);
    assert.equal((await b.list(s, other)).items.length, 3);
    await assert.rejects(a.list(s, actor, 101), { status: 400 });
  });
  await t.test('wallet receipts require matching successful node evidence and current generation membership', async () => {
    const changes = [
      s => { s.network = 'ae_mainnet'; }, s => { s.transaction.hash = txHash(); }, s => { s.transaction.blockHeight = -1; },
      s => { s.transaction.blockHeight = NaN; }, s => { s.transaction.tx.type = 'SpendTx'; },
      s => { s.transaction.tx.callerId = other; }, s => { s.transaction.tx.contractId = 'ct_unrelated'; },
      s => { s.info.callInfo.returnType = 'revert'; }, s => { s.info.callInfo.callerId = other; },
      s => { s.info.callInfo.contractId = 'ct_unrelated'; }, s => { s.info.callInfo.height++; },
      s => { s.transaction.blockHash = txHash(); }, s => { s.generation.microBlocks = []; },
    ];
    for (const change of changes) {
      const scopeValue = await scope(), chain = await runtime(scopeValue), { tx, state } = node(chain);
      change(state); await assert.rejects(chain.recordTransaction(actor, tx)); assert.equal((await rows(scopeValue)).length, 0);
    }
    const s = await scope(), chain = await runtime(s), { tx, state } = node(chain, undefined, 'ct_previous');
    await assert.rejects(chain.recordTransaction(actor, 'th_wrongchecksum'), { status: 400 }); assert.equal(state.calls, 0);
    assert.deepEqual(await chain.recordTransaction(actor, tx), { tx });
    assert.equal((await chain.receiptHistory(actor))[0].verification, 'node_observed');
    assert.equal((await rows(s))[0].called_contract, 'ct_previous');
    assert.deepEqual(chain.state.receipts, [], 'the former local snapshot remains unchanged');
  });
  await t.test('hosted receipt service never grants inline publication or payment signing authority', async () => {
    const s = await scope(), chain = await runtime(s), tx = txHash(); node(chain);
    let calls = 0;
    chain.contract = { $call: async () => { calls++; return { hash: tx, decodedResult: 1 }; } };
    await assert.rejects(chain.write('publish', []), /Hosted API cannot sign/);
    await assert.rejects(chain.write('paid_like', []), /Hosted API cannot sign/);
    assert.equal(calls, 0); assert.equal((await rows(s)).length, 0);
  });
  await t.test('database failure after observation is retryable without local fallback or another wallet transaction', async () => {
    const s = await scope(), chain = await runtime(s), { tx } = node(chain);
    const record = a.record.bind(a); a.record = async () => { throw new Error('Database unavailable'); };
    try { await assert.rejects(chain.recordTransaction(actor, tx), /Database unavailable/); }
    finally { a.record = record; }
    assert.equal((await rows(s)).length, 0); assert.deepEqual(chain.state.receipts, []);
    const second = await runtime(s, b); node(second, tx);
    await Promise.all([chain.recordTransaction(actor, tx), second.recordTransaction(actor, tx)]);
    assert.equal((await rows(s)).length, 1);
  });
  await t.test('real Nest bootstrap initializes history after shared content without duplicating the chain provider', async () => {
    const { Test } = require('@nestjs/testing'); const { Module, Global } = require('@nestjs/common');
    const { ShortsCoreModule } = require('./shorts-core.module'); const { ShortsMetadataModule } = require('./shorts-metadata.module');
    const { ShortsStoreService } = require('./shorts-store.service'); const { ShortsRecordsService } = require('./shorts-records.service');
    class DatabaseModule {} Global()(DatabaseModule); Module({ providers: [{ provide: DataSource, useValue: one }], exports: [DataSource] })(DatabaseModule);
    for(const key of ['SHORTS_DATA_DIR','SHORTS_IMPORT_LEGACY_CONTENT','SHORTS_IMPORT_LEGACY_ANALYTICS','SHORTS_IMPORT_LEGACY_RECEIPTS']) delete process.env[key];
    const module = await Test.createTestingModule({ imports: [DatabaseModule, ShortsCoreModule, ShortsMetadataModule], providers: [ShortsRecordsService] }).compile();
    assert.equal(module.get(ShortsStoreService).shared, true);
    assert.throws(() => module.get(ShortsStoreService).db, /unavailable in the hosted API/);
    const chain = module.get(ShortsChainService), contract = `ct_${randomUUID().replaceAll('-', '')}`;
    chain.onModuleInit = async () => { chain.release = { network: 'ae_uat', contract };
    chain.state = { contract, sourceHash, shorts: [], receipts: [] }; };
    try {
      await module.init(); assert.equal(chain.sharedReceipts, true); assert.deepEqual(await chain.receiptHistory(actor), []);
      assert.equal(module.get(ShortsRecordsService).chain, chain);
    } finally { await module.close(); }
  });
  await t.test('receipt acknowledgement and dashboard history work across HTTP API instances', async t => {
    const { NestFactory } = require('@nestjs/core'); const { ShortsController } = require('./shorts.controller');
    const { ShortsService } = require('./shorts.service'); const { ShortsAuthService } = require('./shorts-auth.service');
    const { ShortsUploadsService } = require('./shorts-uploads.service'); const { ShortsAuthGuard } = require('./shorts-auth.guard');
    const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
    const s = await scope(), tx = txHash(), bases = [];
    for (const repository of [a, b]) {
      const chain = await runtime(s, repository); node(chain, tx); chain.account = async address => ({ address });
      const service = new ShortsService(chain); service.list = async () => [];
      const app = await NestFactory.create({ module: class ReceiptHttpTest {}, controllers: [ShortsController], providers: [ShortsAuthGuard, ShortsUploadInterceptor,
        { provide: ShortsService, useValue: service }, { provide: ShortsAuthService, useValue: { authenticate: async token => token === 'Bearer other' ? other : actor } },
        { provide: ShortsUploadsService, useValue: {} },
      ] }, { logger: false });
      await app.listen(0, '127.0.0.1'); t.after(() => app.close()); bases.push(await app.getUrl());
    }
    const post = await fetch(`${bases[0]}/shorts/receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer actor' }, body: JSON.stringify({ tx }) });
    assert.equal(post.status, 201); assert.deepEqual(await post.json(), { tx });
    const dashboard = await fetch(`${bases[1]}/shorts/dashboard`, { headers: { Authorization: 'Bearer actor' } });
    assert.equal((await dashboard.json()).receipts[0].tx, tx);
    const otherDashboard = await fetch(`${bases[1]}/shorts/dashboard`, { headers: { Authorization: 'Bearer other' } });
    assert.deepEqual((await otherDashboard.json()).receipts, []);
    const malformed = await fetch(`${bases[0]}/shorts/receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(malformed.status, 400); await malformed.arrayBuffer();
  });
  await t.test('schema downgrade does not discard initialized transaction history', async () => {
    const s = await scope(); await a.record(s, submitted(s)); const before = await rows(s);
    await one.undoLastMigration({ transaction: 'all' }); // Revert upload-budget prerequisites first.
    await one.undoLastMigration({ transaction: 'all' }); // Empty cutover table can be removed.
    await assert.rejects(one.undoLastMigration({ transaction: 'all' }), /Restore\/reconcile/);
    assert.deepEqual(await rows(s), before);
  });
});
