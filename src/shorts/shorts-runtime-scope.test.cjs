require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shortsRuntimeScope } = require('./shorts-runtime-scope');
const { ShortsRecordsService } = require('./shorts-records.service');
const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
const { ShortsHostedAnalyticsService } = require('./shorts-hosted-analytics.service');
const { ShortsHostedHostingService } = require('./shorts-hosted-hosting.service');
const { ShortsStreamingService } = require('./shorts-streaming.service');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsChainService } = require('./shorts-chain.service');

const fixture = (network = 'ae_uat', contract = 'ct_fixture') => ({
  release: { network, contract }, state: { contract, sourceHash: 'a'.repeat(64), shorts: [], receipts: [] },
  address: value => value,
});

test('runtime scope requires an initialized matching release, with no testnet fallback', () => {
  for (const chain of [undefined, {}, { state: {} }, { release: fixture().release }, { release: { network: 'ae_uat' }, state: {} },
    fixture('unknown'), fixture('ae_uat', ''), { ...fixture(), state: { contract: 'ct_other' } }])
    assert.throws(() => shortsRuntimeScope(chain), { status: 503 });
});

test('runtime identity is immutable for a process; distinct deployments get distinct scopes', () => {
  for (const change of ['network', 'contract', 'release', 'state']) {
    const chain = fixture(), scope = shortsRuntimeScope(chain);
    assert.equal(Object.isFrozen(scope), true); assert.equal(shortsRuntimeScope(chain), scope);
    if (change === 'network') chain.release.network = 'ae_mainnet';
    if (change === 'contract') chain.release.contract = chain.state.contract = 'ct_other';
    if (change === 'release') chain.release = { ...chain.release };
    if (change === 'state') chain.state.contract = 'ct_other';
    assert.throws(() => shortsRuntimeScope(chain), { status: 503 });
  }
  assert.notDeepEqual(shortsRuntimeScope(fixture()), shortsRuntimeScope(fixture('ae_mainnet')));
});

for (const network of ['ae_uat', 'ae_mainnet']) test(`data and job adapters carry their release scope (${network})`, async t => {
  // These adapters have controlled dependencies; actual runtime mainnet guards stay enabled.
  const saved = { ...process.env };
  delete process.env.SHORTS_STREAM_INTERNAL_URL; delete process.env.SHORTS_STREAM_KEY_FILE;
  t.after(() => { process.env = saved; });
  const chain = fixture(network), expected = { network, contract: chain.state.contract }, seen = [];
  const check = (label, scope) => { assert.deepEqual(scope, expected); seen.push(label); };
  const metadata = {
    initialize: async scope => check('content', scope), verifyHostedStorage: async scope => check('storage', scope),
    verifyRuntime: async scope => check('upload', scope),
    get: async scope => { check('read', scope); return { record: { id: 'video' }, revision: '1' }; },
  };
  const records = new ShortsRecordsService(chain, metadata); await records.onModuleInit();
  assert.equal((await records.get('video')).id, 'video');
  await new ShortsHostedUploadsService(records, metadata, {}, {}).initialize();
  const analytics = new ShortsHostedAnalyticsService({
    initialize: async scope => { check('analytics', scope); return 0; },
    counters: async scope => { check('counts', scope); return { views: 0 }; },
  }, records);
  await analytics.initialize(); assert.deepEqual(await analytics.counters('video'), { views: 0 });
  const lifecycle = new ShortsHostedHostingService(chain, {}, { publisher: {} }, records,
    { verify: async scope => check('lifecycle', scope) });
  await lifecycle.initialize(); await lifecycle.onModuleDestroy();
  const stream = new ShortsStreamingService({ get db() { assert.fail('No SQLite in hosted jobs'); } }, {}, records,
    { verify: async scope => check('stream-init', scope), enqueue: async scope => check('stream', scope) });
  await stream.initialize(); await stream.enqueue('video'); await stream.onModuleDestroy();
  let released = 0;
  const media = new ShortsMediaService({}, { file: async scope => { check('private-media', scope); return Buffer.from('preview'); } }, records, undefined, { acquire: async () => ({ signal: new AbortController().signal, release: async () => { released++; } }) });
  const preview = await media.preview({ id: 'video', creator: 'ak_fixture', privateMedia: {} });
  assert.equal(preview.toString(), 'preview'); assert.equal(released, 1); await media.onModuleDestroy();
  const auth = new ShortsAuthService({}, chain, { challenge: async (scope, address, message) => {
    const { origin, ...deployment } = scope; check('session', deployment);
    assert.equal(new URL(origin).origin, origin); assert.match(message('nonce', Date.now()), new RegExp('Network: ' + network));
  } });
  await auth.challenge('ak_fixture');
  const receipts = new ShortsChainService({}, {}, { shared: true, initialize: async scope => check('receipts', scope) });
  receipts.release = chain.release; receipts.state = chain.state; await receipts.onApplicationBootstrap();
  assert.deepEqual(new Set(seen), new Set(['content', 'storage', 'upload', 'read', 'analytics', 'counts', 'lifecycle', 'stream-init', 'stream', 'session', 'receipts', 'private-media']));
  chain.release.network = network === 'ae_uat' ? 'ae_mainnet' : 'ae_uat';
  const count = seen.length;
  await assert.rejects(records.get('video'), { status: 503 });
  assert.throws(() => analytics.counters('video'), { status: 503 });
  await assert.rejects(auth.challenge('ak_fixture'), { status: 503 });
  assert.equal(seen.length, count, 'No adapter may consult another deployment after a runtime change');
});
