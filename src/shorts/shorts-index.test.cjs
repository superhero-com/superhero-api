const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsCoverage1791734400000 } = require('../migrations/1791734400000-ShortsCoverage');
const { ShortsChainIndex1791676800000 } = require('../migrations/1791676800000-ShortsChainIndex');
const { ShortsIndexService } = require('./shorts-index.service');
const { ShortsGateway } = require('./shorts.gateway');
const { ShortsPluginSyncService } = require('../plugins/shorts/shorts-plugin-sync.service');
const { ShortsPlugin } = require('../plugins/shorts/shorts.plugin');
const { ShortsBackfillService } = require('../plugins/shorts/shorts-backfill.service');
const { Tx } = require('../mdw-sync/entities/tx.entity');

test('hosted Shorts index: real PostgreSQL replay, rollback, accounting, backfill and reorg', { skip: !process.env.SHORTS_TEST_PG_URL }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an isolated local test database');
  const schema = `shorts_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new DataSource({ type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 5 }, entities: [Tx], synchronize: true });
  await db.initialize();
  t.after(async () => { await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await db.query('CREATE TABLE sync_state(id text PRIMARY KEY,tip_height int,updated_at timestamptz)');
  await db.query("INSERT INTO sync_state VALUES('global',10,now())");
  await db.query('CREATE TABLE plugin_failed_transaction(plugin_name text,tx_hash text)');
  const migration = new ShortsChainIndex1791676800000();
  await migration.up({ query: (sql, args) => db.query(sql, args) });
  await db.query("INSERT INTO shorts_index_backfill(contract,version,complete,cursor) VALUES('ct_old_checkpoint',1,true,'/v3/contracts/logs?cursor=old')");
  const coverageMigration = new ShortsCoverage1791734400000();
  await coverageMigration.up({ query: (sql, args) => db.query(sql, args) });
  const [upgraded] = await db.query("SELECT * FROM shorts_index_backfill WHERE contract='ct_old_checkpoint'");
  assert.equal(upgraded.complete, false); assert.equal(upgraded.cursor, null);
  assert.equal(upgraded.covered_height, -1); assert.equal(upgraded.target_height, null);
  await db.query("DELETE FROM shorts_index_backfill WHERE contract='ct_old_checkpoint'");
  let badDecode = false;
  const contract = { $options: { address: 'ct_current' },
    $decodeEvents: logs => { if (badDecode) throw new Error('bad event'); return logs.flatMap(log => log.decoded || []); },
    $call: async () => ({ decodedResult: { creator: 'ak_creator' } }),
  };
  const previous = { ...contract, $options: { address: 'ct_previous' } };
  const index = new ShortsIndexService(db, { contract, previous });
  const processor = new ShortsPluginSyncService({}, db, index);
  const repo = db.getRepository(Tx);
  const tx = (hash, events, height = 5, contractId = 'ct_current') => ({
    hash, block_hash: 'mh_canonical', block_height: height, micro_index: '0', micro_time: '86400100',
    signatures: [], type: 'ContractCallTx', contract_id: contractId, caller_id: 'ak_viewer', function: 'paid_like',
    raw: { returnType: 'ok', log: events.map(event => ({ address: contractId, topics: [], decoded: [event] })) },
  });
  const like = { name: 'PaidLike', args: ['ak_viewer', 80000000000000000n, 'video'] };
  // Raw PostgreSQL JSON cannot contain BigInt; the decoder may return one.
  like.args[1] = '80000000000000000';
  const first = tx('th_first', [like]);
  first.data = { another_plugin: { keep: true } };
  await repo.save(first);
  await db.query("INSERT INTO shorts_index_backfill(contract,version,complete,covered_height) VALUES('ct_current',1,true,11),('ct_previous',1,true,11)");

  await t.test('duplicate delivery, previous deployment, and failed calls', async () => {
    await processor.processTransaction(first, 'live'); await processor.processTransaction(first, 'backward');
    const old = tx('th_previous', [like], 5, 'ct_previous'); await repo.save(old); await processor.processTransaction(old, 'live');
    const failed = tx('th_failed', [like]); failed.raw.returnType = 'revert'; await repo.save(failed); await processor.processTransaction(failed, 'live');
    const report = await index.report('ak_creator', 86400000, 172800000);
    assert.equal(report.earned, '0.16'); assert.equal(report.paidLikes, 2); assert.equal(report.stale, false);
    assert.equal((await repo.findOneBy({ hash: first.hash })).data.another_plugin.keep, true);
    assert.equal((await index.report('ak_someone_else', 0, 172800000)).earned, '0');
    assert.equal((await index.report('ak_creator', 0, 172800000, 'other-video')).earned, '0');
  });
  await t.test('decode/storage failure is retryable and cannot stamp a successful version', async () => {
    const row = tx('th_bad', [like]); await repo.save(row); badDecode = true;
    const result = await processor.processBatch([row], 'live'); badDecode = false;
    assert.equal(result.failed.length, 1); assert.equal((await repo.findOneBy({ hash: row.hash })).data, null);
    // A mid-transaction insert failure rolls back both deletion and marker.
    const invalid = tx('th_constraint', [like]); await repo.save(invalid);
    await db.query("ALTER TABLE shorts_chain_events ADD CONSTRAINT reject_test CHECK(tx_hash != 'th_constraint')");
    await assert.rejects(processor.processTransaction(invalid, 'live'));
    assert.equal((await repo.findOneBy({ hash: invalid.hash })).data, null);
    await db.query('ALTER TABLE shorts_chain_events DROP CONSTRAINT reject_test');
    await processor.processTransaction(row, 'live'); await processor.processTransaction(invalid, 'live');
  });
  await t.test('confirmations advance without rescanning history; deleted canonical txs remove revenue', async () => {
    const row = tx('th_pending', [like], 10); await repo.save(row); await processor.processTransaction(row, 'live');
    let report = await index.report('ak_creator', 86400000, 172800000);
    assert.equal(report.pending, 1);
    await db.query("UPDATE sync_state SET tip_height=12,updated_at=now() WHERE id='global'");
    report = await index.report('ak_creator', 86400000, 172800000); assert.equal(report.pending, 0);
    const before = report.paidLikes;
    await repo.delete({ hash: 'th_pending' });
    report = await index.report('ak_creator', 86400000, 172800000); assert.equal(report.paidLikes, before - 1);
    assert.equal(report.entries.some(e => e.tx === 'th_pending'), false);
  });
  await t.test('aggregates and daily charts include more than 2000 events without returning unbounded receipts', async () => {
    // One transaction can emit multiple events; populate a large valid projection.
    await db.query(`INSERT INTO shorts_chain_events SELECT 'ct_current','th_first',i,5,86400100,'PaidLike','ak_viewer','ak_creator',80000000000000000,'video' FROM generate_series(1,2200) AS i`);
    const report = await index.report('ak_creator', 86400000, 172800000);
    assert.equal(report.paidLikes, 2204); assert.equal(report.earned, '176.32');
    assert.equal(report.entries.length, 200); assert.equal(report.truncated, true);
    assert.equal(report.series[0].earnedAe, '176.32');
  });
  await t.test('plugin predicates and version sweep are contract-scoped', async () => {
    const plugin = new ShortsPlugin(repo, {}, processor, index, { changed: async () => {} }, { run: async () => {} });
    assert.equal(plugin.filters()[0].predicate(first), true);
    assert.equal(plugin.filters()[0].predicate({ ...first, contract_id: 'ct_other', raw: { log: [] } }), false);
    assert.equal(plugin.filters()[0].predicate({ ...first, contract_id: 'ct_wrapper' }), true);
    assert.equal(plugin.filters()[0].predicate({ ...first, type: 'SpendTx' }), false);
    const row = tx('th_version', [like]); row.data = { shorts: { _version: 0 } }; await repo.save(row);
    const foreign = tx('th_foreign', [like], 5, 'ct_other'); await repo.save(foreign);
    const pending = await plugin.getUpdateQueries(1)[0](repo, 100);
    assert.deepEqual(pending.map(item => item.hash), ['th_version']);
    await plugin.updateTransactions();
    assert.equal((await repo.findOneBy({ hash: row.hash })).data.shorts._version, 1);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM shorts_chain_events WHERE tx_hash='th_version'"))[0].n, 1);
    plugin.onModuleDestroy();
  });
  await t.test('contract catch-up resumes a failed page and never marks incomplete history complete', async () => {
    await db.query("DELETE FROM shorts_index_backfill WHERE contract='ct_current'");
    const raw = { hash: 'th_catchup', block_height: 5, block_hash: 'mh_canonical', micro_time: 86400100, signatures: [], tx: { type: 'ContractCallTx', contract_id: 'ct_current', caller_id: 'ak_viewer', return_type: 'ok', log: [{ address: 'ct_current', topics: [], decoded: [] }] } };
    let requests = 0, fail = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => { requests++; if (fail) throw new Error('offline'); return new Response(JSON.stringify(url.includes('/contracts/logs') ? { data: [{ call_tx_hash: raw.hash }], next: null } : raw)); };
    const backfill = new ShortsBackfillService(db, { get: () => 'https://testnet.aeternity.io/mdw' }, { sdk: { api: { getGenerationByHeight: async () => ({ microBlocks: ['mh_canonical'] }) } } }, index, processor, { changed: async () => {} });
    try {
      await assert.rejects(backfill.run(12, () => false), /offline/);
      assert.equal((await db.query("SELECT complete FROM shorts_index_backfill WHERE contract='ct_current'"))[0].complete, false);
      fail = false; await backfill.run(12, () => false); await backfill.run(12, () => false);
      assert.equal(requests, 3);
      assert.equal((await repo.findOneBy({ hash: raw.hash })).data.shorts._version, 1);
    } finally { globalThis.fetch = originalFetch; }
  });
  await t.test('shared sync recovers a long outage and resumes the exact failed page after restart', async () => {
    const { IndexerService } = require('../mdw-sync/services/indexer.service');
    const { PluginRegistryService } = require('../mdw-sync/services/plugin-registry.service');
    await db.query("UPDATE sync_state SET tip_height=1000,updated_at=now() WHERE id='global'");
    await db.query("UPDATE shorts_index_backfill SET covered_height=CASE WHEN contract='ct_current' THEN 1000 ELSE 1299 END,complete=true,cursor=null,target_height=null,from_height=null");
    const raw = { hash: 'th_gap', block_height: 1100, block_hash: 'mh_canonical', micro_time: 86400100, signatures: [], tx: { type: 'ContractCallTx', function: 'paid_like', contract_id: 'ct_current', caller_id: 'ak_viewer', return_type: 'ok', log: [{ address: 'ct_current', topics: [], decoded: [{ ...like, args: ['ak_viewer', '80000000000000000', 'gap-video'] }] }] } };
    const originalFetch = globalThis.fetch;
    const calls = []; let fail = true, tip = 1300;
    const config = { get: (key, fallback) => key === 'mdw.middlewareUrl' ? 'https://testnet.aeternity.io/mdw' : fallback };
    const gateway = { changed: async () => {} };
    const ae = { sdk: { api: { getGenerationByHeight: async () => ({ microBlocks: ['mh_canonical'] }) } } };
    const plugins = [];
    function indexer() {
      const backfill = new ShortsBackfillService(db, config, ae, index, processor, gateway);
      const plugin = new ShortsPlugin(repo, {}, processor, index, gateway, backfill); plugins.push(plugin);
      const registry = new PluginRegistryService([plugin], {});
      const state = { findOne: async () => ({ ...(await db.query("SELECT * FROM sync_state WHERE id='global'"))[0], backward_synced_height: 0 }),
        update: async (_, values) => db.query("UPDATE sync_state SET tip_height=$1,updated_at=now() WHERE id='global'", [values.tip_height]) };
      return new IndexerService(repo, {}, {}, state, {}, {}, config, db, {}, {}, registry, {}, {});
    }
    globalThis.fetch = async value => {
      const url = new URL(value);
      if (url.pathname.endsWith('/status')) return new Response(JSON.stringify({ mdw_height: tip }));
      if (url.pathname.includes('/transactions/')) return new Response(JSON.stringify(raw));
      calls.push(url);
      const scope = url.searchParams.get('scope');
      if (scope === 'gen:1001-1299') {
        if (url.searchParams.has('cursor')) {
          if (fail) throw new Error('interrupted page');
          return new Response(JSON.stringify({ data: [], next: null }));
        }
        url.searchParams.set('cursor', 'page2');
        return new Response(JSON.stringify({ data: [{ call_tx_hash: raw.hash }], next: url.href }));
      }
      return new Response(JSON.stringify({ data: [], next: null }));
    };
    try {
      await indexer().sync();
      let state = (await db.query("SELECT * FROM shorts_index_backfill WHERE contract='ct_current'"))[0];
      assert.equal(state.covered_height, 1000); assert.equal(state.complete, false);
      assert.match(state.cursor, /page2/);
      assert.equal((await index.report('ak_creator', 0, 172800000)).stale, true, 'fresh heartbeat must not hide a coverage gap');
      fail = false;
      await indexer().sync(); // New process/service, same durable checkpoint.
      state = (await db.query("SELECT * FROM shorts_index_backfill WHERE contract='ct_current'"))[0];
      assert.equal(state.covered_height, 1299); assert.equal(state.complete, true);
      assert.equal(calls.length, 3); assert.ok(calls[2].searchParams.has('cursor'));
      assert.equal((await index.report('ak_creator', 0, 172800000, 'gap-video')).earned, '0.08');
      assert.equal((await index.report('ak_creator', 0, 172800000)).stale, false);
      // The same checkpoint handles a later disabled-feature/disconnected interval.
      tip = 1600; await db.query("UPDATE sync_state SET tip_height=1600,updated_at=now()");
      assert.equal((await index.report('ak_creator', 0, 172800000)).stale, true);
      await indexer().sync();
      assert.ok(calls.some(url => url.searchParams.get('scope') === 'gen:1300-1599'));
      assert.equal((await index.report('ak_creator', 0, 172800000)).stale, false);
      const before = calls.length; await indexer().sync(); assert.equal(calls.length, before, 'closed range is not rescanned every tick');
    } finally { globalThis.fetch = originalFetch; plugins.forEach(plugin => plugin.onModuleDestroy()); }
  });
  await t.test('indirect contract calls are indexed and committed updates reach the gateway', async () => {
    const gateway = new ShortsGateway(db, index);
    const emitted = []; gateway.server = { emit: (...args) => emitted.push(args) };
    await gateway.onApplicationBootstrap();
    try {
      emitted.length = 0;
      const indirect = { ...tx('th_indirect', [like]), contract_id: 'ct_wrapper' };
      await repo.save(indirect); await processor.processTransaction(indirect, 'live');
      for (let i = 0; i < 50 && !emitted.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(emitted.some(([event, payload]) => event === 'shorts-updated' && payload.contract === 'ct_current'));
      assert.equal((await db.query("SELECT beneficiary FROM shorts_chain_events WHERE tx_hash='th_indirect'"))[0].beneficiary, 'ak_creator');
      emitted.length = 0;
      await db.query("SELECT pg_notify('shorts_updated',$1)", [JSON.stringify({ network: 'ae_mainnet', contract: 'ct_current' })]);
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(emitted.length, 0);
    } finally { await gateway.onModuleDestroy(); }
  });
  await t.test('failed shared plugin jobs keep reports explicitly stale', async () => {
    await db.query("INSERT INTO plugin_failed_transaction VALUES('shorts','th_delayed')");
    assert.equal((await index.report('ak_creator', 0, 172800000)).stale, true);
    await index.removed(['th_delayed']);
    assert.equal((await index.report('ak_creator', 0, 172800000)).stale, false);
  });
  await t.test('hosted feature and plugin resolve one shared chain, store and event index', async () => {
    const { Test } = require('@nestjs/testing');
    const { Module, Global } = require('@nestjs/common');
    const { DatabaseSync } = require('node:sqlite');
    const { ShortsTestnetModule } = require('./shorts.module');
    const { ShortsPluginModule } = require('../plugins/shorts/shorts-plugin.module');
    const { ShortsChainService } = require('./shorts-chain.service');
    const { ShortsStoreService } = require('./shorts-store.service');
    const { ShortsLedgerService } = require('./shorts-ledger.service');
    const { ShortsService } = require('./shorts.service');
    const { AeModule } = require('../ae/ae.module');
    const { AeSdkService } = require('../ae/ae-sdk.service');
    class TestDatabaseModule {};
    Global()(TestDatabaseModule);
    Module({ providers: [{ provide: DataSource, useValue: db }], exports: [DataSource] })(TestDatabaseModule);
    class TestAeModule {};
    Module({ providers: [{ provide: AeSdkService, useValue: {} }], exports: [AeSdkService] })(TestAeModule);
    const sqlite = new DatabaseSync(':memory:');
    const savedNetwork = process.env.AE_NETWORK_ID;
    process.env.AE_NETWORK_ID = 'ae_uat';
    let module;
    try {
      module = await Test.createTestingModule({ imports: [TestDatabaseModule, await ShortsTestnetModule.register(true), ShortsPluginModule] })
        .overrideModule(AeModule).useModule(TestAeModule)
        .overrideProvider(ShortsChainService).useValue({ contract, previous })
        .overrideProvider(ShortsStoreService).useValue({ db: sqlite }).compile();
      assert.equal(module.get(ShortsService).ledger, module.get(ShortsIndexService));
      assert.equal(module.get(ShortsLedgerService), module.get(ShortsIndexService));
      assert.equal(module.get(ShortsService).chain, module.get(ShortsChainService));
      assert.equal(module.get('SHORTS_MDW_PLUGIN'), module.get(ShortsPlugin));
    } finally {
      if (module) await module.close();
      sqlite.close();
      if (savedNetwork === undefined) delete process.env.AE_NETWORK_ID; else process.env.AE_NETWORK_ID = savedNetwork;
    }
  });
  await coverageMigration.down({ query: (sql, args) => db.query(sql, args) });
  await migration.down({ query: (sql, args) => db.query(sql, args) });
});
