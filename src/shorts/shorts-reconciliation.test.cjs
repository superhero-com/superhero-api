require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { DataSource } = require('typeorm');
const { encode, Encoding } = require('@aeternity/aepp-sdk');
const { ShortsReconciliationService } = require('./shorts-reconciliation.service');
const { ShortsIndexService } = require('./shorts-index.service');
const { ShortsChainIndex1791676800000 } = require('../migrations/1791676800000-ShortsChainIndex');
const { ShortsCoverage1791734400000 } = require('../migrations/1791734400000-ShortsCoverage');
const { Tx } = require('../mdw-sync/entities/tx.entity');
const address = () => encode(randomBytes(32), Encoding.AccountAddress);
const keyHash = () => encode(randomBytes(32), Encoding.KeyBlockHash);
const rejects = (promise, status, message) => assert.rejects(promise, error => error.getStatus?.() === status && (!message || message.test(error.message)));

test('operator accounting HTTP authorizes before work, applies private rate policy and forbids response caching', async t => {
  const { NestFactory } = require('@nestjs/core');
  const { UnauthorizedException, ForbiddenException } = require('@nestjs/common');
  const { ShortsController } = require('./shorts.controller');
  const { ShortsService } = require('./shorts.service');
  const { ShortsAuthService } = require('./shorts-auth.service');
  const { ShortsUploadsService } = require('./shorts-uploads.service');
  const { ShortsRateService } = require('./shorts-rate.service');
  const { ShortsAuthGuard } = require('./shorts-auth.guard');
  const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
  let calls = 0; const policies = [];
  const auth = {
    shared: true,
    authenticate: async token => { if (!['Bearer operator', 'Bearer creator'].includes(token)) throw new UnauthorizedException(); return token; },
    operator: async token => { await auth.authenticate(token); if (token !== 'Bearer operator') throw new ForbiddenException(); },
  };
  const app = await NestFactory.create({ module: class ReconciliationHttp {}, controllers: [ShortsController], providers: [
    ShortsAuthGuard, ShortsUploadInterceptor,
    { provide: ShortsService, useValue: {} }, { provide: ShortsAuthService, useValue: auth },
    { provide: ShortsUploadsService, useValue: {} },
    { provide: ShortsRateService, useValue: { config: { client: () => '127.0.0.1' }, request: async policy => policies.push(policy), actor: async () => {} } },
    { provide: ShortsReconciliationService, useValue: { compare: async input => { calls++; return { scope: 'contract_summary_and_account_page', input }; } } },
  ] }, { logger: false });
  t.after(() => app.close()); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = token => fetch(base + '/shorts/operator/reconciliation?height=9&blockHash=kh_fixture&after=ak_fixture', { headers: token ? { authorization: token } : {} });
  assert.equal((await request()).status, 401);
  assert.equal((await request('Bearer creator')).status, 403); assert.equal(calls, 0);
  const response = await request('Bearer operator');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).input, { height: '9', blockHash: 'kh_fixture', after: 'ak_fixture' });
  assert.equal(calls, 1); assert.ok(policies.every(policy => policy.group === 'operator' && policy.private));
});

for (const releaseNetwork of ['ae_uat', 'ae_mainnet']) test(`fixed-block accounting with real PostgreSQL snapshots on ${releaseNetwork}`, { skip: !process.env.SHORTS_TEST_PG_URL }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an isolated local database');
  const schema = `reconciliation_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new DataSource({ type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 5 }, entities: [Tx], synchronize: true });
  await db.initialize();
  t.after(async () => { await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await db.query('CREATE TABLE sync_state(id text PRIMARY KEY,tip_height int,updated_at timestamptz)');
  await db.query("INSERT INTO sync_state VALUES('global',10,now())");
  await db.query('CREATE TABLE plugin_failed_transaction(plugin_name text,tx_hash text)');
  await new ShortsChainIndex1791676800000().up({ query: (sql, args) => db.query(sql, args) });
  await new ShortsCoverage1791734400000().up({ query: (sql, args) => db.query(sql, args) });
  const contractId = encode(randomBytes(32), Encoding.ContractAddress), treasury = address(), creator = address(), viewer = address();
  const fee = 100000000000000003n, cut = fee * 2000n / 10000n, share = fee - cut;
  let hash = keyHash(), tip = 10, network = releaseNetwork, config, liability, balance, readFailure, duringRead;
  let observed = new Map(), reads = [], calls = [], gates = [];
  const node = { $host: 'http://127.0.0.1:12345', getStatus: async () => ({ networkId: network }), getCurrentKeyBlock: async () => ({ height: tip }), getKeyBlockByHeight: async height => ({ height, hash }) };
  const contract = { $options: { address: contractId }, $call: async (method, args, options) => {
    calls.push(method); reads.push(options);
    if (readFailure) throw new Error('Controlled node outage');
    if (duringRead) await duringRead(method);
    if (method === 'get_config') return { decodedResult: config };
    if (method === 'get_liabilities') return { decodedResult: [liability, balance] };
    assert.equal(method, 'get_account'); return { decodedResult: observed.get(args[0]) || { earned: 0n, claimed: 0n, available: 0n } };
  } };
  const chain = { release: { network: releaseNetwork, contract: contractId, node: node.$host }, state: { contract: contractId }, contract, sdk: { api: node }, readNode: async task => task() };
  const index = new ShortsIndexService(db, chain, await require('./testing/index-network.cjs').indexNetworkFixture(db, chain)), service = new ShortsReconciliationService(db, chain, index);
  const repo = db.getRepository(Tx);
  const seed = async (action, beneficiary, amount, height = 5, actor = action === 'Claimed' ? beneficiary : viewer) => {
    const txHash = encode(randomBytes(32), Encoding.TxHash);
    await repo.save({ hash: txHash, block_hash: encode(randomBytes(32), Encoding.MicroBlockHash), block_height: height,
      micro_index: '0', micro_time: '86400100', signatures: [], type: 'ContractCallTx', contract_id: contractId,
      caller_id: actor, function: action === 'Claimed' ? 'claim' : 'paid_like', raw: { returnType: 'ok', log: [] }, data: { shorts: { _version: 1, data: { events: 1 } } } });
    await db.query('INSERT INTO shorts_chain_events(contract,tx_hash,log_index,block_height,at,action,actor,beneficiary,amount) VALUES($1,$2,0,$3,86400100,$4,$5,$6,$7)', [contractId, txHash, height, action, actor, beneficiary, amount.toString()]);
    if (height < 9) {
      const credit = (a, earned, claimed) => { const v = observed.get(a) || { earned: 0n, claimed: 0n, available: 0n }; v.earned += earned; v.claimed += claimed; v.available = v.earned - v.claimed; observed.set(a, v); };
      if (action === 'PaidLike') { credit(beneficiary, amount, 0n); credit(treasury, cut, 0n); liability += amount + cut; }
      else if (action === 'Claimed') { credit(actor, 0n, amount); liability -= amount; }
      balance = liability;
    }
    return txHash;
  };
  const reset = async () => {
    chain.previous = undefined;
    await db.query('TRUNCATE txs CASCADE'); await db.query('TRUNCATE plugin_failed_transaction,shorts_index_backfill');
    await db.query("UPDATE sync_state SET tip_height=10,updated_at=now()");
    await db.query('INSERT INTO shorts_index_backfill(contract,version,complete,covered_height) VALUES($1,1,true,9)', [contractId]);
    hash = keyHash(); tip = 10; network = releaseNetwork; config = [viewer, treasury, fee, 2000n];
    liability = 0n; balance = 0n; observed = new Map(); reads = []; calls = []; readFailure = false; duringRead = undefined; gates = [];
  };
  await t.test('exact integer split, creator and treasury claims, and exclusion of the anchor generation', async () => {
    await reset(); await seed('PaidLike', creator, share); await seed('PaidLike', creator, share);
    await seed('Claimed', creator, share * 2n, 6); await seed('Claimed', treasury, cut * 2n, 7);
    await seed('PaidLike', creator, share, 9);
    const result = await service.compare({});
    assert.equal(result.network, releaseNetwork);
    assert.deepEqual(result.block, { height: 9, hash, throughGeneration: 8 });
    assert.equal(result.summary.paidLikes, '2'); assert.equal(result.summary.creatorCredits, (share * 2n).toString());
    assert.equal(result.summary.treasuryCredits, (cut * 2n).toString()); assert.equal(result.summary.claimed, (fee * 2n).toString());
    assert.equal(result.summary.expectedLiability, '0'); assert.equal(result.summary.liabilitiesMatch, true);
    assert.equal(result.summary.solvent, true); assert.equal(result.accounts.checked, 2);
    assert.ok(result.accounts.items.every(a => a.matches && a.onChain.available === '0'));
    assert.ok(reads.every(v => v.callStatic === true && v.top === hash), 'all observations use the same immutable key-block hash');
  });
  await t.test('creator and treasury identity receive both credits exactly once', async () => {
    await reset(); await seed('PaidLike', treasury, share); await seed('Claimed', treasury, fee);
    const result = await service.compare({}); assert.equal(result.accounts.checked, 1);
    assert.deepEqual(result.accounts.items[0].indexed, { earned: fee.toString(), claimed: fee.toString(), available: '0' });
    assert.equal(result.accounts.items[0].matches, true);
  });
  await t.test('account pages are ordered, bounded and require the original hash', async () => {
    await reset(); const creators = Array.from({ length: 12 }, address);
    for (const value of creators) await seed('PaidLike', value, share);
    const all = [], first = await service.compare({}); let page = first;
    while (true) {
      assert.ok(page.accounts.checked <= 5); all.push(...page.accounts.items.map(a => a.address));
      if (!page.accounts.next) break;
      page = await service.compare({ height: String(first.block.height), blockHash: first.block.hash, after: page.accounts.next });
    }
    assert.deepEqual(all, [...creators, treasury].sort());
    await rejects(service.compare({ after: all[0] }), 400);
    const previous = hash; hash = keyHash();
    await rejects(service.compare({ height: '9', blockHash: previous, after: all[0] }), 409);
  });
  await t.test('surplus balance, insolvency, total mismatch and individual mismatch remain distinct', async () => {
    await reset(); await seed('PaidLike', creator, share); balance += 17n;
    let result = await service.compare({}); assert.equal(result.summary.unallocatedBalance, '17'); assert.equal(result.summary.liabilitiesMatch, true);
    observed.get(creator).earned += 1n; result = await service.compare({});
    assert.equal(result.summary.liabilitiesMatch, true); assert.equal(result.accounts.items.find(a => a.address === creator).matches, false);
    liability += 2n; balance = 0n; result = await service.compare({});
    assert.equal(result.summary.liabilitiesMatch, false); assert.equal(result.summary.liabilityDifference, '2'); assert.equal(result.summary.solvent, false);
    await db.query("UPDATE shorts_chain_events SET amount=amount+1 WHERE action='PaidLike'");
    result = await service.compare({}); assert.equal(result.summary.invalidEvents, '1'); assert.equal(result.summary.liabilitiesMatch, false);
  });
  await t.test('missing, stale and inconsistent projections cannot report a match', async () => {
    await reset(); const tx = await seed('PaidLike', creator, share);
    await db.query('DELETE FROM shorts_chain_events WHERE tx_hash=$1', [tx]);
    await rejects(service.compare({}), 503, /projection/);
    await reset(); await seed('PaidLike', creator, share); await db.query('UPDATE shorts_chain_events SET at=at+1');
    await rejects(service.compare({}), 503, /projection/);
    await reset(); await db.query("UPDATE sync_state SET updated_at=now()-interval '3 minutes'");
    await rejects(service.compare({}), 503, /incomplete/);
    await reset(); await db.query('UPDATE shorts_index_backfill SET complete=false');
    await rejects(service.compare({}), 503, /incomplete/);
    await reset(); await db.query("INSERT INTO plugin_failed_transaction VALUES('shorts','th_failure')");
    await rejects(service.compare({}), 503, /incomplete/);
  });
  await t.test('wrapped calls use the shared event-count marker across recognized deployments', async () => {
    await reset(); const tx = await seed('PaidLike', creator, share);
    const previous = encode(randomBytes(32), Encoding.ContractAddress);
    chain.previous = { $options: { address: previous } };
    await db.query('INSERT INTO shorts_index_backfill(contract,version,complete,covered_height) VALUES($1,1,true,9)', [previous]);
    await db.query('UPDATE txs SET contract_id=$2,raw=$3,data=$4 WHERE hash=$1', [tx, encode(randomBytes(32), Encoding.ContractAddress),
      { log: [{ address: contractId }, { address: previous }] }, { shorts: { _version: 1, data: { events: 2 } } }]);
    await db.query("INSERT INTO shorts_chain_events(contract,tx_hash,log_index,block_height,at,action,actor,beneficiary,amount) VALUES($1,$2,1,5,86400100,'Published',$3,$3,0)", [previous, tx, creator]);
    assert.equal((await service.compare({})).summary.liabilitiesMatch, true);
    await db.query('DELETE FROM shorts_chain_events WHERE contract=$1', [previous]);
    await rejects(service.compare({}), 503, /projection/);
  });
  await t.test('untrusted input and node responses fail before a misleading result', async () => {
    await reset();
    for (const input of [{ contract: 'ct_unknown' }, { height: '0' }, { height: '10' }, { height: '-2' }, { height: '1e3' }, { blockHash: hash }, { height: '9', blockHash: 'kh_broken' }, { height: ['9'] }]) await rejects(service.compare(input), 400);
    network = releaseNetwork === 'ae_uat' ? 'ae_mainnet' : 'ae_uat'; await rejects(service.compare({}), 503, /network/); network = releaseNetwork;
    config[2] = Number(fee); await rejects(service.compare({}), 503, /observation/);
    config = []; await rejects(service.compare({}), 503, /artifact/);
    await reset(); config[3] = 10001n; await rejects(service.compare({}), 503, /configuration/);
  });
  await t.test('canonical anchor is rechecked after account reads', async () => {
    await reset(); await seed('PaidLike', creator, share);
    duringRead = async method => { if (method === 'get_account') hash = keyHash(); };
    await rejects(service.compare({}), 409);
    await reset(); duringRead = async method => { if (method === 'get_account') tip = 9; };
    await rejects(service.compare({}), 409);
  });
  await t.test('concurrent admission is bounded and failures release it', async () => {
    await reset(); duringRead = async method => { if (method === 'get_config') await new Promise(resolve => gates.push(resolve)); };
    const pending = service.compare({});
    while (!gates.length) await new Promise(resolve => setImmediate(resolve));
    await rejects(service.compare({}), 503, /busy/); gates[0](); await pending; duringRead = undefined;
    readFailure = true; await assert.rejects(service.compare({}), /outage/); readFailure = false;
    assert.equal((await service.compare({})).summary.liabilitiesMatch, true);
  });
  await t.test('deployment or node changes during successful and failing observations never report a match', async () => {
    for (const failing of [false, true]) {
      for (const change of ['live-network', 'release-network', 'release-reference', 'selected-node', 'node-host', 'contract-instance']) {
        await reset(); await seed('PaidLike', creator, share);
        const saved = { release: chain.release, api: chain.sdk.api, host: node.$host, contract: chain.contract };
        duringRead = async method => {
          if (method !== 'get_account') return;
          if (change === 'live-network') network = releaseNetwork === 'ae_uat' ? 'ae_mainnet' : 'ae_uat';
          if (change === 'release-network') chain.release.network = releaseNetwork === 'ae_uat' ? 'ae_mainnet' : 'ae_uat';
          if (change === 'release-reference') chain.release = { ...chain.release };
          if (change === 'selected-node') chain.sdk.api = { ...node };
          if (change === 'node-host') node.$host = 'https://other.invalid';
          if (change === 'contract-instance') chain.contract = { ...contract };
          if (failing) throw new Error('Controlled observation failure');
        };
        try { await rejects(service.compare({}), 503); assert.equal(service.active, false); }
        finally {
          chain.release = saved.release; chain.release.network = releaseNetwork; chain.sdk.api = saved.api;
          node.$host = saved.host; chain.contract = saved.contract; network = releaseNetwork; duringRead = undefined;
        }
        assert.equal((await service.compare({})).summary.liabilitiesMatch, true);
      }
    }
  });
  await t.test('database snapshot is explicitly read-only and stable across concurrent writes', async () => {
    await reset(); await seed('PaidLike', creator, share);
    const health = index.health.bind(index); let once = true;
    index.health = async manager => {
      assert.equal((await manager.query('SHOW transaction_read_only'))[0].transaction_read_only, 'on');
      const result = await health(manager);
      if (once) { once = false; await db.query("UPDATE shorts_chain_events SET amount=amount+5 WHERE action='PaidLike'"); }
      return result;
    };
    const result = await service.compare({}); assert.equal(result.summary.liabilitiesMatch, true);
    assert.ok(result.accounts.items.every(a => a.matches)); index.health = health;
    assert.equal((await service.compare({})).summary.liabilitiesMatch, false, 'later snapshot sees corruption');
  });
});
