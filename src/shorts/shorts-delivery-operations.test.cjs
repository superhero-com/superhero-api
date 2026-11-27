require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deliveryOperation, runDeliveryOperation } = require('./shorts-delivery-operation');
const budget = { replicas: 1, maxAdditionalLogicalBytes: 3e9, maxEncodingSeconds: 5400 };
const scope = { network: 'ae_uat', contract: 'ct_test' };
const operation = '00000000-0000-4000-8000-000000000001';
const scan = '00000000-0000-4000-8000-000000000002';

test('delivery operations reject malformed and unexpected inputs before runtime startup', () => {
  for (const [action, input] of [['delete', {}], ['status', {}], ['status', { id: 'p', unknown: true }],
    ['dry-run', { ids: ['p', 'p'], budget }], ['start', { id: 'batch', ids: ['p'], budget, planHash: 'bad' }],
    ['rollback', { id: 'p', nextKey: 'x', expected: {}, operation: 'bad' }]])
    assert.throws(() => deliveryOperation(action, input));
});

test('commands delegate only their requested action and rollback uses explicit expectations', async () => {
  const signal = new AbortController().signal;
  let call;
  const activation = { select: (...args) => { call = args; return 'receipt'; } };
  const input = { id: 'post', nextKey: 'a'.repeat(64), expected: { sourceKey: 'b'.repeat(64), revision: '1' }, operation: '00000000-0000-4000-8000-000000000001' };
  assert.equal(await runDeliveryOperation(deliveryOperation('rollback', input), activation, signal), 'receipt');
  assert.deepEqual(call, [input.id, input.nextKey, input.expected, input.operation, 'rollback', signal]);
  const aborted = AbortSignal.abort();
  await assert.rejects(runDeliveryOperation(deliveryOperation('rollback', input), activation, aborted));
});


test('operations module omits hosted background bootstrap', async () => {
  const previous = process.env.AE_NETWORK_ID;
  process.env.AE_NETWORK_ID = 'ae_uat';
  try {
    const { ShortsTestnetModule } = require('./shorts.module');
    const { ShortsHostedBootstrapService } = require('./shorts-hosted-bootstrap.service');
    const result = await ShortsTestnetModule.register(true, { operationsOnly: true });
    assert.equal(result.providers.includes(ShortsHostedBootstrapService), false);
  } finally {
    if (previous === undefined) delete process.env.AE_NETWORK_ID;
    else process.env.AE_NETWORK_ID = previous;
  }
});

test('private input commands reject ambiguous scope, implicit enrollment and malformed identities before startup', () => {
  const retirement = { scope, id: 'post', sourceKey: 'a'.repeat(64), operation };
  const reserve = { scope, id: operation, scan, objectKey: 'private/scope/post/source-manifest/key/hash' };
  for (const [action, request] of [
    ['retire-encoded-inputs', { ...retirement, scope: { ...scope, other: true } }],
    ['retire-private-inputs', { ...retirement, scope: { network: 'ae_uat' } }],
    ['retire-private-inputs', { ...retirement, operation: '00000000-0000-1000-8000-000000000001' }],
    ['retire-private-inputs', { ...retirement, sourceKey: 'x' }],
    ['barrier-enrol', { scope, confirmPermanent: 'true' }],
    ['barrier-enrol', { scope }],
    ['barrier-enrol', { scope, confirmPermanent: true, id: operation }],
    ['barrier-reserve', { ...reserve, objectKey: 'private//wrong' }],
    ['barrier-reserve', { ...reserve, objectKey: 'https://provider/object' }],
    ['barrier-reserve', { ...reserve, scan: 'wrong' }],
    ['barrier-seal', { scope, id: 'post', scan }],
    ['barrier-status', { scope, id: operation, objectKey: 'wrong' }],
    ['barrier-cancel', { scope, id: 'post' }],
    ['reclaim-input', { scope, cid: 'not-a-cid', operation }],
    ['release-input', { scope, operation: 'bad' }],
    ['recover-input', { scope, operation, kind: 'pin' }],
  ]) assert.throws(() => deliveryOperation(action, request));
  assert.equal(deliveryOperation('retire-encoded-inputs', retirement).action, 'retire-encoded-inputs');
  assert.equal(deliveryOperation('barrier-enrol', { scope, confirmPermanent: true }).action, 'barrier-enrol');
});

test('input unpin commands bind saved roots, retain authority IDs, and never turn status or recovery into dispatch', async () => {
  const cid = 'b' + 'a'.repeat(58);
  const signal = new AbortController().signal;
  const reservation = { operationId: operation, inputCid: cid, state: 'reserved', roots: [{ ...scope, shortId: 'post', sourceKey: 'a'.repeat(64) }] };
  const permit = { state: 'uncertain', expires: 1000, quietUntil: 'later', storage: { secret: 'hidden' } };
  let saved = reservation;
  const calls = [];
  const pins = {
    coordinator: {
      reclaim: (...args) => { calls.push(['reclaim', ...args]); return { reservation, permit }; },
      release: (...args) => { calls.push(['release', ...args]); return { observed_pin: false, observed_at: 'now', node_epoch: 'hidden' }; },
    },
    recovery: { recover: (...args) => { calls.push(['recover', ...args]); return { observed_pin: false, observed_at: 'now', node_epoch: 'hidden' }; } },
    reservations: { get: async id => { assert.equal(id, operation); return saved; } },
    permits: { get: async () => permit },
    releases: { get: async () => null },
    recoveries: { get: async (kind, id) => { assert.equal(kind, 'unpin'); assert.equal(id, operation); return { recovered: true }; } },
  };
  const inputs = { scope, pins };
  const run = action => runDeliveryOperation(deliveryOperation(action, { scope, operation, ...(action === 'reclaim-input' ? { cid } : {}) }), {}, signal, inputs);
  const status = await run('input-reclamation-status');
  assert.equal(status.permit.state, 'uncertain');
  assert.equal(status.recovered, true);
  assert.equal(JSON.stringify(status).includes('hidden'), false);
  assert.deepEqual(calls, []);
  await run('reclaim-input');
  assert.deepEqual(calls.pop(), ['reclaim', cid, operation, signal]);
  const release = await run('release-input');
  assert.equal(release.observedPin, false);
  assert.deepEqual(calls.pop(), ['release', operation, signal]);
  const recovery = await run('recover-input');
  assert.equal(recovery.observedPin, false);
  assert.equal(JSON.stringify(recovery).includes('hidden'), false);
  assert.deepEqual(calls.pop(), ['recover', 'unpin', operation, signal]);
  saved = { ...reservation, roots: [{ ...scope, contract: 'ct_foreign' }] };
  for (const action of ['reclaim-input', 'release-input', 'recover-input', 'input-reclamation-status']) await assert.rejects(run(action), /scope changed/);
  assert.deepEqual(calls, []);
  saved = undefined;
  assert.equal(await run('input-reclamation-status'), null);
  await assert.rejects(run('release-input'), /reservation missing/);
  await assert.rejects(run('recover-input'), /reservation missing/);
  pins.reservations.get = async () => { throw new Error('Database unavailable'); };
  await assert.rejects(run('reclaim-input'), /Database unavailable/);
  assert.deepEqual(calls, []);
});

test('retirement commands preserve exact operation and parent cancellation and refuse foreign scope', async () => {
  const signal = new AbortController().signal;
  const request = { scope, id: 'post', sourceKey: 'a'.repeat(64), operation };
  const calls = [];
  const inputs = {
    scope,
    encoded: { retireInputs: (...args) => { calls.push(['encoded', ...args]); return { operation }; } },
    private: { retireInputs: (...args) => { calls.push(['private', ...args]); return { operation }; } },
    barriers: new Proxy({}, { get: () => assert.fail('No barrier action authorized') }),
  };
  for (const [action, kind] of [['retire-encoded-inputs', 'encoded'], ['retire-private-inputs', 'private']]) {
    assert.deepEqual(await runDeliveryOperation(deliveryOperation(action, request), {}, signal, inputs), { operation });
    assert.deepEqual(calls.pop(), [kind, request.id, request.sourceKey, operation, signal]);
  }
  await assert.rejects(runDeliveryOperation(deliveryOperation('retire-private-inputs', { ...request, scope: { ...scope, contract: 'ct_foreign' } }), {}, signal, inputs), /scope changed/);
  await assert.rejects(runDeliveryOperation(deliveryOperation('retire-private-inputs', request), {}, AbortSignal.abort(), inputs));
  await assert.rejects(runDeliveryOperation(deliveryOperation('retire-private-inputs', request), {}, signal), /scope changed/);
  assert.deepEqual(calls, []);
});

test('barrier mutations default off, recovery remains available, and receipts omit object references', async () => {
  const previous = process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
  const signal = new AbortController().signal;
  const requests = {
    'barrier-enrol': { scope, confirmPermanent: true },
    'barrier-reserve': { scope, id: operation, scan, objectKey: 'private/scope/post/part/0/key/hash' },
    'barrier-seal': { scope, id: operation, scan },
    'barrier-status': { scope, id: operation },
    'barrier-cancel': { scope, id: operation },
  };
  const row = { id: operation, state: 'reserved', scan_id: scan, reference_epoch: '4', bytes: '100', roots: [{ private: 'hidden' }], object_key: 'private-hidden', source_hash: 'hidden' };
  const calls = [];
  const barriers = Object.fromEntries(['enrol', 'reserve', 'seal', 'get', 'cancel'].map(method => [method, (...args) => { calls.push([method, ...args]); return row; }]));
  const inputs = { scope, barriers };
  const run = action => runDeliveryOperation(deliveryOperation(action, requests[action]), {}, signal, inputs);
  try {
    delete process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
    for (const action of ['barrier-enrol', 'barrier-reserve', 'barrier-seal']) await assert.rejects(run(action), /disabled/);
    assert.deepEqual(calls, []);
    for (const [action, method] of [['barrier-status', 'get'], ['barrier-cancel', 'cancel']]) {
      const result = await run(action);
      assert.deepEqual(calls.pop(), [method, scope, operation]);
      assert.equal(result.roots, 1);
      assert.equal(result.bytes, 100);
      assert.equal(JSON.stringify(result).includes('hidden'), false);
    }
    process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = 'invalid';
    await assert.rejects(run('barrier-enrol'), /Invalid private input barrier flag/);
    process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = 'true';
    assert.deepEqual(await run('barrier-enrol'), { scope, enrolled: true, permanent: true });
    assert.deepEqual(calls.pop(), ['enrol', scope]);
    await run('barrier-reserve');
    assert.deepEqual(calls.pop(), ['reserve', scope, operation, scan, requests['barrier-reserve'].objectKey]);
    await run('barrier-seal');
    assert.deepEqual(calls.pop(), ['seal', scope, operation, scan]);
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
    else process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = previous;
  }
});

const barrierBatch = () => ({
  scope, scan, confirmPermanent: true,
  items: [1, 2].map(n => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    objectKey: `private/scope/post/part/${n}/key/hash`,
  })),
});

test('barrier batches validate the entire bounded list and require unique explicit identities', () => {
  const request = barrierBatch();
  const variants = [
    { ...request, confirmPermanent: false },
    { ...request, scan: 'invalid' },
    { ...request, items: [] },
    { ...request, items: Array(101).fill(request.items[0]) },
    { ...request, items: [request.items[0], null] },
    { ...request, items: [request.items[0], { ...request.items[1], scope }] },
    { ...request, items: [request.items[0], { ...request.items[1], objectKey: 'private//bad' }] },
    { ...request, items: [request.items[0], { ...request.items[1], id: request.items[0].id }] },
    { ...request, items: [request.items[0], { ...request.items[1], objectKey: request.items[0].objectKey }] },
  ];
  for (const invalid of variants)
    assert.throws(() => deliveryOperation('barrier-reserve-seal-batch', invalid));
  assert.deepEqual(deliveryOperation('barrier-reserve-seal-batch', request).request, request);
});

test('one barrier batch retains the exact scope, IDs and scan while returning only sanitized receipts', async () => {
  const previous = process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
  const request = barrierBatch(), calls = [];
  const inputs = { scope, barriers: {
    reserve: async (...args) => { calls.push(['reserve', ...args]); },
    seal: async (...args) => {
      calls.push(['seal', ...args]);
      return { id: args[1], state: 'sealed', scan_id: scan, seal_scan_id: scan, reference_epoch: '12', bytes: '20', roots: [{}], object_key: 'hidden' };
    },
  } };
  const run = value => runDeliveryOperation(deliveryOperation('barrier-reserve-seal-batch', value), {}, new AbortController().signal, inputs);
  try {
    delete process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
    await assert.rejects(run(request), /disabled/);
    process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = 'true';
    await assert.rejects(run({ ...request, scope: { ...scope, contract: 'ct_other' } }), /scope changed/);
    assert.deepEqual(calls, []);
    const result = await run(request);
    assert.deepEqual(calls, request.items.flatMap(item => [
      ['reserve', scope, item.id, scan, item.objectKey], ['seal', scope, item.id, scan],
    ]));
    assert.equal(result.sealed, 2);
    assert.deepEqual(result.barriers.map(row => row.id), request.items.map(item => item.id));
    assert.equal(result.barriers.every(row => row.state === 'sealed'), true);
    assert.equal(JSON.stringify(result).includes('hidden'), false);
  } finally {
    if (previous === undefined) delete process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
    else process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = previous;
  }
});

test('barrier batches stop immediately after a failed or cancelled committed step', async () => {
  const previous = process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
  process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = 'true';
  try {
    for (const mode of ['reserve-error', 'seal-error', 'reserve-abort', 'seal-abort']) {
      const stop = new AbortController(), calls = [];
      const inputs = { scope, barriers: {
        reserve: async () => {
          calls.push('reserve');
          if (mode === 'reserve-error') throw new Error('stale scan');
          if (mode === 'reserve-abort') stop.abort();
        },
        seal: async () => {
          calls.push('seal');
          if (mode === 'seal-error') throw new Error('changed policy');
          if (mode === 'seal-abort') stop.abort();
          return { roots: [] };
        },
      } };
      await assert.rejects(runDeliveryOperation(deliveryOperation('barrier-reserve-seal-batch', barrierBatch()), {}, stop.signal, inputs));
      assert.deepEqual(calls, mode.startsWith('reserve') ? ['reserve'] : ['reserve', 'seal']);
    }
  } finally {
    if (previous === undefined) delete process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
    else process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = previous;
  }
});

test('barrier batches enforce the fixed deadline before dispatching another operation', async t => {
  const previous = process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
  process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = 'true';
  const deadline = new AbortController(), calls = [];
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 120000); return deadline.signal; });
  try {
    const inputs = { scope, barriers: {
      reserve: async () => { calls.push('reserve'); deadline.abort(); },
      seal: () => assert.fail('No seal after batch deadline'),
    } };
    await assert.rejects(runDeliveryOperation(deliveryOperation('barrier-reserve-seal-batch', barrierBatch()), {}, new AbortController().signal, inputs));
    assert.deepEqual(calls, ['reserve']);
  } finally {
    if (previous === undefined) delete process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED;
    else process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED = previous;
  }
});
