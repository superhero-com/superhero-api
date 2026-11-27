const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsSafetyService, visualAllows } = require('./shorts-safety.service');
const { ShortsService } = require('./shorts.service');

test('visual scan validates the actual source and fails closed on outage or inconsistent scores', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-visual-'));
  const saved = process.env.SHORTS_MODERATION_TOKEN_FILE;
  t.after(async () => { await rm(dir, { recursive: true }); if (saved) process.env.SHORTS_MODERATION_TOKEN_FILE = saved; else delete process.env.SHORTS_MODERATION_TOKEN_FILE; });
  process.env.SHORTS_MODERATION_TOKEN_FILE = join(dir, 'token');
  await writeFile(process.env.SHORTS_MODERATION_TOKEN_FILE, 'local-test-token'.repeat(4), { mode: 0o600 });
  const bytes = Buffer.from('owned test bytes');
  const labels = [{ topic: 'Art', score: 0.9 }];
  const receipt = { duration: 2, reason: 'No sampled flags', sampling: '2 fps', labels, models: { safety: { repository: 'Falconsai/nsfw_image_detection', revision: 'a'.repeat(40) }, topics: { repository: 'openai/clip-vit-base-patch32', revision: 'b'.repeat(40) } }, sourceSha256: createHash('sha256').update(bytes).digest('hex'), evidenceHash: 'a'.repeat(64), policy: 'visual-review-v1', status: 'no_flags', frameCount: 4, maxNsfwScore: 0.01, humanReviewRequired: true, frames: [0, .5, 1, 1.5].map(at => ({ at, nsfwScore: 0.01, sha256: 'c'.repeat(64), labels })) };
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(receipt)));
  const safety = new ShortsSafetyService();
  assert.equal((await safety.scan(bytes)).status, 'no_flags');
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ ...receipt, frames: receipt.frames.map(frame => ({ ...frame, at: 0 })) })));
  assert.equal((await safety.scan(bytes)).status, 'error', 'repeated poster frames cannot claim full temporal coverage');
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ ...receipt, labels: undefined })));
  assert.equal((await safety.scan(bytes)).status, 'error', 'incomplete classification evidence stays private');
  fetch.mock.mockImplementation(async () => { throw new Error('model offline'); });
  assert.equal((await safety.scan(bytes)).status, 'error');
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ ...receipt, sourceSha256: 'b'.repeat(64) })));
  assert.equal((await safety.scan(bytes)).status, 'error');
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ ...receipt, maxNsfwScore: .9, frames: receipt.frames.map((frame, i) => ({ ...frame, nsfwScore: i ? .01 : .9 })) })));
  assert.equal((await safety.scan(bytes)).status, 'error', 'an unsafe frame cannot claim a clear decision');
});

test('missing, failed and blocked scans deny both review approval and official playback', async () => {
  const short = { id: 'a', creator: 'creator', moderation: 'approved' };
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: [short] }, operator: { address: 'operator' }, address: a => a, save: async () => {}, read: async method => method === 'get_quote' ? { video_id: 'a', creator: 'creator' } : { until: Date.now() + 100000 } };
  const service = new ShortsService(chain, {}, { counters: () => ({ views: 0, engagement: { score: 0.5 } }) }, {}, {});
  for (const status of [undefined, 'error', 'blocked']) {
    short.safety = status ? { status } : undefined;
    assert.equal(visualAllows(short), false);
    await assert.rejects(service.moderate('a', true, 'Video reviewed'), /visual scan/);
    await assert.rejects(service.ensurePlayable('a'), { status: 404 });
  }
  short.safety = { status: 'review', evidenceHash: 'receipt-a' };
  await assert.rejects(service.moderate('a', true, 'Full video reviewed'), /explicitly confirm/);
  await service.moderate('a', true, 'Full video reviewed; false positive', undefined, true);
  assert.equal(visualAllows(short), true);
  short.safety.evidenceHash = 'receipt-b';
  assert.equal(visualAllows(short), false, 'approval is tied to the evidence reviewed');
});

test('operator retries only stale-nonce dry runs, never ambiguous submissions or wallet methods', async () => {
  const { DryRunError } = require('@aeternity/aepp-sdk');
  const { ShortsChainService } = require('./shorts-chain.service');
  const chain = new ShortsChainService({ save: () => {} });
  chain.operator = { address: 'operator' }; chain.assertTestnet = async () => {};
  let calls = 0;
  chain.contract = { $call: async () => { calls++; if (calls === 1) throw new DryRunError('Internal error: tx_nonce_already_used_for_account'); return {hash:'th_test',decodedResult:1}; } };
  assert.equal((await chain.write('publish', [])).hash, 'th_test');
  assert.equal(calls, 2); assert.equal(chain.state.receipts.length, 1);
  chain.contract.$call = async () => { calls++; throw new Error('Transaction polling timeout'); };
  await assert.rejects(chain.write('publish', ['1']), /polling timeout/);
  assert.equal(calls, 3); assert.equal(chain.state.receipts.length, 1);
  await assert.rejects(chain.write('paid_like', ['a']), /User payments/);
  assert.equal(calls, 3);
  let reads = 0;
  chain.contract.$call = async () => { reads++; if (reads === 1) throw new DryRunError('tx_nonce_too_high_for_account'); return {decodedResult:42}; };
  assert.equal(await chain.read('get_config'), 42); assert.equal(reads, 2);
});

test('feed lists only reviewed, published videos while Studio exposes drafts and safe review summaries', async () => {
  const base = { creator: 'creator', cid: 'cid', bytes: 12, moderation: 'approved', safety: { status: 'no_flags', frames: ['internal-frame'] }, views: [], reportDetails: ['private-report'], classification: { evidenceHash: 'internal-classification' }, reviewHistory: ['internal-review'], visualReviewHash: 'internal-hash', files: ['private-file'], reviewReason: 'internal scan diagnostics' };
  const records = [
    { ...base, id: 'live' },
    { ...base, id: 'pending', moderation: 'pending' },
    { ...base, id: 'rejected', moderation: 'rejected', reviewHistory: [] },
    { ...base, id: 'failed', safety: { status: 'error' } },
    { ...base, id: 'missing', safety: undefined },
    { ...base, id: 'stale', safety: { status: 'review', evidenceHash: 'new-evidence' } },
    { ...base, id: 'expired' }, { ...base, id: 'withdrawn' }, { ...base, id: 'unfunded' },
  ];
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: records }, address: a => a, read: async (method, [id]) => {
    if (method === 'has_liked') return false;
    if (id === 'unfunded') return undefined;
    return { cid: 'cid', creator: 'creator', size: 12n, until: Date.now() + (id === 'expired' ? -1 : 100000), withdrawn: id === 'withdrawn', likes: 0 };
  } };
  const service = new ShortsService(chain, {}, { counters: () => ({ views: 0, engagement: { score: 0.5 } }) }, {}, {});
  assert.deepEqual((await service.list()).map(s => s.id), ['live', 'expired']);
  const studio = await service.list('creator', 'All', true);
  for (const id of ['pending', 'rejected', 'failed', 'missing', 'stale']) assert.equal(studio.find(s => s.id === id).publicationStatus, 'published');
  assert.equal(studio.find(s => s.id === 'rejected').guidelines.status, 'ineligible');
  assert.equal(studio.find(s => s.id === 'failed').guidelines.status, 'unavailable');
  assert.equal(studio.find(s => s.id === 'stale').guidelines.status, 'reviewing');
  assert.equal(studio.find(s => s.id === 'unfunded').publicationStatus, 'draft');
  assert.equal(studio.find(s => s.id === 'withdrawn').publicationStatus, 'withdrawn');
  assert.doesNotMatch(JSON.stringify(studio), /internal-|private-|scan diagnostics/);
  assert.equal((await service.list('other', 'All', true)).length, 0);
  assert.equal((await service.shared('live')).contentWarning, undefined);
  for (const id of ['withdrawn', 'unfunded', 'rejected', 'pending', 'failed', 'missing', 'stale']) {
    await assert.rejects(service.shared(id), /not available/);
    await assert.rejects(service.ensurePlayable(id), /not available/);
  }
  assert.doesNotMatch(JSON.stringify(await service.shared('live')), /internal-|private-|scan diagnostics/);
});

test('storage reconciliation repairs published videos and resumes publication without expiry', async () => {
  const { ShortsHostingService } = require('./shorts-hosting.service');
  const shorts = ['pending', 'rejected', 'expired', 'withdrawn', 'unfunded', 'pin-missing'].map(id => ({ id, cid: id, creator: 'creator', moderation: id === 'rejected' ? 'rejected' : 'approved', safety: { status: id === 'rejected' ? 'blocked' : 'no_flags' }, publication: ['rejected', 'pending'].includes(id) ? 'pending' : undefined }));
  const unpinned = [], pinned = [], recovered = [];
  const chain = { state: { shorts }, serial: fn => fn(), read: async (method, [id]) => {
    if (method === 'get_pending') return id === 'rejected' ? 'quote' : undefined;
    if (method === 'get_quote') return { funded: true, complete: false, deadline: Date.now() + 100000 };
    if (id === 'unfunded') return undefined;
    return { until: Date.now() + (id === 'expired' ? -1000 : 100000), withdrawn: id === 'withdrawn' };
  } };
  const media = { pins: async () => new Set(shorts.map(s => s.cid)), unpin: async cid => unpinned.push(cid), hasPin: cid => cid !== 'pin-missing', pin: async s => pinned.push(s.id) };
  const service = new ShortsHostingService(chain, media, { publish: async (creator, id) => recovered.push([creator, id]) });
  await service.reconcile();
  assert.deepEqual(unpinned.sort(), ['unfunded', 'withdrawn']);
  assert.deepEqual(pinned, ['pin-missing']);
  assert.deepEqual(recovered, [['creator', 'pending']], 'blocked content is never republished');
});

test('creator upload and rescan responses omit operator-only inspection evidence', async t => {
  const { ShortsController } = require('./shorts.controller');
  const short = { id: 'a', creator: 'creator', moderation: 'pending', safety: { status: 'review', frames: ['internal-frame'] }, classification: { evidenceHash: 'private-classification' } };
  let actor = 'creator';
  const chain = { serial: fn => fn(), address: value => value, operator: { address: 'operator' }, release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: [short] } };
  const shorts = new ShortsService(chain, {}, {}, {}, {}, {}, {}, );
  shorts.rescan = async () => short.safety;
  const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
  const records = { shared: true, chain, get: async () => short };
  const uploads = new ShortsHostedUploadsService(records, { getJob: async () => ({ status: 'ready' }) }, {
    get: async () => ({ id: short.id, creator: actor, state: 'enqueued', parts: [], input: { processingProfile: 'original-h264-v1', bytes: 1, sha256: 'a'.repeat(64) } })
  }, { finish: async () => ({ status: 'ready' }) });
  const controller = new ShortsController(shorts, { authenticate: () => actor, operator: () => { if (actor !== 'operator') throw new Error('Operator required'); return actor; } }, uploads);
  assert.doesNotMatch(JSON.stringify(await controller.finishUpload('auth', 'a')), /internal-frame|private-classification/);
  assert.deepEqual(await controller.scan('auth', 'a'), { status: 'reviewing' });
  await assert.rejects(controller.review('auth'), /Operator required/);
  actor = 'operator';
  assert.deepEqual((await controller.scan('auth', 'a')).frames, ['internal-frame']);
  assert.deepEqual((await controller.review('auth')).items[0].safety.frames, ['internal-frame']);
});

test('demo inspection bypass requires explicit local testnet opt-in and makes no scanner calls', async t => {
  const keys = ['SHORTS_DEMO_AUTO_APPROVE', 'SHORTS_TESTNET_MVP', 'NODE_ENV', 'SHORTS_MODERATION_URL', 'SHORTS_MODERATION_TOKEN_FILE'];
  const saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));
  process.env.SHORTS_MODERATION_URL = 'https://moderation.example.com';
  process.env.SHORTS_MODERATION_TOKEN_FILE = '/run/secrets/moderation';
  for (const [demo, local, environment, enabled] of [
    [undefined, '1', 'development', false],
    ['0', '1', 'development', false],
    ['1', '0', 'development', false],
    ['1', '1', 'production', false],
    ['1', '1', 'development', true],
  ]) {
    if (demo === undefined) delete process.env.SHORTS_DEMO_AUTO_APPROVE;
    else process.env.SHORTS_DEMO_AUTO_APPROVE = demo;
    process.env.SHORTS_TESTNET_MVP = local;
    process.env.NODE_ENV = environment;
    assert.equal(new ShortsSafetyService().demoAutoApprove, enabled);
  }
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Scanner must not be called'); });
  const safety = new ShortsSafetyService();
  assert.equal(await safety.scan(Buffer.from('owned demo video')), undefined, 'no fabricated scan receipt');
  assert.equal(await safety.health(), false, 'disabled scanning is not reported as healthy');
  assert.equal(fetch.mock.callCount(), 0);
});

test('demo approval opens pending videos without changing evidence, publication gates or reversibility', async () => {
  const base = { creator: 'creator', cid: 'cid', bytes: 12, moderation: 'pending', views: [], safety: { status: 'error', checkedAt: 1 }, reviewHistory: [] };
  const records = ['pending', 'missing', 'expired', 'withdrawn', 'unfunded', 'blocked', 'rejected'].map(id => ({
    ...base, id, safety: id === 'missing' ? undefined : id === 'blocked' ? { status: 'blocked' } : base.safety,
    moderation: id === 'rejected' ? 'rejected' : 'pending',
  }));
  const original = JSON.stringify(records);
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: records }, address: a => a, read: async (method, [id]) => {
    if (method === 'has_liked') return false;
    if (id === 'unfunded') return undefined;
    return { cid: 'cid', creator: 'creator', size: 12n, until: Date.now() + (id === 'expired' ? -1000 : 100000), withdrawn: id === 'withdrawn', likes: 0 };
  } };
  const media = { safety: { demoAutoApprove: true }, rescan: async () => { throw new Error('Demo must not rescan'); } };
  const service = new ShortsService(chain, media, { counters: () => ({ views: 0, engagement: { score: 0.5 } }) }, {}, {});
  assert.deepEqual((await service.list()).map(s => s.id), ['pending', 'missing', 'expired']);
  for (const id of ['pending', 'missing']) {
    const shared = await service.shared(id);
    assert.equal(shared.status, 'active');
    assert.equal(shared.moderation, 'approved');
    assert.deepEqual(shared.guidelines, { status: 'eligible', approval: 'demo' });
    assert.equal(shared.contentWarning, undefined);
    await service.rescan(id);
  }
  for (const id of ['withdrawn', 'unfunded']) await assert.rejects(service.shared(id), /not available/);
  for (const id of ['blocked', 'rejected']) await assert.rejects(service.shared(id), { status: 404 });
  assert.equal((await service.list('other', 'All', true)).length, 0, 'creator ownership still applies');
  assert.equal(JSON.stringify(records), original, 'effective approval preserves the stored decisions and evidence');
  media.safety.demoAutoApprove = false;
  assert.equal((await service.list()).length, 0);
  for (const id of ['pending', 'missing']) await assert.rejects(service.shared(id), { status: 404 });
});

test('demo worker continues publication recovery and pin repair while pausing scan retries', async () => {
  const { ShortsHostingService } = require('./shorts-hosting.service');
  const records = [{ id: 'missing', cid: 'bafy-missing', creator: 'creator', publication: 'pending' }, { id: 'error', cid: 'bafy-error', safety: { status: 'error', checkedAt: 1 } }];
  let recovered = 0, repaired = 0, rescanned = 0;
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: records }, serial: fn => fn(), read: async (method, [id]) => {
    if (method === 'get_pending') return id === 'missing' ? 'quote' : undefined;
    if (method === 'get_quote') return { funded: true, complete: false, deadline: Date.now() + 100000 };
    return { until: Date.now() + 100000 };
  } };
  const media = { pins: async () => new Set(), hasPin: () => false, pin: async () => { repaired++; } };
  const shorts = { demoAutoApprove: true, publish: async () => { recovered++; }, rescan: async () => { rescanned++; } };
  const worker = new ShortsHostingService(chain, media, shorts);
  await worker.reconcile();
  assert.equal(recovered, 1); assert.equal(repaired, 2); assert.equal(rescanned, 0);
  shorts.demoAutoApprove = false;
  await worker.reconcile();
  assert.equal(rescanned, 2, 'inspection resumes when demo approval is disabled');
});


test('missing chain publication is retried without unpinning or publishing private drafts', async () => {
  const { ShortsHostingService } = require('./shorts-hosting.service');
  const records = [{id:'published',creator:'creator',cid:'live-cid',publication:'published'}, {id:'draft',creator:'creator',cid:'draft-cid'}];
  const recovered=[],removed=[];
  const worker = new ShortsHostingService({state:{shorts:records},serial:fn=>fn(),read:async()=>undefined}, {
    pins:async()=>new Set(['live-cid','draft-cid']),hasPin:()=>true,unpin:async cid=>removed.push(cid),
  }, {demoAutoApprove:true,publish:async (creator,id)=>{recovered.push([creator,id]);throw new Error('Node unavailable');}});
  await worker.reconcile();
  assert.deepEqual(recovered,[['creator','published']]);
  assert.deepEqual(removed,['draft-cid']);
});

test('scanner admission distinguishes busy from unhealthy and cancels with its caller', async t => {
  const safety = new ShortsSafetyService();
  t.after(() => safety.onModuleDestroy());
  let receipt = { ready: true, accepting: false };
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(receipt)));
  assert.equal(await safety.health(), true);
  assert.equal(await safety.accepting(), false);
  for (const [state, expected] of [[{ ready: true, accepting: true }, true], [{ ready: true }, true],
    [{ ready: false, accepting: true }, false], [{ ready: true, accepting: 'true' }, false], [null, false]]) {
    receipt = state; assert.equal(await safety.accepting(), expected);
  }
  const parent = new AbortController(); let observed;
  fetch.mock.mockImplementation((_url, { signal }) => new Promise((_, reject) => {
    observed = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const check = safety.accepting(parent.signal); parent.abort();
  assert.equal(await check, false); assert.equal(observed.aborted, true);
});

test('queued scans retry only transport or temporary service failures; invalid evidence stays private', async t => {
  const { ShortsModerationUnavailableError } = require('./shorts-safety.service');
  const dir = await mkdtemp(join(tmpdir(), 'shorts-retry-'));
  const saved = process.env.SHORTS_MODERATION_TOKEN_FILE;
  process.env.SHORTS_MODERATION_TOKEN_FILE = join(dir, 'token');
  await writeFile(process.env.SHORTS_MODERATION_TOKEN_FILE, 'owned-local-token'.repeat(3), { mode: 0o600 });
  const safety = new ShortsSafetyService();
  t.after(async () => { safety.onModuleDestroy(); await rm(dir, { recursive: true });
    if (saved === undefined) delete process.env.SHORTS_MODERATION_TOKEN_FILE; else process.env.SHORTS_MODERATION_TOKEN_FILE = saved; });
  const bytes = Buffer.from('owned');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  for (const status of [408, 429, 500, 502, 503, 504]) {
    fetch.mock.mockImplementation(async () => new Response('untrusted diagnostics', { status }));
    await assert.rejects(safety.scan(bytes, undefined, true), ShortsModerationUnavailableError);
    assert.equal((await safety.scan(bytes)).status, 'error', 'legacy callers still fail closed');
  }
  fetch.mock.mockImplementation(async () => { throw new TypeError('network unavailable'); });
  await assert.rejects(safety.scan(bytes, undefined, true), ShortsModerationUnavailableError);
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('socket closed')); } })));
  await assert.rejects(safety.scan(bytes, undefined, true), ShortsModerationUnavailableError);
  for (const status of [400, 401, 403, 413, 415, 422]) {
    fetch.mock.mockImplementation(async () => new Response('invalid input or configuration', { status }));
    assert.equal((await safety.scan(bytes, undefined, true)).status, 'error');
  }
  for (const body of ['invalid json', 'null', '{}', JSON.stringify({ status: 'no_flags', sourceSha256: 'wrong' }), 'a'.repeat(262145)]) {
    fetch.mock.mockImplementation(async () => new Response(body));
    const result = await safety.scan(bytes, undefined, true);
    assert.equal(result.status, 'error'); assert.equal(visualAllows({ safety: result }), false);
  }
  const parent = new AbortController(); parent.abort();
  assert.equal((await safety.scan(bytes, parent.signal, true)).status, 'error', 'cancelled lease is not refunded as capacity');
  await rm(process.env.SHORTS_MODERATION_TOKEN_FILE);
  assert.equal((await safety.scan(bytes, undefined, true)).status, 'error', 'missing credential requires operator repair');
});

test('inspection response deadline returns queued backpressure without approving incomplete bytes', async t => {
  const { ShortsModerationUnavailableError } = require('./shorts-safety.service');
  const dir = await mkdtemp(join(tmpdir(), 'shorts-scan-deadline-'));
  const saved = process.env.SHORTS_MODERATION_TOKEN_FILE;
  process.env.SHORTS_MODERATION_TOKEN_FILE = join(dir, 'token');
  await writeFile(process.env.SHORTS_MODERATION_TOKEN_FILE, 'owned-local-token'.repeat(3), { mode: 0o600 });
  const safety = new ShortsSafetyService();
  t.after(async () => { safety.onModuleDestroy(); await rm(dir, { recursive: true });
    if (saved === undefined) delete process.env.SHORTS_MODERATION_TOKEN_FILE; else process.env.SHORTS_MODERATION_TOKEN_FILE = saved; });
  const deadline = new AbortController(); let cancel = false;
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 150000); return deadline.signal; });
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(c) { c.enqueue(Buffer.from('{')); setImmediate(() => deadline.abort()); }, cancel() { cancel = true; },
  })));
  await assert.rejects(safety.scan(Buffer.from('owned'), undefined, true), ShortsModerationUnavailableError);
  assert.equal(cancel, true);
});

test('remote rescans reject replayed decisions, modified evidence and a changed canonical pin', async t => {
  const { ShortsMediaTransferClientService } = require('./shorts-media-transfer-client.service');
  const { ShortsMediaService } = require('./shorts-media.service');
  const { inspectionProof } = require('./shorts-transfer-protocol');
  const { originalRecord } = require('./testing/original-record.cjs');
  const env = { ...process.env }, nativeFetch = global.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'shorts-rescan-'));
  t.after(async () => {
    process.env = env;
    global.fetch = nativeFetch;
    await rm(dir, { recursive: true, force: true });
  });
  delete process.env.SHORTS_MEDIA_TRANSFER_URL;
  delete process.env.SHORTS_MEDIA_TRANSFER_RESCAN;
  assert.equal(new ShortsMediaTransferClientService().rescanEnabled, false);
  process.env.SHORTS_MEDIA_TRANSFER_RESCAN = 'true';
  assert.throws(() => new ShortsMediaTransferClientService(), /transfer origin/);
  const key = 'ab'.repeat(32), keyFile = join(dir, 'key');
  await writeFile(keyFile, key, { mode: 0o600 });
  Object.assign(process.env, { NODE_ENV: 'test', SHORTS_MEDIA_TRANSFER_URL: 'http://127.0.0.1:3336', SHORTS_MEDIA_TRANSFER_KEY_FILE: keyFile });
  const scope = { network: 'ae_uat', contract: 'ct_fixture' }, sourceHash = 'a'.repeat(64);
  const short = originalRecord(), sourceSha256 = short.original.sha256;
  const labels = [{ topic: 'Nature', score: 0.8 }];
  const evidence = { duration: 2, reason: 'Flagged sample', sampling: '2 fps', labels,
    models: { safety: { repository: 'safety', revision: 'a'.repeat(40) }, topics: { repository: 'topics', revision: 'b'.repeat(40) } },
    sourceSha256, evidenceHash: 'c'.repeat(64), policy: 'visual-review-v1', status: 'review', frameCount: 5, maxNsfwScore: 0.4,
    humanReviewRequired: true, frames: [0, 0.5, 1, 1.5, 2].map(at => ({ at, nsfwScore: 0.4, sha256: 'd'.repeat(64), labels })) };
  const client = new ShortsMediaTransferClientService(), signal = new AbortController().signal;
  let reply, message;
  global.fetch = async (url, args) => {
    assert.equal(url, 'http://127.0.0.1:3336/internal/media/inspect');
    assert.equal(args.headers.Authorization, 'Bearer ' + key);
    message = JSON.parse(args.body);
    return reply(args.body);
  };
  const signed = (raw, ev) => ({ version: 1, evidence: ev, proof: inspectionProof(key, raw, ev) });
  const inspect = () => client.inspect(scope, sourceHash, short, 'pinned', signal);
  let old;
  reply = raw => Response.json(old = signed(raw, evidence));
  assert.equal((await inspect()).status, 'review');
  assert.equal(message.source, 'pinned');
  assert.equal(message.staging, undefined);
  reply = () => Response.json(old);
  await assert.rejects(inspect(), /acknowledgement/);
  reply = raw => Response.json({ ...signed(raw, evidence), evidence: { ...evidence, reason: 'changed' } });
  await assert.rejects(inspect(), /acknowledgement/);
  reply = raw => Response.json(signed(raw, { ...evidence, sourceSha256: '0'.repeat(64) }));
  await assert.rejects(inspect(), /acknowledgement/);
  reply = raw => Response.json(signed(raw, { ...evidence, status: 'no_flags' }));
  await assert.rejects(inspect(), /safety decision/);
  reply = raw => Response.json(signed(raw, { ...evidence, frames: evidence.frames.slice(0, 3), frameCount: 3 }));
  await assert.rejects(inspect(), /temporal coverage/);
  reply = raw => Response.json(signed(raw, { ...evidence, status: 'error' }));
  const failed = await inspect();
  assert.equal(failed.status, 'error');
  assert.equal(failed.evidenceHash, undefined);
  reply = () => Response.json({}, { status: 503 });
  await assert.rejects(inspect(), { status: 503 });

  reply = raw => Response.json(signed(raw, evidence));
  const record = { ...short, publication: 'published', creator: 'ak_fixture' };
  const chain = { release: scope, state: { contract: scope.contract, sourceHash } };
  let releases = 0;
  const media = new ShortsMediaService({}, undefined, { chain, shared: true }, {
    acquire: async () => ({ signal, release: async () => { releases++; } }),
  }, undefined, undefined, undefined, client);
  const pins = [true, false];
  media.pinned = async () => pins.shift();
  await assert.rejects(media.rescan(record), /pin changed/);
  assert.deepEqual(pins, []);
  assert.equal(releases, 1);
  await media.onModuleDestroy();
});

test('the production API obtains scanner readiness through the transfer service without holding the scanner token', async t => {
  const { ShortsTestnetModule } = require('./shorts.module');
  const { ShortsMediaTransferClientService } = require('./shorts-media-transfer-client.service');
  const { ShortsMediaService } = require('./shorts-media.service');
  const provider = Reflect.getMetadata('providers', ShortsTestnetModule).find(value => value.provide === ShortsSafetyService);
  const saved = { ...process.env }, previousFetch = global.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'shorts-ready-'));
  t.after(async () => { process.env = saved; global.fetch = previousFetch; await rm(directory, {recursive:true, force:true}); });
  delete process.env.SHORTS_MODERATION_TOKEN_FILE;
  delete process.env.SHORTS_MODERATION_URL;
  const keyFile = join(directory, 'key');
  await writeFile(keyFile, 'a'.repeat(64), {mode:0o600});
  Object.assign(process.env, {NODE_ENV:'production',SHORTS_MEDIA_TRANSFER_URL:'https://transfer.example',SHORTS_MEDIA_TRANSFER_KEY_FILE:keyFile,SHORTS_MEDIA_TRANSFER_RESCAN:'true'});
  const client = new ShortsMediaTransferClientService();
  const scope = { network: 'ae_uat', contract: 'ct_fixture' }, sourceHash = 'b'.repeat(64);
  const scanner = provider.useFactory(client);
  assert.equal(scanner, null);
  const media = new ShortsMediaService(scanner, undefined, { shared:true, chain:{release:scope,state:{contract:scope.contract,sourceHash}} }, undefined, undefined, undefined, undefined, client);
  let ready = true;
  global.fetch = async (url, args) => {
    assert.equal(url, 'https://transfer.example/internal/media/inspection-health');
    const request = JSON.parse(args.body);
    assert.deepEqual(request.scope, scope); assert.equal(request.sourceHash, sourceHash);
    return Response.json({version:1,ready});
  };
  assert.equal(await media.moderationHealth(),true); ready=false; assert.equal(await media.moderationHealth(),false);
  global.fetch = async () => { throw new TypeError('fixture offline'); };
  assert.equal(await media.moderationHealth(),false);
  process.env.SHORTS_MEDIA_TRANSFER_RESCAN='false';
  assert.throws(()=>provider.useFactory(new ShortsMediaTransferClientService()), /Moderation requires HTTPS|moderation service credential/);
  await media.onModuleDestroy();
});
