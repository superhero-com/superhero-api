const schemaMigrations = require('./testing/schema-migrations.cjs');
const {
  ShortsDeliverySelection: Migration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { WorkerRpc } = require('../../test/shorts/worker-rpc');
const { ShortsDeliveryGenerationsService } = require('./shorts-delivery-generations.service');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { ShortsDeliverySelectionService, SHORTS_DELIVERY_RETAIN_SECONDS } = require('./shorts-delivery-selection.service');
const { ShortsDeliveryActivationService } = require('./shorts-delivery-activation.service');
const { ShortsService } = require('./shorts.service');
const { validateSourcePackage } = require('./hls-protocol/hls-package');
const { workerRole } = require('./testing/worker-role.cjs');
const golden = require('./testing/hls-v3.json');
const hash = value => createHash('sha256').update(value).digest('hex');

test('delivery selection is atomic, reversible, scoped and independent of canonical content', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_selection_' + randomUUID().replaceAll('-', ''), scope = { network: 'ae_uat', contract: 'ct_protocol' };
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 } };
  const owner = new DataSource(options); await owner.initialize(); let identity, workerDb;
  t.after(async () => { await workerDb?.destroy(); await owner.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await identity?.dispose(); await admin.destroy(); });
  await owner.transaction(async db => {
    for (const name of ['ShortsMetadata', 'ShortsUploads', 'ShortsWorkers',
      'ShortsWorkerAuthority', 'ShortsProcessingCapacity', 'ShortsRetentionHolds',
      'ShortsHlsInventory', 'ShortsPinInventory', 'ShortsWorkerBackpressure',
      'ShortsUploadBudget', 'ShortsOriginalContent', 'ShortsAdaptiveInventory',
      'ShortsDeliveryPackages', 'ShortsDeliveryGenerations',
      'ShortsGenerationDeliveryPackages', 'ShortsDeliveryStaging'])
      await new schemaMigrations[name]().up(db);
    await new Migration().up(db);
  });
  await owner.transaction(db => new Migration().down(db)); await owner.transaction(db => new Migration().up(db));
  const original = { ...structuredClone(golden.descriptor), creator: 'ak_creator', title: 'Original title', topic: 'Art', duration: 4,
    publication: 'published', moderation: 'approved', safety: { status: 'no_flags', sourceSha256: golden.descriptor.original.sha256 },
    createdAt: 1, reports: 0, views: ['original-view'], likes: 42 };
  const args = [scope.network, scope.contract, original.id];
  const metadata = new ShortsMetadataService(owner), sourceHash = 'a'.repeat(64);
  await metadata.initialize(scope, sourceHash, 30, 30);
  await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [...args, original.creator, JSON.stringify(original)]);
  identity = await workerRole(admin, { url: url.href, schema, scope });
  workerDb = new DataSource({ ...options, url: identity.url }); await workerDb.initialize();
  const worker = new WorkerRpc(workerDb, { scope, sourceHash }); await worker.verifyRuntime(scope, sourceHash);
  const generations = new ShortsDeliveryGenerationsService(owner, metadata), packages = new ShortsDeliveryPackagesService(owner);
  const selections = new ShortsDeliverySelectionService(owner), scopeHash = hash(JSON.stringify([scope.network, scope.contract]));
  const makeCandidate = async (id, changes = {}) => {
    const key = `shorts-private-v1/${scopeHash}/${id}/source-manifest/key1/${sourceHash}`;
    const input = { processingProfile: 'original-h264-v1', objectKey: key, manifest: { key, keyId: 'key1', bytes: 100, sha256: sourceHash },
      sha256: original.original.sha256, bytes: original.bytes, title: changes.title || original.title, topic: original.topic, details: {} };
    await generations.enqueue(scope, id, original.id, input);
    const job = await worker.claim(scope); assert.equal(job.id, id);
    const record = { ...structuredClone(original), id, title: input.title, publication: undefined, moderation: 'pending',
      ...changes, derivatives: { ...structuredClone(original.derivatives), fingerprint: hash(id), assetsCid: 'bafy' + 'd'.repeat(50),
        generation: { job: id, fence: job.fence } } };
    record.privateMedia = { version: 1, fence: job.fence, source: job.input,
      files: Object.fromEntries(record.files.map(file => [file.name, { bytes: file.bytes, sha256: file.sha256, keyId: 'key1',
        key: `shorts-private-v1/${scopeHash}/${id}/attempt/${job.fence}/${file.name.replaceAll('.', '-')}/key1/${file.sha256}` }])) };
    await worker.complete(scope, job, record);
    const candidate = await generations.get(scope, id); await packages.acknowledge(candidate.descriptor, golden.package);
    return candidate;
  };
  const first = await makeCandidate('replacement-1'), second = await makeCandidate('replacement-2');
  const bad = await makeCandidate('replacement-bad', { title: 'Unreviewed new title' });
  const initial = { sourceKey: golden.sourceKey, revision: '0' };
  let chainWithdrawn = false;
  const chain = { release: scope, state: { contract: scope.contract }, read: async () => ({ cid: original.cid, creator: original.creator,
    size: BigInt(original.bytes), withdrawn: chainWithdrawn, likes: 42n }) };
  const shorts = new ShortsService(chain);
  shorts.records = { find: async () => (await owner.query('SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3', args))[0].body };
  shorts.deliverySelection = selections; shorts.deliveryPackages = packages;
  const count = async () => (await owner.query('SELECT count(*)::integer AS n FROM shorts_delivery_selections'))[0].n;
  const insert = (db, expected, next, operation = randomUUID(), kind = 'activate') => db.query(`INSERT INTO shorts_delivery_selections
    (network,contract,short_id,revision,operation_id,from_source_key,source_key,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [...args, String(BigInt(expected.revision) + 1n), operation, expected.sourceKey, next, kind]);

  await t.test('prepared candidates cannot serve or select without an acknowledged current version', async () => {
    assert.deepEqual(await selections.state(scope, original), initial);
    assert.deepEqual(await shorts.playbackDescriptor(original.id), golden.descriptor);
    await assert.rejects(selections.historical({ ...scope, network: 'ae_mainnet' }, original, golden.sourceKey), { status: 404 });
    await assert.rejects(shorts.playbackVersion(original.id, first.sourceKey), { status: 404 });
    await assert.rejects(selections.commit(scope, original.id, initial, first.sourceKey, randomUUID(), 'activate'), { status: 404 });
    assert.equal(await count(), 0); await packages.acknowledge(golden.descriptor, golden.package);
    await assert.rejects(insert(owner, initial, bad.sourceKey), { code: 'SH409' });
    await assert.rejects(insert(owner, initial, first.sourceKey, randomUUID(), 'rollback'), { code: 'SH409' });
    for (const patch of [{ publication: 'withdrawn' }, { moderation: 'rejected' }, { safety: { status: 'review', sourceSha256: original.original.sha256 } }]) {
      await assert.rejects(owner.transaction(async db => {
        await db.query('UPDATE shorts_content SET body=body||$4::jsonb WHERE network=$1 AND contract=$2 AND id=$3', [...args, JSON.stringify(patch)]);
        await insert(db, initial, first.sourceKey);
      }), { code: 'SH409' });
    }
    assert.equal(await count(), 0);
  });
  let active, receipt, operation;
  await t.test('concurrent writers use compare-and-swap and ambiguous retries reuse one immutable receipt', async () => {
    const operations = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled([first, second].map((candidate, index) =>
      selections.commit(scope, original.id, initial, candidate.sourceKey, operations[index], 'activate')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SH409');
    const index = results.findIndex(result => result.status === 'fulfilled');
    active = [first, second][index]; operation = operations[index]; receipt = results[index].value;
    assert.equal(receipt.revision, '1'); assert.equal(receipt.sourceKey, active.sourceKey);
    assert.equal(Date.parse(receipt.retainPreviousUntil) - Date.parse(receipt.selectedAt), SHORTS_DELIVERY_RETAIN_SECONDS * 1000);
    assert.deepEqual(await selections.commit(scope, original.id, initial, active.sourceKey, operation, 'activate'), receipt);
    await assert.rejects(selections.commit(scope, original.id, initial, [first, second][1 - index].sourceKey, operation, 'activate'), { status: 409 });
    assert.equal(await count(), 1);
    assert.deepEqual(await shorts.playbackDescriptor(original.id), active.descriptor);
    assert.deepEqual(await shorts.playbackVersion(original.id, golden.sourceKey), golden.descriptor);
    assert.deepEqual((await shorts.playbackPackage(original.id, golden.sourceKey)).prepared, validateSourcePackage(golden.descriptor, golden.package));
    assert.doesNotMatch(JSON.stringify(await shorts.playbackDescriptor(original.id)), /privateMedia|objectKey|moderation|safety/);
  });
  await t.test('rollback stays available with selection disabled and only verifies its previously selected target', async () => {
    const env = process.env.SHORTS_DELIVERY_SELECTION_ENABLED; delete process.env.SHORTS_DELIVERY_SELECTION_ENABLED;
    const verified = [], coordinator = new ShortsDeliveryActivationService(shorts, { verifyDurableDelivery: async record => {
      verified.push(record.id); if (record.id === active.record.id) throw new Error('Current HLS is damaged');
    } }, selections);
    try {
      const expected = await selections.state(scope, original);
      await assert.rejects(coordinator.select(original.id, golden.sourceKey, expected, randomUUID()), { status: 503 });
      const rolledBack = await coordinator.select(original.id, golden.sourceKey, expected, randomUUID(), 'rollback');
      assert.equal(rolledBack.revision, '2'); assert.deepEqual(verified, [original.id]);
      assert.deepEqual(await shorts.playbackDescriptor(original.id), golden.descriptor);
      assert.deepEqual(await shorts.playbackVersion(original.id, active.sourceKey), active.descriptor);
      await assert.rejects(selections.commit(scope, original.id, initial, active.sourceKey, randomUUID(), 'activate'), { code: 'SH409' }, 'ABA cannot reuse revision zero');
    } finally { await coordinator.onModuleDestroy(); if (env === undefined) delete process.env.SHORTS_DELIVERY_SELECTION_ENABLED; else process.env.SHORTS_DELIVERY_SELECTION_ENABLED = env; }
  });
  await t.test('activation verifies both packages, rejects corruption and withdrawal, and retries a committed operation without IO', async () => {
    const env = process.env.SHORTS_DELIVERY_SELECTION_ENABLED; process.env.SHORTS_DELIVERY_SELECTION_ENABLED = 'true';
    let fail, withdraw, verified = [];
    const coordinator = new ShortsDeliveryActivationService(shorts, { verifyDurableDelivery: async record => {
      verified.push(record.id); if (record.id === fail) throw new Error('Corrupt durable package'); if (withdraw) chainWithdrawn = true;
    } }, selections);
    const expected = await selections.state(scope, original), target = active;
    try {
      for (const id of [target.record.id, original.id]) {
        fail = id; await assert.rejects(coordinator.select(original.id, target.sourceKey, expected, randomUUID()), /Corrupt durable/);
        assert.equal(await count(), 2);
      }
      fail = undefined; withdraw = true;
      await assert.rejects(coordinator.select(original.id, target.sourceKey, expected, randomUUID()), { status: 404 }); assert.equal(await count(), 2);
      chainWithdrawn = false; withdraw = false; verified = []; const op = randomUUID();
      const commit = selections.commit;
      selections.commit = async function (...values) { await commit.apply(this, values); throw new Error('Commit acknowledgement lost'); };
      try { await assert.rejects(coordinator.select(original.id, target.sourceKey, expected, op), /Commit acknowledgement lost/); }
      finally { selections.commit = commit; }
      const selected = await selections.operation(scope, original.id, op);
      assert.deepEqual(verified, [target.record.id, original.id]); assert.equal(selected.revision, '3');
      verified = []; assert.deepEqual(await coordinator.select(original.id, target.sourceKey, expected, op), selected);
      assert.deepEqual(verified, []); assert.equal(await count(), 3);
      process.env.SHORTS_DELIVERY_SELECTION_ENABLED = 'false';
      const disabled = new ShortsDeliveryActivationService(shorts, { verifyDurableDelivery: async () => { throw new Error('Must not reverify a committed operation'); } }, selections);
      try { assert.deepEqual(await disabled.select(original.id, target.sourceKey, expected, op), selected); }
      finally { await disabled.onModuleDestroy(); }
      chainWithdrawn = true;
      await assert.rejects(shorts.playbackDescriptor(original.id), { status: 404 });
      await assert.rejects(shorts.playbackVersion(original.id, golden.sourceKey), { status: 404 });
      await assert.rejects(coordinator.select(original.id, target.sourceKey, expected, op), { status: 404 });
    } finally { chainWithdrawn = false; await coordinator.onModuleDestroy(); if (env === undefined) delete process.env.SHORTS_DELIVERY_SELECTION_ENABLED; else process.env.SHORTS_DELIVERY_SELECTION_ENABLED = env; }
  });
  await t.test('history cannot be rewritten or removed and expired historical sessions do not authorize media', async () => {
    for (const sql of ['UPDATE shorts_delivery_selections SET selected_at=clock_timestamp()', 'DELETE FROM shorts_delivery_selections', 'TRUNCATE shorts_delivery_selections'])
      await assert.rejects(owner.query(sql), { code: 'SH409' });
    for (const sql of ['SELECT * FROM shorts_delivery_selections', 'DELETE FROM shorts_delivery_selections'])
      await assert.rejects(workerDb.query(sql), { code: '42501' });
    await assert.rejects(owner.transaction(db => new Migration().down(db)), /Preserve selected delivery history/);
    // Owner-only fixture time travel. Runtime roles never disable guards.
    await owner.query("ALTER TABLE shorts_delivery_selections DISABLE TRIGGER USER; UPDATE shorts_delivery_selections SET selected_at=clock_timestamp()-interval '2 hours'; ALTER TABLE shorts_delivery_selections ENABLE TRIGGER USER");
    await assert.rejects(shorts.playbackVersion(original.id, golden.sourceKey), { status: 404 });
    assert.deepEqual(await shorts.playbackDescriptor(original.id), active.descriptor);
    await selections.commit(scope, original.id, await selections.state(scope, original), golden.sourceKey, randomUUID(), 'rollback');
    assert.deepEqual(await shorts.playbackVersion(original.id, active.sourceKey), active.descriptor);
    assert.deepEqual((await owner.query('SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3', args))[0].body, original);
    // Exercise the capacity boundary without manufacturing a thousand switches.
    await owner.query('ALTER TABLE shorts_delivery_selections DISABLE TRIGGER USER; UPDATE shorts_delivery_selections SET revision=1023 WHERE revision=4; ALTER TABLE shorts_delivery_selections ENABLE TRIGGER USER');
    const full = await selections.state(scope, original);
    await assert.rejects(selections.commit(scope, original.id, full, active.sourceKey, randomUUID(), 'activate'), /reserved for rollback/);
    assert.equal((await selections.commit(scope, original.id, full, active.sourceKey, randomUUID(), 'rollback')).revision, '1024');
    await assert.rejects(selections.commit(scope, original.id, await selections.state(scope, original), golden.sourceKey, randomUUID(), 'rollback'), { status: 409 });
  });
});

test('activation bounds transfers and cancels before selection on shutdown or caller abort', async () => {
  const env = process.env.SHORTS_DELIVERY_SELECTION_ENABLED; process.env.SHORTS_DELIVERY_SELECTION_ENABLED = 'true';
  const original = { id: 'short', original: { version: 1 } }, expected = { sourceKey: 'a'.repeat(64), revision: '0' }, scope = { network: 'ae_uat', contract: 'ct_fixture' };
  let reads = 0, transfers = 0, commits = 0;
  const shorts = { chain: { release: scope, state: { contract: scope.contract } }, ensurePlayable: async () => { reads++; return original; } };
  const selections = { operation: async () => undefined, state: async () => expected,
    acknowledged: async () => ({ record: {}, descriptor: {}, prepared: {} }), commit: async () => { commits++; } };
  const coordinator = new ShortsDeliveryActivationService(shorts, { verifyDurableDelivery: async (_record, _descriptor, _prepared, signal) => {
    signal.throwIfAborted(); transfers++;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }, selections);
  try {
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(coordinator.select('short', 'b'.repeat(64), expected, randomUUID(), 'activate', aborted.signal));
    assert.equal(reads, 0);
    const first = coordinator.select('short', 'b'.repeat(64), expected, randomUUID());
    const second = coordinator.select('short', 'b'.repeat(64), expected, randomUUID());
    const settled = Promise.allSettled([first, second]);
    await assert.rejects(coordinator.select('short', 'b'.repeat(64), expected, randomUUID()), { status: 503 });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(transfers, 2);
    await coordinator.onModuleDestroy(); assert.ok((await settled).every(result => result.status === 'rejected'));
    assert.equal(commits, 0); assert.equal(coordinator.pending.size, 0);
  } finally { await coordinator.onModuleDestroy(); if (env === undefined) delete process.env.SHORTS_DELIVERY_SELECTION_ENABLED; else process.env.SHORTS_DELIVERY_SELECTION_ENABLED = env; }
});
