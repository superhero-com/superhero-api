require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { encode, Encoding } = require('@aeternity/aepp-sdk');
const { ShortsNodeAccessService } = require('./shorts-node-access.service');
const { ShortsPluginNetworkService } = require('../plugins/shorts/shorts-plugin-network.service');
const { ShortsBackfillService } = require('../plugins/shorts/shorts-backfill.service');
const { ShortsPluginSyncService } = require('../plugins/shorts/shorts-plugin-sync.service');
const { releaseFixture } = require('./shorts-release.fixture.cjs');

async function fixture(t) {
  const saved = process.env.AE_NETWORK_ID; process.env.AE_NETWORK_ID = 'ae_uat';
  const state = { network: 'ae_uat', mdwHeight: 100, hash: encode(randomBytes(32), Encoding.KeyBlockHash), mismatch: false, mode: '', held: 0 };
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url); res.setHeader('content-type', 'application/json');
    if (req.url.includes('hold=true')) { state.held++; return; }
    if (req.url.startsWith('/mdw/') && state.mode === 'redirect') { res.writeHead(302, { location: '/must-not-follow' }); res.end(); return; }
    if (req.url.startsWith('/mdw/') && state.mode === 'oversized') { res.writeHead(200, { 'content-length': '1048577' }); res.end(); return; }
    if (req.url.startsWith('/mdw/') && state.mode === 'chunked') { res.write(' '.repeat(1048577)); res.end('{}'); return; }
    if (req.url.startsWith('/mdw/') && state.mode === 'malformed') { res.end('{bad'); return; }
    if (req.url.startsWith('/mdw/') && state.mode === 'unavailable') { res.statusCode = 503; res.end('{}'); return; }
    if (req.url === '/v3/status') res.end(JSON.stringify({ node_version: '7.2.0', network_id: state.network, top_block_height: 100, protocols: [{ version: 6, effective_at_height: 0 }] }));
    else if (req.url === '/mdw/v3/status') res.end(JSON.stringify({ mdw_height: state.mdwHeight }));
    else if (req.url.startsWith('/v3/key-blocks/height/')) res.end(JSON.stringify({ height: Number(req.url.split('/').at(-1)), hash: state.hash }));
    else if (req.url.startsWith('/mdw/v3/key-blocks/')) res.end(JSON.stringify({ height: Number(req.url.split('/').at(-1)), hash: state.mismatch ? encode(randomBytes(32), Encoding.KeyBlockHash) : state.hash }));
    else if (req.url.startsWith('/mdw/v3/contracts/logs')) res.end(JSON.stringify({ data: [], next: null }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const access = new ShortsNodeAccessService();
  const release = releaseFixture({ node: origin, middleware: origin + '/mdw' }).release;
  const node = access.createNode(origin);
  const chain = { release, sdk: { api: node }, readNode: (...args) => access.read(...args) };
  const config = { get: () => release.middleware };
  const ae = { sdk: { api: node } };
  const service = new ShortsPluginNetworkService(chain, config, ae);
  t.after(() => { service.onModuleDestroy(); access.onModuleDestroy(); server.closeAllConnections(); server.close(); if (saved === undefined) delete process.env.AE_NETWORK_ID; else process.env.AE_NETWORK_ID = saved; });
  return { state, requests, origin, chain, config, ae, service };
}

test('real SDK/HTTP checkpoint verification coalesces success for at most five seconds', async t => {
  const f = await fixture(t); let now = performance.now(); t.mock.method(performance, 'now', () => now);
  await Promise.all([f.service.onApplicationBootstrap(), f.service.verify(), f.service.verify()]);
  const initialStatusCalls = f.requests.filter(p => p === '/v3/status').length;
  assert.equal(f.requests.filter(p => p === '/mdw/v3/status').length, 1);
  assert.ok(f.requests.includes('/mdw/v3/key-blocks/98'));
  assert.ok(f.requests.includes('/v3/key-blocks/height/98'));
  f.state.network = 'ae_mainnet'; now += 4999; await f.service.verify();
  now++; await assert.rejects(f.service.verify(), /another network/);
  f.state.network = 'ae_uat'; await f.service.verify();
  assert.equal(f.requests.filter(p => p === '/v3/status').length, initialStatusCalls + 2);
  assert.equal(f.requests.filter(p => p === '/mdw/v3/status').length, 2);
});

test('configured network, selected node and middleware must match before any request or cached reuse', async t => {
  const f = await fixture(t); await f.service.verify(); const before = f.requests.length;
  for (const mutate of [
    () => { process.env.AE_NETWORK_ID = 'ae_mainnet'; return () => { process.env.AE_NETWORK_ID = 'ae_uat'; }; },
    () => { const original = f.config.get; f.config.get = () => 'https://other.invalid/mdw'; return () => { f.config.get = original; }; },
    () => { const original = f.ae.sdk.api; f.ae.sdk.api = { $host: 'https://other.invalid' }; return () => { f.ae.sdk.api = original; }; },
  ]) { const restore = mutate(); await assert.rejects(f.service.verify(), /shared indexer network/); restore(); }
  assert.equal(f.requests.length, before);
});

test('middleware on a different chain or with an invalid checkpoint never verifies', async t => {
  const f = await fixture(t); f.state.mismatch = true;
  await assert.rejects(f.service.verify(), /disagrees/);
  f.state.mismatch = false; f.state.mdwHeight = '100';
  await assert.rejects(f.service.verify(), /checkpoint/);
  f.state.mdwHeight = 100; await f.service.verify();
});

for (const mode of ['redirect', 'oversized', 'chunked', 'malformed', 'unavailable']) test(`middleware ${mode} fails closed with bounded reads`, async t => {
  const f = await fixture(t); f.state.mode = mode;
  await assert.rejects(f.service.verify());
  assert.ok(!f.requests.includes('/must-not-follow'));
  assert.equal(f.service.active, 0); assert.equal(f.service.verifiedUntil, 0);
});

test('middleware transport rejects other origins and paths before fetching', async t => {
  const f = await fixture(t);
  for (const value of ['https://other.invalid/mdw/v3/status', f.origin + '/v3/status', f.origin + '/mdw/v3/transactions', f.origin + '/mdw/v3/status#token', f.origin + '/mdw/v3/../status']) await assert.rejects(f.service.json(value), /authority/);
  await assert.rejects(f.service.json(f.origin + '/mdw/v3/status?' + 'x'.repeat(8192)), /URL/);
  assert.equal(f.requests.length, 0);
});

test('bounded middleware admission and shutdown release eight held reads without queued work', async t => {
  const f = await fixture(t);
  const reads = Array.from({ length: 8 }, () => f.service.json(f.origin + '/mdw/v3/contracts/logs?hold=true').catch(e => e));
  for (let i = 0; f.state.held < 8 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.state.held, 8);
  await assert.rejects(f.service.json(f.origin + '/mdw/v3/status'), /busy/);
  f.service.onModuleDestroy(); await Promise.all(reads);
  assert.equal(f.service.active, 0);
  await assert.rejects(f.service.verify());
});

test('cancelled middleware response cannot hold its admission slot', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.json(f.origin + '/mdw/v3/contracts/logs?hold=true', AbortSignal.timeout(30)));
  assert.equal(f.service.active, 0);
  await f.service.verify();
});

test('failed verification cannot create a backfill checkpoint or stamp a plugin projection', async () => {
  const network = { verify: async () => { throw new Error('wrong middleware'); } };
  const db = { query: () => assert.fail('No backfill mutation'), transaction: () => assert.fail('No projection mutation') };
  const backfill = new ShortsBackfillService(db, network, {}, {}, {});
  await assert.rejects(backfill.run(100, () => false), /wrong middleware/);
  const processor = new ShortsPluginSyncService({}, db, {}, network);
  const result = await processor.processBatch([{ hash: 'th_fixture' }], 'live');
  assert.equal(result.failed.length, 1);
});

for (const key of ['contract_id', 'scope', 'direction', 'limit']) test(`backfill rejects duplicate ${key} query values without fetching or marking coverage complete`, async () => {
  const base = 'https://mdw.invalid/mdw';
  const cursor = `${base}/v3/contracts/logs?contract_id=ct_fixture&scope=gen:0-98&direction=forward&limit=100&${key}=changed`;
  const queries = [];
  const db = { query: async (sql) => {
    queries.push(sql);
    if (sql.startsWith('SELECT')) return [{ complete: false, covered_height: -1, from_height: 0, target_height: 98, cursor }];
  }, getRepository: () => ({}) };
  const network = { verify: async () => {}, bindings: () => ({ middleware: base }), json: () => assert.fail('Ambiguous cursor must not be fetched') };
  const index = { assertNetwork: async () => {}, contracts: () => [{ $options: { address: 'ct_fixture' } }] };
  const backfill = new ShortsBackfillService(db, network, index, {}, {});
  await assert.rejects(backfill.run(100, () => false), /coverage range/);
  assert.ok(!queries.some(sql => sql.includes('SET cursor=$2')));
});

test('update identity uses the verified release network rather than a testnet literal', () => {
  const { ShortsIndexService } = require('./shorts-index.service');
  for (const network of ['ae_uat', 'ae_mainnet']) {
    const index = new ShortsIndexService({}, { release: { network, contract: 'ct_fixture' }, state: { contract: 'ct_fixture' }, contract: { $options: { address: 'ct_fixture' } } });
    assert.deepEqual(index.identity(), { network, contract: 'ct_fixture' });
  }
  // This pure identity projection does not invoke or relax runtime mainnet guards.
});
