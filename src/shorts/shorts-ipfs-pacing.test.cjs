require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsMediaService } = require('./shorts-media.service');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t) {
  const media = new ShortsMediaService({});
  media.ipfsHeaders = async () => new Headers();
  t.after(() => media.onModuleDestroy());
  return media;
}

test('IPFS starts are spaced even after a stalled event loop, without waiting for response headers', async t => {
  const media = fixture(t), first = gate(), entered = gate(), starts = [];
  t.mock.method(global, 'fetch', (_url, init) => {
    starts.push(performance.now());
    assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST');
    if (starts.length === 1) { entered.resolve(); return first.promise; }
    return Promise.resolve(new Response('ok'));
  });
  const requests = [0, 1, 2].map(n => media.ipfsFetch(`cat?arg=fixture${n}`, { method: 'POST' }));
  await entered.promise;
  // Deliberately let all pre-reserved timestamps become overdue.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
  await requests[2];
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 74);
  first.resolve(new Response('ok')); await Promise.all(requests);
});

test('queued cancellation rejects promptly and never dispatches or poisons the next request', async t => {
  const media = fixture(t), credentials = gate(), entered = gate(), calls = [], cancel = new AbortController();
  let reads = 0;
  media.ipfsHeaders = async () => { if (++reads === 1) { entered.resolve(); await credentials.promise; } return new Headers(); };
  t.mock.method(global, 'fetch', url => { calls.push(url); return Promise.resolve(new Response('ok')); });
  const first = media.ipfsFetch('first', { method: 'POST' }); await entered.promise;
  const second = media.ipfsFetch('cancelled', { method: 'POST', signal: cancel.signal });
  const failure = new Error('caller cancelled');
  const rejected = assert.rejects(second, error => error === failure);
  cancel.abort(failure); await rejected;
  assert.equal(calls.length, 0, 'cancellation must settle while the prior turn is blocked');
  const third = media.ipfsFetch('third', { method: 'POST' });
  credentials.resolve(); await Promise.all([first, third]);
  assert.deepEqual(calls.map(url => url.split('/').pop()), ['first', 'third']);
});

test('IPFS pacing preserves body, upstream rejection and 429 without replaying requests', async t => {
  const media = fixture(t), response = new Response('busy', { status: 429 }), failure = new Error('upstream failed');
  const body = new FormData(); body.append('file', new Blob(['original']));
  const calls = [];
  t.mock.method(global, 'fetch', (_url, init) => {
    calls.push(init); if (calls.length === 2) return Promise.reject(failure);
    return Promise.resolve(response);
  });
  assert.equal(await media.ipfsFetch('add', { method: 'POST', body }), response);
  assert.equal(calls[0].body, body);
  await assert.rejects(media.ipfsFetch('cat', { method: 'POST' }), error => error === failure);
  assert.equal(await media.ipfsFetch('pin/ls', { method: 'POST' }), response);
  assert.equal(calls.length, 3);
});

test('failed credentials release the scheduler and shutdown cancels queued RPCs', async t => {
  const media = fixture(t), failure = new Error('credentials unavailable'); let reads = 0, calls = 0;
  media.ipfsHeaders = async () => { if (++reads === 1) throw failure; return new Headers(); };
  t.mock.method(global, 'fetch', () => { calls++; return Promise.resolve(new Response('ok')); });
  await assert.rejects(media.ipfsFetch('first', {}), error => error === failure);
  await media.ipfsFetch('second', {});
  const queued = media.ipfsFetch('cancelled', {});
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  await media.onModuleDestroy(); await rejected;
  await pause(90); assert.equal(calls, 1);
});
