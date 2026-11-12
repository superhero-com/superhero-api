// Real original restaging, worker preparation and trusted activation operations.
// No package is injected into Redis and no canonical record is rewritten.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { once } = require('node:events');

exports.assembledGenerations = async (t, f, playback) => {
  const { owner, scope, id, dir, b, request, until, pause } = f;
  const { viewer, edgeBase, get, session, graph, sourceKey, startWorker, recoverIndex } = playback;
  const args = [scope.network, scope.contract, id];
  const original = (await owner.query('SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3', args))[0].body;
  const chain = await readFile(join(dir, 'chain.json'), 'utf8');
  const initial = (await request(b, `/playback/${id}`)).body;
  const initialKey = sourceKey(initial), jobId = randomUUID();
  let operations, stopWorker;
  const stopOperations = async () => {
    if (!operations || operations.process.exitCode !== null || operations.process.signalCode !== null) return;
    operations.process.send({ action: 'stop' }); await operations.wait('stopped');
    if (operations.process.exitCode === null && operations.process.signalCode === null) await once(operations.process, 'exit');
  };
  t.after(async () => { await stopWorker?.(); await stopOperations(); });
  const command = async (action, parameters = {}) => (await operations.command(action, { shortId: id, ...parameters })).result;
  const version = manifest => {
    const token = manifest.searchParams.get('token'); assert.match(token, /^v3\.\d+\.[a-f0-9]{64}\./);
    return token.split('.')[2];
  };
  const segment = async manifest => (await graph(manifest)).assets.find(url => url.pathname.endsWith('v1080-segment-000.m4s'));
  const unchanged = async () => {
    const current = (await owner.query('SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3', args))[0].body;
    assert.deepEqual(current, original, 'generation operations preserve the canonical record');
    assert.equal(await readFile(join(dir, 'chain.json'), 'utf8'), chain, 'published CID and chain engagement remain unchanged');
  };
  await viewer?.pause();
  operations = await f.startDeliveryOperations();
  const previous = { sourceKey: initialKey, revision: '0' };
  assert.deepEqual(await command('delivery-state'), previous);
  const oldManifest = await session(edgeBase), oldSegment = await segment(oldManifest);
  assert.equal(version(oldManifest), initialKey);
  assert.equal((await get(oldSegment)).status, 200);
  assert.equal((await get(oldSegment)).headers.get('x-cache'), 'HIT');

  await t.test('a real replacement is restaged from the pinned original and prepared without changing current playback', async () => {
    assert.deepEqual(await command('delivery-restage', { jobId }), { jobId, shortId: id, ready: true });
    assert.deepEqual(await command('delivery-restage', { jobId }), { jobId, shortId: id, ready: true });
    const [staged] = await owner.query('SELECT input,status FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3', [...args.slice(0, 2), jobId]);
    assert.equal(staged.status, 'queued'); assert.equal(staged.input.sha256, original.original.sha256);
    assert.equal(staged.input.bytes, original.bytes);
    stopWorker = await f.startUploadWorker();
    const candidate = await until(async () => (await owner.query('SELECT body FROM shorts_delivery_generations WHERE network=$1 AND contract=$2 AND job_id=$3', [...args.slice(0, 2), jobId]))[0]?.body, 120000);
    await stopWorker(); stopWorker = undefined; f.rememberMedia(candidate);
    assert.equal(candidate.cid, original.cid); assert.equal(candidate.original.sha256, original.original.sha256);
    assert.equal(candidate.derivatives.generation.job, jobId);
    await unchanged();
    assert.equal(sourceKey((await request(b, `/playback/${id}`)).body), initialKey);
  });
  const candidateResponse = await request(b, `/playback/${id}/generations/${jobId}`);
  assert.equal(candidateResponse.status, 200);
  const candidate = candidateResponse.body, nextKey = sourceKey(candidate);
  assert.notEqual(nextKey, initialKey);
  await t.test('the actual streaming worker acknowledges a candidate while public sessions still use the original generation', async () => {
    assert.equal((await request(b, `/playback/${id}/versions/${nextKey}`)).status, 404);
    assert.equal((await request(b, `/playback/${id}/generations/${jobId}/prepared/${nextKey}`)).status, 404);
    await startWorker();
    const first = await command('delivery-prepare', { jobId }); assert.equal(first.sourceKey, nextKey);
    assert.ok(['preparing', 'ready'].includes(first.status));
    await until(async () => (await command('delivery-prepare', { jobId })).status === 'ready', 120000);
    const ack = await request(b, `/playback/${id}/generations/${jobId}/prepared/${nextKey}`);
    assert.equal(ack.status, 200); assert.equal(ack.body.sourceKey, nextKey);
    assert.equal((await request(b, `/playback/${id}/versions/${nextKey}`)).status, 404);
    assert.equal(version(await session(edgeBase)), initialKey);
    await unchanged();
  });
  let selected, activeManifest, activeSegment;
  const views = () => owner.query('SELECT views FROM shorts_measurement_totals WHERE network=$1 AND contract=$2 AND short_id=$3', args);
  await t.test('activation changes new signed sessions, retains old cache hits and preserves canonical content and engagement', async () => {
    const before = await views(), operation = randomUUID();
    selected = await command('delivery-select', { sourceKey: nextKey, expected: previous, operation, kind: 'activate' });
    assert.equal(selected.revision, '1'); assert.equal(selected.sourceKey, nextKey);
    assert.deepEqual(await command('delivery-select', { sourceKey: nextKey, expected: previous, operation, kind: 'activate' }), selected);
    assert.deepEqual(await views(), before);
    await unchanged(); await pause(2100);
    assert.equal(sourceKey((await request(b, `/playback/${id}`)).body), nextKey);
    assert.equal((await get(oldManifest)).status, 200);
    const retained = await get(oldSegment); assert.equal(retained.status, 200); assert.equal(retained.headers.get('x-cache'), 'HIT');
    activeManifest = await session(edgeBase); assert.equal(version(activeManifest), nextKey);
    activeSegment = await segment(activeManifest); assert.equal((await get(activeSegment)).status, 200);
    assert.equal((await get(activeSegment)).headers.get('x-cache'), 'HIT');
    await viewer?.generation(nextKey); await viewer?.pause();
    const [count] = await owner.query('SELECT count(*)::int AS count FROM shorts_delivery_selections WHERE network=$1 AND contract=$2 AND short_id=$3', args);
    assert.equal(count.count, 1);
  });
  await t.test('retained original sessions restore a lost index through both master playback and warm edge authorization', async () => {
    await recoverIndex(initialKey, async () => assert.equal((await get(oldManifest)).status, 200));
    await recoverIndex(initialKey, async () => {
      const retained = await get(oldSegment);
      assert.equal(retained.status, 200); assert.equal(retained.headers.get('x-cache'), 'HIT');
    });
    await unchanged();
  });
  await t.test('rollback uses retained real media with activation disabled and both generations keep their signed identities', async () => {
    await stopOperations(); operations = await f.startDeliveryOperations(false);
    const expected = { sourceKey: nextKey, revision: '1' };
    await assert.rejects(command('delivery-select', { sourceKey: initialKey, expected, operation: randomUUID(), kind: 'activate' }), error => error.actual === 'Delivery selection unavailable');
    const before = await views(), operation = randomUUID();
    const reverted = await command('delivery-select', { sourceKey: initialKey, expected, operation, kind: 'rollback' });
    assert.equal(reverted.revision, '2'); assert.equal(reverted.sourceKey, initialKey);
    assert.deepEqual(await command('delivery-select', { sourceKey: initialKey, expected, operation, kind: 'rollback' }), reverted);
    assert.deepEqual(await views(), before); await unchanged(); await pause(2100);
    assert.equal(version(await session(edgeBase)), initialKey);
    const retained = await get(activeSegment); assert.equal(retained.status, 200); assert.equal(retained.headers.get('x-cache'), 'HIT');
    assert.equal((await get(activeManifest)).status, 200);
    assert.equal((await request(b, `/playback/${id}/versions/${nextKey}`)).status, 200);
    await viewer?.generation(initialKey); await viewer?.pause();
    const [count] = await owner.query('SELECT count(*)::int AS count FROM shorts_delivery_selections WHERE network=$1 AND contract=$2 AND short_id=$3', args);
    assert.equal(count.count, 2);
  });
  await t.test('retained replacement sessions restore their generation-specific acknowledgement after rollback', async () => {
    await recoverIndex(nextKey, async () => assert.equal((await get(activeManifest)).status, 200));
    await recoverIndex(nextKey, async () => {
      const retained = await get(activeSegment);
      assert.equal(retained.status, 200); assert.equal(retained.headers.get('x-cache'), 'HIT');
    });
    assert.equal(version(await session(edgeBase)), initialKey); await unchanged();
  });
  await stopOperations();
};
