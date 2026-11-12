const {
  ShortsChainIndex,
  ShortsCoverage,
  ShortsMetadata,
  ShortsAnalytics,
  ShortsStudio,
  ShortsReceipts,
} = require('./testing/schema-migrations.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { Contract, encode, decode, Encoding, hash } = require('@aeternity/aepp-sdk');
const camelcaseKeysDeep = require('camelcase-keys-deep');
const { Tx } = require('../mdw-sync/entities/tx.entity');
const { toMdwTx } = require('../mdw-sync/utils/to-mdw-tx');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsIndexService, SHORTS_INDEX_VERSION } = require('./shorts-index.service');
const { ShortsStudioReadService } = require('./shorts-studio-read.service');
const { ShortsBackfillService } = require('../plugins/shorts/shorts-backfill.service');
const { ShortsPluginSyncService } = require('../plugins/shorts/shorts-plugin-sync.service');

// No node, wallet or signing key is used. RPC canonicality is controlled, while
// ABI decoding, middleware normalization, SQL transactions and Studio reads are real.
test('sponsored free Like: PostgreSQL replay, orphan recovery and current-contract Studio counts', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 90000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an isolated local test database');
  const schema = `shorts_free_index_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href });
  await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new DataSource({ type: 'postgres', url: url.href, schema,
    extra: { options: `-c search_path=${schema}`, max: 5 }, entities: [Tx], synchronize: true });
  t.after(async () => {
    if (db.isInitialized) await db.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy();
  });
  await db.initialize();
  await db.query(`CREATE TABLE sync_state(id text PRIMARY KEY,tip_height int,updated_at timestamptz);
    INSERT INTO sync_state VALUES('global',11,now());
    CREATE TABLE plugin_failed_transaction(plugin_name text,tx_hash text);`);
  const runner = { query: (...args) => db.query(...args) };
  for (const Migration of [ShortsChainIndex, ShortsCoverage,
    ShortsMetadata, ShortsAnalytics, ShortsStudio,
    ShortsReceipts]) await new Migration().up(runner);

  const encoded = (value, type) => encode(Buffer.alloc(32, value), type);
  const current = encoded(1, Encoding.ContractAddress), old = encoded(2, Encoding.ContractAddress);
  const actor = encoded(3, Encoding.AccountAddress), payer = encoded(4, Encoding.AccountAddress);
  const creator = encoded(5, Encoding.AccountAddress), outerHash = encoded(6, Encoding.TxHash);
  const micro = encoded(7, Encoding.MicroBlockHash), replacement = encoded(8, Encoding.MicroBlockHash);
  const sourceHash = 'a'.repeat(64), id = 'published-video';
  const paidV2 = encoded(12, Encoding.ContractAddress), artifacts = new Map();
  function abiContract(address, eventName, version) {
    const aci = [{ contract: { name: 'Shorts', kind: 'contract_main',
      functions: [{ name: version === 2 ? 'get_video' : 'get_short', arguments: [{ name: 'id', type: 'string' }],
        returns: 'string', payable: false, stateful: false }], typedefs: [], event: { variant: [
        { [eventName]: eventName === 'PaidLike' && version === 2 ? ['address', 'int', 'int', 'string'] : ['address', 'int', 'string'] },
        { Published: version === 2 ? ['address', 'int', 'string'] : ['address', 'string'] },
      ] } } }];
    artifacts.set(address, { aci });
    const contract = new Contract({ address, aci });
    contract.$call = async (method, args) => {
      assert.equal(method, version === 2 ? 'get_video' : 'get_short');
      assert.deepEqual(args, [id]); return { decodedResult: { creator } };
    };
    return contract;
  }
  const contract = abiContract(current, 'Liked', 2);
  const chain = { contract, state: { contract: current, sourceHash }, release: { schemaVersion: 2, network: 'ae_uat', contract: current, sourceHash } };
  const index = new ShortsIndexService(db, chain, await require('./testing/index-network.cjs').indexNetworkFixture(db, chain));
  const studio = new ShortsStudioReadService(db, chain, index), metadata = new ShortsMetadataService(db);
  for (const address of [old, current]) await metadata.initialize({ network: 'ae_uat', contract: address }, sourceHash);
  await db.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    ['ae_uat', current, id, creator, JSON.stringify({ id, creator, createdAt: 1, title: 'Fixture', publication: 'published' })]);
  await db.query('INSERT INTO shorts_index_backfill(contract,version,complete,covered_height) VALUES($1,$2,true,9)', [current, SHORTS_INDEX_VERSION]);
  const integer = bytes => BigInt(`0x${Buffer.from(bytes).toString('hex')}`).toString();
  function log(address, name, amount) {
    return { address, topics: [integer(hash(Buffer.from(name))), integer(decode(actor)), String(amount)],
      data: encode(Buffer.from(id), Encoding.ContractBytearray) };
  }
  const canonical = new Map([[5, ['mh_old']], [10, [micro]], [11, [replacement]]]);
  const raw = { hash: outerHash, block_height: 10, block_hash: micro, micro_time: 86400100, signatures: [],
    tx: { type: 'PayingForTx', payer_id: payer, nonce: 1, fee: '300000000000000',
      tx: { signatures: [], tx: { type: 'ContractCallTx', caller_id: actor, contract_id: current,
        nonce: 1, amount: 0, function: 'like', return_type: 'ok', log: [log(current, 'Liked', 8)] } } } };
  const repo = db.getRepository(Tx);
  const network = { verify: async () => {}, bindings: () => ({ middleware: 'https://testnet.aeternity.io/mdw' }),
    generation: async height => ({ microBlocks: canonical.get(height) ?? [] }),
    json: async value => {
      const url = new URL(value);
      if (url.pathname.includes('/transactions/')) {
        assert.ok(url.pathname.endsWith('/' + outerHash)); return structuredClone(raw);
      }
      assert.equal(url.searchParams.get('contract_id'), current);
      const [, start, end] = /^gen:(\d+)-(\d+)$/.exec(url.searchParams.get('scope'));
      return { data: raw.block_height >= Number(start) && raw.block_height <= Number(end)
        ? [{ call_tx_hash: outerHash }, { call_tx_hash: outerHash }] : [], next: null };
    } };
  const processor = new ShortsPluginSyncService({}, db, index, network);
  const backfill = () => new ShortsBackfillService(db, network, index, processor, { changed: async () => {} });
  const readStudio = async () => (await studio.page(creator, {}, { ids: [id] })).items[0];
  const events = () => db.query('SELECT tx_hash,log_index,block_height,action,actor,beneficiary,amount::text FROM shorts_chain_events WHERE contract=$1', [current]);
  const coverage = async () => (await db.query('SELECT * FROM shorts_index_backfill WHERE contract=$1', [current]))[0];
  const rewindCoverage = () => db.query('UPDATE shorts_index_backfill SET complete=true,covered_height=9,cursor=null,from_height=null,target_height=null WHERE contract=$1', [current]);
  const tip = height => db.query("UPDATE sync_state SET tip_height=$1,updated_at=now() WHERE id='global'", [height]);
  const paid = toMdwTx(camelcaseKeysDeep({ hash: encoded(10, Encoding.TxHash), block_height: 5,
    block_hash: 'mh_old', micro_time: 86400000, signatures: [], tx: { type: 'ContractCallTx',
      caller_id: actor, contract_id: old, function: 'paid_like', return_type: 'ok', log: [log(old, 'PaidLike', 17)] } }));
  await assert.rejects(processor.processTransaction(paid, 'backward'), /Unrecognized Shorts contract/);

  await t.test('real event decoding and duplicate backfill preserve outer identity and three confirmations', async () => {
    await backfill().run(11, () => false);
    const row = await repo.findOneByOrFail({ hash: outerHash });
    assert.equal(row.type, 'PayingForTx'); assert.equal(row.raw.tx.tx.callerId, actor);
    await processor.processTransaction(row, 'live'); await processor.processTransaction(row, 'backward');
    assert.deepEqual(await events(), [{ tx_hash: outerHash, log_index: 0, block_height: 10,
      action: 'Liked', actor, beneficiary: creator, amount: '0' }]);
    assert.equal((await readStudio()).likes, 0, 'two-confirmation Like is not included');
    await tip(12); assert.equal((await readStudio()).likes, 1);
    const ledger = await index.report(creator, 0, 172800000);
    assert.equal(ledger.paidLikes, 0); assert.equal(ledger.earned, '0');
    assert.equal(ledger.entries.find(entry => entry.action === 'Liked').amount, '0');
  });
  await t.test('orphan removal cascades; stale middleware cannot restore it; same envelope re-includes once', async () => {
    await repo.delete({ hash: outerHash }); await index.removed([outerHash]);
    canonical.set(10, []); await rewindCoverage();
    assert.deepEqual(await events(), []); assert.equal((await readStudio()).likes, 0);
    await assert.rejects(backfill().run(12, () => false), /reorganizing/);
    assert.equal((await coverage()).complete, false); assert.deepEqual(await events(), []);
    assert.equal(await repo.findOneBy({ hash: outerHash }), null);
    raw.block_height = 11; raw.block_hash = replacement;
    await backfill().run(12, () => false); await backfill().run(12, () => false);
    assert.equal((await events()).length, 1); assert.equal((await events())[0].block_height, 11);
    assert.equal((await readStudio()).likes, 0);
    await tip(13); assert.equal((await readStudio()).likes, 1);
  });
  await t.test('failed projection leaves coverage incomplete and a fresh backfill resumes exact identity', async () => {
    await repo.delete({ hash: outerHash }); await rewindCoverage();
    await db.query("ALTER TABLE shorts_chain_events ADD CONSTRAINT injected_failure CHECK(action != 'Liked')");
    await assert.rejects(backfill().run(12, () => false), /injected_failure/);
    assert.deepEqual(await events(), []);
    assert.equal((await repo.findOneByOrFail({ hash: outerHash })).data, null);
    assert.equal((await coverage()).complete, false);
    await db.query('ALTER TABLE shorts_chain_events DROP CONSTRAINT injected_failure');
    await backfill().run(12, () => false);
    assert.equal((await coverage()).complete, true); assert.equal((await events()).length, 1);
    assert.equal((await readStudio()).likes, 1);
  });
  await t.test('a canonical row changing during creator lookup cannot commit a stale projection', async () => {
    await repo.delete({ hash: outerHash });
    const row = toMdwTx(camelcaseKeysDeep(raw)); await repo.save(row);
    const read = contract.$call;
    contract.$call = async (...args) => {
      await repo.update({ hash: outerHash }, { block_hash: micro }); return read(...args);
    };
    try { await assert.rejects(processor.processTransaction(row, 'live'), /changed during indexing/); }
    finally { contract.$call = read; }
    assert.deepEqual(await events(), []);
    assert.equal((await repo.findOneByOrFail({ hash: outerHash })).data, null);
    await repo.update({ hash: outerHash }, { block_hash: replacement });
    await processor.processTransaction(await repo.findOneByOrFail({ hash: outerHash }), 'backward');
    assert.equal((await events()).length, 1); assert.equal((await readStudio()).likes, 1);
  });
  await t.test('reverted sponsored calls preserve the confirmed Like count', async () => {
    const failed = structuredClone(raw); failed.hash = encoded(11, Encoding.TxHash);
    failed.tx.tx.tx.return_type = 'revert';
    const row = toMdwTx(camelcaseKeysDeep(failed)); await repo.save(row);
    await processor.processTransaction(row, 'live');
    assert.equal((await events()).length, 1); assert.equal((await readStudio()).likes, 1);
    assert.equal((await repo.findOneByOrFail({ hash: failed.hash })).data.shorts._version, SHORTS_INDEX_VERSION);
    assert.equal((await index.report(creator, 0, 172800000)).paidLikes, 0);
  });
  await t.test('health detects unprocessed direct, both sponsored shapes and namespaced indirect calls', async () => {
    await tip(13);
    await db.query('UPDATE shorts_index_backfill SET complete=true,covered_height=12');
    assert.equal((await index.health()).stale, false);
    const indirect = encoded(21, Encoding.ContractAddress);
    const candidates = [
      { type: 'ContractCallTx', contract_id: current, raw: {} },
      { type: 'PayingForTx', contract_id: null, raw: { type: 'PayingForTx', tx: { tx: { type: 'ContractCallTx', contractId: current } } } },
      { type: 'PayingForTx', contract_id: null, raw: { type: 'PayingForTx', tx: { type: 'ContractCallTx', contractId: current } } },
      { type: 'ContractCallTx', contract_id: indirect, raw: {}, data: { shorts: { _version: SHORTS_INDEX_VERSION - 1 } } },
      { type: 'PayingForTx', contract_id: null, raw: { type: 'PayingForTx', tx: { tx: { contractId: indirect } } }, data: { shorts: { _version: SHORTS_INDEX_VERSION - 1 } } },
    ];
    for (const [n, candidate] of candidates.entries()) {
      const hash = encoded(30 + n, Encoding.TxHash);
      await repo.save({ ...paid, hash, data: null, ...candidate });
      assert.equal((await index.health()).stale, true, `unprocessed candidate ${n}`);
      await repo.update({ hash }, { data: { shorts: { _version: SHORTS_INDEX_VERSION } } });
      assert.equal((await index.health()).stale, false, `processed candidate ${n}`);
      await repo.delete({ hash });
    }
    for (const [n, candidate] of [
      { type: 'ContractCallTx', contract_id: indirect, raw: {} },
      { type: 'PayingForTx', contract_id: null, raw: { type: 'PayingForTx', tx: { tx: { contractId: indirect } } } },
      { type: 'SpendTx', contract_id: null, raw: {}, data: { shorts: { _version: 0 } } },
    ].entries()) {
      const hash = encoded(40 + n, Encoding.TxHash);
      await repo.save({ ...paid, hash, data: null, ...candidate });
      assert.equal((await index.health()).stale, false, `unrelated candidate ${n}`);
      await repo.delete({ hash });
    }
    await db.query("INSERT INTO plugin_failed_transaction VALUES('shorts',$1)", [outerHash]);
    assert.equal((await index.health()).stale, true);
    await db.query("DELETE FROM plugin_failed_transaction WHERE plugin_name='shorts'");
    assert.equal((await index.health()).stale, false);
  });
});
