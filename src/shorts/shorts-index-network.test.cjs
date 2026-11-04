require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Encoding, encode } = require('@aeternity/aepp-sdk');
const { ShortsIndexNetworkService } = require('./shorts-index-network.service');
const { ShortsIndexService } = require('./shorts-index.service');
const { ShortsIndexNetwork1791763228000 } = require('../migrations/1791763228000-ShortsIndexNetwork');
const keyHash = () => encode(randomBytes(32), Encoding.KeyBlockHash);

function runtime(network = 'ae_uat') {
  const reads = [], blocks = new Map();
  const release = { network, contract: 'ct_fixture', node: 'http://127.0.0.1:12345' };
  const observed = { network, during: async () => {} };
  const node = { $host: release.node,
    getStatus: async () => { reads.push('status'); return { networkId: observed.network }; },
    getKeyBlockByHeight: async height => { reads.push(height); await observed.during(height); return { height, hash: blocks.get(height) }; },
  };
  const chain = { release, state: { contract: release.contract }, sdk: { api: node }, readNode: async (task, signal) => {
    signal?.throwIfAborted(); const result = await task(); signal?.throwIfAborted(); return result;
  } };
  return { chain, blocks, observed, reads };
}

test('index ownership rejects missing deployment identity before touching SQL', async () => {
  for (const chain of [{}, { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_other' } }]) {
    const service = new ShortsIndexNetworkService({ transaction: () => assert.fail('must not reach SQL') }, chain);
    await assert.rejects(service.ensure(), { status: 503 });
  }
});

test('ledger reads, health and rollback stop before SQL when index ownership is unavailable', async () => {
  const fail = async () => { throw new Error('Unbound index'); };
  const index = new ShortsIndexService({ query: () => assert.fail('must not read SQL'), transaction: () => assert.fail('must not start accounting') }, {}, { ensure: fail });
  await assert.rejects(index.health(), /Unbound/);
  await assert.rejects(index.report('ak_fixture', 0, 1), /Unbound/);
  await assert.rejects(index.removed(['th_fixture']), /Unbound/);
});

test('persistent index ownership with real PostgreSQL', { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an owned local test database');
  const admin = await new DataSource({ type: 'postgres', url: url.href }).initialize();
  t.after(() => admin.destroy());
  async function fixture(t) {
    const schema = 'index_network_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = await new DataSource({ type: 'postgres', url: url.href, schema,
      extra: { options: `-c search_path=${schema}`, max: 4, statement_timeout: 8000, lock_timeout: 5000 } }).initialize();
    t.after(async () => { await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
    await db.query(`CREATE TABLE key_blocks(height integer PRIMARY KEY, hash text NOT NULL);
      CREATE TABLE txs(hash text PRIMARY KEY);
      CREATE TABLE shorts_chain_events(tx_hash text PRIMARY KEY);
      CREATE TABLE shorts_index_backfill(contract text PRIMARY KEY);`);
    const migration = new ShortsIndexNetwork1791763228000();
    const migrate = method => db.transaction(manager => migration[method](manager.queryRunner));
    await migrate('up');
    const row = async () => (await db.query('SELECT * FROM shorts_index_network'))[0];
    const bind = f => new ShortsIndexNetworkService(db, f.chain);
    return { db, row, bind, migrate, schema };
  }
  for (const network of ['ae_uat', 'ae_mainnet']) {
    await t.test(`${network}: fresh ownership survives restarts and refuses the other network`, async t => {
      const f = await fixture(t), first = runtime(network);
      const service = f.bind(first);
      await Promise.all([service.ensure(), service.onModuleInit(), service.ensure()]);
      assert.equal(first.reads.length, 2, 'one coalesced startup validation');
      assert.equal((await f.row()).network, network); assert.equal((await f.row()).anchor_hash, null);
      const restart = runtime(network); await f.bind(restart).ensure();
      assert.equal(restart.reads.length, 0, 'persisted ownership does not need history adoption again');
      const changed = runtime(network === 'ae_uat' ? 'ae_mainnet' : 'ae_uat');
      await assert.rejects(f.bind(changed).ensure(), /another network/);
      assert.equal(changed.reads.length, 0);
      first.chain.release.network = changed.chain.release.network;
      await assert.rejects(service.ensure(), { status: 503 });
      assert.equal((await f.row()).network, network);
    });
    await t.test(`${network}: populated history adopts only after both stored endpoints match`, async t => {
      const f = await fixture(t), input = runtime(network);
      input.blocks.set(12, keyHash()); input.blocks.set(450, keyHash());
      for (const [height, hash] of input.blocks) await f.db.query('INSERT INTO key_blocks VALUES($1,$2)', [height, hash]);
      await f.db.query("INSERT INTO txs VALUES('th_preserved'); INSERT INTO shorts_chain_events VALUES('th_preserved')");
      await f.bind(input).ensure();
      assert.deepEqual(input.reads.filter(Number.isInteger).sort((a,b) => a-b), [12,450]);
      const row = await f.row(); assert.equal(row.network, network); assert.equal(row.anchor_height, 12); assert.equal(row.anchor_hash, input.blocks.get(12));
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM txs'))[0].n, 1);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM shorts_chain_events'))[0].n, 1);
    });
  }
  await t.test('concurrent cross-network startup admits exactly one durable owner', async t => {
    const f = await fixture(t), left = runtime(), right = runtime('ae_mainnet');
    const results = await Promise.allSettled([f.bind(left).ensure(), f.bind(right).ensure()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const failed = results.find(r => r.status === 'rejected'); assert.match(failed.reason.message, /another network/);
    const winner = results[0].status === 'fulfilled' ? left : right;
    assert.equal((await f.row()).network, winner.chain.release.network);
  });
  await t.test('node mismatch, history disagreement and missing block leave no binding and permit corrected retry', async t => {
    const f = await fixture(t), input = runtime(), service = f.bind(input);
    input.observed.network = 'ae_mainnet';
    await assert.rejects(service.ensure(), /network mismatch/); assert.equal(await f.row(), undefined);
    input.observed.network = 'ae_uat';
    const stored = keyHash(); await f.db.query('INSERT INTO key_blocks VALUES(5,$1)', [stored]);
    input.blocks.set(5, keyHash());
    await assert.rejects(service.ensure(), /disagrees/); assert.equal(await f.row(), undefined);
    input.blocks.delete(5);
    await assert.rejects(service.ensure(), /disagrees/); assert.equal(await f.row(), undefined);
    input.blocks.set(5, stored); await service.ensure(); assert.equal((await f.row()).anchor_hash, stored);
  });
  await t.test('orphaned history and malformed anchors cannot be silently relabelled', async t => {
    const f = await fixture(t), input = runtime(), service = f.bind(input);
    await f.db.query("INSERT INTO txs VALUES('th_orphan')");
    await assert.rejects(service.ensure(), /no verifiable block/); assert.equal(await f.row(), undefined);
    await f.db.query("INSERT INTO key_blocks VALUES(1,'kh_invalid')");
    await assert.rejects(service.ensure(), /Invalid stored/); assert.equal(await f.row(), undefined);
  });
  await t.test('network or selected-node change during adoption rolls back ownership', async t => {
    const f = await fixture(t);
    const hash = keyHash(); await f.db.query('INSERT INTO key_blocks VALUES(4,$1)', [hash]);
    for (const change of ['network', 'node', 'release']) {
      const input = runtime(); input.blocks.set(4, hash);
      input.observed.during = async () => {
        if (change === 'network') input.observed.network = 'ae_mainnet';
        if (change === 'node') input.chain.sdk.api = { ...input.chain.sdk.api };
        if (change === 'release') input.chain.release = { ...input.chain.release };
      };
      await assert.rejects(f.bind(input).ensure(), { status: 503 }); assert.equal(await f.row(), undefined);
    }
  });
  await t.test('history writes wait during first adoption and continue after its commit', async t => {
    const f = await fixture(t), input = runtime(); input.blocks.set(3, keyHash());
    await f.db.query('INSERT INTO key_blocks VALUES(3,$1)', [input.blocks.get(3)]);
    let entered, release; const reached = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    input.observed.during = async () => { entered(); await hold; };
    const binding = f.bind(input).ensure(); await reached;
    let wrote = false; const writing = f.db.query("INSERT INTO txs VALUES('th_later')").then(() => { wrote = true; });
    try {
      const deadline = Date.now() + 3000; let waiting = false;
      while (Date.now() < deadline) {
        const [state] = await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE '%th_later%' AND wait_event_type='Lock') AS waiting");
        if (state.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'writer must actually wait for the history lock');
      assert.equal(wrote, false);
    } finally { release(); }
    await Promise.all([binding, writing]); assert.equal(wrote, true); assert.ok(await f.row());
  });
  await t.test('first adoption works with the documented indexer grants without database ownership', async t => {
    const f = await fixture(t), role = 'index_boot_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    t.after(async () => { await admin.query(`DROP OWNED BY ${role}`); await admin.query(`DROP ROLE ${role}`); });
    await admin.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
    await f.db.query(`GRANT SELECT,INSERT,UPDATE ON shorts_index_network TO ${role}`);
    await f.db.query(`GRANT SELECT,UPDATE ON key_blocks,txs TO ${role}`);
    await f.db.query(`GRANT SELECT ON shorts_chain_events,shorts_index_backfill TO ${role}`);
    await f.db.transaction(async manager => {
      await manager.query(`SET LOCAL ROLE ${role}`);
      await new ShortsIndexNetworkService(manager, runtime().chain).ensure();
    });
    assert.equal((await f.row()).network, 'ae_uat');
  });
  await t.test('read-only API roles reuse a binding without write or lock privileges', async t => {
    const f = await fixture(t), role = 'index_reader_' + randomUUID().replaceAll('-', '');
    await f.bind(runtime()).ensure();
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    t.after(async () => { await admin.query(`DROP OWNED BY ${role}`); await admin.query(`DROP ROLE ${role}`); });
    await admin.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
    await f.db.query(`GRANT SELECT ON shorts_index_network TO ${role}`);
    await f.db.transaction(async manager => {
      await manager.query(`SET LOCAL ROLE ${role}`);
      await new ShortsIndexNetworkService(manager, runtime().chain).ensure();
      await assert.rejects(new ShortsIndexNetworkService(manager, runtime('ae_mainnet').chain).ensure(), /another network/);
    });
  });
  await t.test('migration is reversible before binding and refuses loss or mutation afterward', async t => {
    const f = await fixture(t); await f.migrate('down'); await f.migrate('up');
    await f.bind(runtime()).ensure();
    for (const sql of ["UPDATE shorts_index_network SET network='ae_mainnet'", 'DELETE FROM shorts_index_network', 'TRUNCATE shorts_index_network'])
      await assert.rejects(f.db.query(sql), /immutable/);
    await assert.rejects(f.db.query("INSERT INTO shorts_index_network(singleton,network) VALUES(false,'ae_uat')"), /check constraint/);
    await assert.rejects(f.migrate('down'), /Cannot remove a bound/);
    assert.equal((await f.row()).network, 'ae_uat');
  });
});
