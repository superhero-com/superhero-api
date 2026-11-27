const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { ShortsWorkQueueService } = require('./shorts-work-queue.service');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function queue(t, capacity = 3, waitMs = 1000) {
  const old = [process.env.SHORTS_MAX_PENDING_OPERATIONS, process.env.SHORTS_OPERATION_WAIT_MS];
  process.env.SHORTS_MAX_PENDING_OPERATIONS = String(capacity);
  process.env.SHORTS_OPERATION_WAIT_MS = String(waitMs);
  try {
    const service = new ShortsWorkQueueService();
    t.after(() => service.onModuleDestroy());
    return service;
  } finally {
    for (const [i, key] of ['SHORTS_MAX_PENDING_OPERATIONS', 'SHORTS_OPERATION_WAIT_MS'].entries()) {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    }
  }
}

test('FIFO mutations never overlap; capacity includes the active operation and recovers after a failure', async t => {
  const work = queue(t), gate = deferred(), order = [];
  let active = 0;
  const action = (id, fail = false) => async () => {
    assert.equal(active++, 0);
    order.push(id);
    if (id === 1) await gate.promise;
    active--;
    if (fail) throw new Error('Rejected operation');
    return id;
  };
  const first = work.run(action(1)), second = work.run(action(2, true)), third = work.run(action(3));
  const secondRejected = assert.rejects(second, /Rejected operation/);
  await assert.rejects(work.run(action(4)), { status: 503 });
  assert.deepEqual(order, [1]);
  gate.resolve();
  assert.equal(await first, 1);
  await secondRejected;
  assert.equal(await third, 3);
  assert.equal(await work.run(action(5)), 5);
  assert.deepEqual(order, [1, 2, 3, 5]);
});

test('queued requests expire without execution while a slow active mutation remains owned', async t => {
  const work = queue(t, 2, 100), gate = deferred();
  let activeFinished = false, expiredRan = false, nextRan = false;
  const first = work.run(async () => { await gate.promise; activeFinished = true; });
  const queued = work.run(async () => { expiredRan = true; });
  const rejected = assert.rejects(queued, { status: 503 });
  // Keep the test alive independently of the unref'd queue deadline.
  await delay(150);
  await rejected;
  assert.equal(activeFinished, false);
  const next = work.run(async () => { assert.equal(activeFinished, true); nextRan = true; });
  gate.resolve();
  await Promise.all([first, next]);
  assert.equal(expiredRan, false);
  assert.equal(nextRan, true);
});

test('shutdown rejects unstarted requests, drains the active write and refuses new work', async t => {
  const work = queue(t), gate = deferred();
  let saved = false, queuedRan = false, closed = false;
  const active = work.run(async () => { await gate.promise; saved = true; });
  const queued = work.run(async () => { queuedRan = true; });
  const rejected = assert.rejects(queued, { status: 503 });
  const closing = work.onModuleDestroy().then(() => { closed = true; });
  await rejected;
  await assert.rejects(work.run(async () => {}), { status: 503 });
  assert.equal(closed, false);
  gate.resolve();
  await Promise.all([active, closing]);
  assert.equal(saved, true);
  assert.equal(queuedRan, false);
});

test('invalid admission configuration fails startup instead of silently disabling limits', () => {
  for (const [key, invalid] of [
    ['SHORTS_MAX_PENDING_OPERATIONS', ['0', '65', 'NaN', '1.5', '']],
    ['SHORTS_OPERATION_WAIT_MS', ['0', '60001', 'Infinity', '0.1']],
  ]) {
    const old = process.env[key];
    try {
      for (const value of invalid) {
        process.env[key] = value;
        assert.throws(() => new ShortsWorkQueueService(), new RegExp(key));
      }
    } finally {
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
  }
});


test('cancelling queued work frees admission immediately; active work must drain', async t => {
  const work = queue(t, 2), gate = deferred(), queued = new AbortController(), active = new AbortController();
  let ran = false, finished = false;
  const first = work.run(async () => { await gate.promise; finished = true; }, active.signal);
  await delay(0);
  const second = work.run(async () => { ran = true; }, queued.signal);
  const rejected = assert.rejects(second); queued.abort(); await rejected;
  const third = work.run(async () => { assert.equal(finished, true); return 3; });
  active.abort(); assert.equal(finished, false);
  await assert.rejects(work.run(async () => {}), { status: 503 });
  gate.resolve(); await first; assert.equal(await third, 3); assert.equal(ran, false);
  await assert.rejects(work.run(async () => assert.fail('pre-aborted work ran'), queued.signal));
});
