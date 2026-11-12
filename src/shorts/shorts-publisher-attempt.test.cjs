require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { createHttpHeaders } = require('@azure/core-rest-pipeline');
const { PublisherAttempt, currentPublisherAttempt } = require('./shorts-publisher-attempt');
const { publisherTransport, ShortsPublisherNodeService } = require('./shorts-publisher-node.service');
const { ShortsPublisherService } = require('./shorts-publisher.service');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function httpFixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = publisherTransport(origin, 8000);
  return (path = '/v3/status', method = 'GET', body) => transport.sendRequest({
    url: origin + path, method, headers: createHttpHeaders(), body,
  });
}

function fixture(overrides = {}, boundaryOverrides = {}, attemptMs = 2000) {
  const counts = { prepare: 0, persist: 0, broadcast: 0, release: 0 };
  const claim = { id: 'fixture', status: 'claimed', intent: { id: 'fixture' } };
  const boundary = {
    async claim() { return claim; }, async renew() {},
    async persistSigned(_config, current) { counts.persist++; return { ...current, status: 'signed' }; },
    async authorizeBroadcast() { return { rawTransaction: 'tx_fixture', transactionHash: 'th_fixture' }; },
    async release() { counts.release++; }, ...boundaryOverrides,
  };
  const node = {
    async verify() {}, async existing() {},
    async prepare() { counts.prepare++; return { rawTransaction: 'tx_fixture', accountNonce: 0, height: 100 }; },
    async observe() { return { state: 'absent' }; }, async canBroadcast() { return true; },
    async broadcast() { counts.broadcast++; }, ...overrides,
  };
  const config = { pollMs: 1000, policy: { leaseMs: 1500 } };
  const service = new ShortsPublisherService(config, boundary, node, attemptMs);
  return { service, counts, node, config };
}

test('attempt deadline closes a drip-fed response and rejects its late continuation', { timeout: 5000 }, async t => {
  const closed = deferred(); let requests = 0;
  const request = await httpFixture(t, (_req, res) => {
    requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
    const drip = setInterval(() => res.write(' '), 10);
    res.on('close', () => { clearInterval(drip); closed.resolve(); });
  });
  const attempt = new PublisherAttempt(new AbortController().signal, 120);
  t.after(() => attempt.close());
  const started = performance.now();
  await attempt.run(async () => {
    await assert.rejects(request());
    await assert.rejects(request());
  });
  await closed.promise;
  assert.equal(requests, 1);
  assert.ok(performance.now() - started < 1500);
});

test('total deadline spans multiple otherwise successful requests', { timeout: 5000 }, async t => {
  let requests = 0, completed = 0;
  const request = await httpFixture(t, (_req, res) => {
    requests++;
    const timer = setTimeout(() => res.end('{}'), 60);
    res.on('close', () => clearTimeout(timer));
  });
  const attempt = new PublisherAttempt(new AbortController().signal, 250);
  t.after(() => attempt.close());
  await assert.rejects(attempt.run(async () => {
    for (let i = 0; i < 20; i++) { await request(); completed++; }
  }));
  assert.ok(completed > 0 && completed < 20);
  assert.ok(requests < 20);
});

test('shutdown aborts outstanding HTTP and prevents any subsequent signing work', { timeout: 5000 }, async t => {
  const entered = deferred(), closed = deferred();
  const request = await httpFixture(t, (_req, res) => {
    entered.resolve(); res.on('close', closed.resolve);
  });
  const run = fixture({ async verify() { await request(); } });
  const tick = run.service.tick(); assert.equal(run.service.tick(), tick);
  await entered.promise;
  const started = performance.now();
  await run.service.onModuleDestroy(); await tick; await closed.promise;
  assert.ok(performance.now() - started < 1500);
  assert.deepEqual(run.counts, { prepare: 0, persist: 0, broadcast: 0, release: 0 });
  await run.service.tick(); assert.equal(run.counts.prepare, 0);
});

test('failed renewal cancels in-flight HTTP without releasing someone else’s lease', { timeout: 5000 }, async t => {
  const closed = deferred();
  const request = await httpFixture(t, (_req, res) => res.on('close', closed.resolve));
  const run = fixture({ async verify() { await request(); } }, { async renew() { throw new Error('fence changed'); } });
  await run.service.tick(); await closed.promise;
  assert.deepEqual(run.counts, { prepare: 0, persist: 0, broadcast: 0, release: 0 });
});

test('lease expiry cancels HTTP even when renewal is still outstanding', { timeout: 5000 }, async t => {
  const renewing = deferred(), finish = deferred(), closed = deferred(); let renewed = false;
  const request = await httpFixture(t, (_req, res) => res.on('close', closed.resolve));
  const run = fixture({ async verify() { await request(); } }, {
    async renew() { renewing.resolve(); await finish.promise; renewed = true; },
  });
  run.config.policy.leaseMs = 750;
  const tick = run.service.tick(); await renewing.promise;
  await closed.promise; assert.equal(renewed, false);
  // The attempt drains, rather than abandoning, the independently bounded SQL operation.
  finish.resolve(); await tick;
  assert.equal(renewed, true);
  assert.deepEqual(run.counts, { prepare: 0, persist: 0, broadcast: 0, release: 0 });
});

test('a late persistence acknowledgement cannot proceed to observation or broadcast', { timeout: 5000 }, async () => {
  let observed = false;
  const run = fixture({ async observe() { observed = true; return { state: 'absent' }; } }, {
    async persistSigned(_config, claim) { await delay(130); return { ...claim, status: 'signed' }; },
  }, 80);
  await run.service.tick();
  assert.equal(observed, false); assert.equal(run.counts.broadcast, 0);
  assert.equal(run.counts.release, 1);
});

test('shutdown during claim waits for its result but starts no node calls or release', async () => {
  const entered = deferred(), finish = deferred(); let verified = false;
  const run = fixture({ async verify() { verified = true; } }, {
    async claim() { entered.resolve(); await finish.promise; return { status: 'claimed' }; },
  });
  const tick = run.service.tick(); await entered.promise;
  const stop = run.service.onModuleDestroy(); finish.resolve(); await Promise.all([tick, stop]);
  assert.equal(verified, false); assert.equal(run.counts.release, 0);
});

test('elapsed lease checks cannot be bypassed by a paused event loop or revived by renewal', () => {
  const attempt = new PublisherAttempt(new AbortController().signal, 1000);
  try {
    attempt.lease(performance.now(), 10);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    assert.throws(() => attempt.lease(performance.now(), 1000));
    assert.throws(() => attempt.check());
  } finally { attempt.close(); }
});

test('cancellation is scoped to one attempt and closed contexts cannot issue late requests', async t => {
  let requests = 0;
  const request = await httpFixture(t, (_req, res) => { requests++; res.end('{}'); });
  const a = new PublisherAttempt(new AbortController().signal), b = new PublisherAttempt(new AbortController().signal);
  try {
    await a.run(async () => { a.close(); await assert.rejects(request()); });
    await b.run(request); assert.equal(requests, 1);
    assert.equal(currentPublisherAttempt(), undefined);
  } finally { a.close(); b.close(); }
});

test('a cancelled SDK simulation cannot start local signing', async () => {
  const attempt = new PublisherAttempt(new AbortController().signal);
  const node = new ShortsPublisherNodeService({ operator: 'fixture', policy: { maxTransactionCost: '1', maxTtlBlocks: 20 } });
  let signed = false;
  node.verify = async () => {};
  node.head = async () => ({ height: 100 });
  node.node = { async getAccountByPubkey() { return { kind: 'basic', nonce: 0, balance: 2n }; } };
  node.contract = { async $call() { attempt.abort(); return { rawTx: 'unused' }; } };
  node.account = { async signTransaction() { signed = true; } };
  try {
    await assert.rejects(attempt.run(() => node.prepare({ id: 'fixture' })));
    assert.equal(signed, false);
  } finally { attempt.close(); }
});
