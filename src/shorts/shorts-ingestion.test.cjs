const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ShortsWorkQueueService } = require('./shorts-work-queue.service');
const { ShortsChainService } = require('./shorts-chain.service');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }

test('prepared draft commits remain durable while network mutations wait, with idempotency and rollback', async () => {
  const work = new ShortsWorkQueueService(), network = deferred(), started = deferred();
  let saved, fail = false;
  const chain = new ShortsChainService({ save: state => {
    if (fail) throw new Error('Storage full');
    saved = structuredClone(state);
  } }, work);
  const mutation = chain.serial(async () => { started.resolve(); await network.promise; });
  await started.promise;
  const first = { id: 'first', creator: 'creator' };
  assert.equal(chain.registerPrepared(first), first);
  assert.deepEqual(saved.shorts, [first]);
  assert.equal(chain.registerPrepared({ ...first, title: 'duplicate' }), first);
  assert.throws(() => chain.registerPrepared({ ...first, creator: 'other' }), /identity mismatch/);
  fail = true;
  assert.throws(() => chain.registerPrepared({ id: 'second', creator: 'creator' }), /Storage full/);
  assert.deepEqual(chain.state.shorts, [first]);
  assert.deepEqual(saved.shorts, [first]);
  network.resolve(); await mutation;
});
test('reconciliation does not revisit existing records when preparation registers another draft during network IO', async () => {
  const { ShortsHostingService } = require('./shorts-hosting.service');
  const first = { id: 'existing', cid: 'original', moderation: 'approved', publication: 'published' };
  const state = { shorts: [first] }, reads = [];
  const worker = new ShortsHostingService({ state, serial: fn => fn(), read: async (method, [id]) => {
    reads.push(id);
    if (reads.length === 1) state.shorts.unshift({ id: 'new', moderation: 'pending' });
    return { withdrawn: false };
  } }, { pins: async () => new Set(['original']), hasPin: () => true,
    unpin: async () => assert.fail('Active media cannot be unpinned'),
  }, { demoAutoApprove: true });
  await worker.reconcile();
  assert.deepEqual(reads, ['existing', 'existing']);
});
