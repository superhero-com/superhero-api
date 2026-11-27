const schemaMigrations = require('./testing/schema-migrations.cjs');
const {
  ShortsDeliveryPackages: Migration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { sourceKey, validateSourcePackage } = require('./hls-protocol/hls-package');
const { adaptiveSourceIdentity } = require('./hls-protocol/playback-descriptor');
const { workerRole } = require('./testing/worker-role.cjs');
const fixture = require('./testing/hls-v3.json');

test('durable delivery metadata binds the ladder, strips non-protocol data and rejects source/package aliasing', () => {
  const prepared = structuredClone(fixture.package); prepared.private = 'omitted'; prepared.files[0].private = 'omitted';
  const clean = validateSourcePackage(fixture.descriptor, prepared);
  assert.doesNotMatch(JSON.stringify(clean), /omitted|private/);
  for (const cid of [fixture.descriptor.cid, fixture.descriptor.derivatives.cid, fixture.descriptor.derivatives.assetsCid])
    assert.throws(() => validateSourcePackage(fixture.descriptor, { ...prepared, cid }));
  for (const mutate of [d => { d.derivatives.videos[0].width = 642; }, d => { d.derivatives.videos[0].frameRate = '30/1'; },
    d => { d.files = d.files.filter(f => !f.name.startsWith('audio-')); }]) {
    const descriptor = structuredClone(fixture.descriptor); mutate(descriptor);
    assert.throws(() => validateSourcePackage(descriptor, prepared), /ladder/);
  }
  assert.throws(() => validateSourcePackage(fixture.descriptor, { ...prepared, excess: 'x'.repeat(131072) }));
});

test('PostgreSQL delivery acknowledgement survives restart, fences conflicts and remains a retained reference', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  const schema = 'shorts_delivery_' + randomUUID().replaceAll('-', '');
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 4 } };
  let owner = new DataSource(options), worker, identity; await owner.initialize();
  t.after(async () => {
    if (worker?.isInitialized) await worker.destroy(); if (identity) await identity.dispose();
    if (owner.isInitialized) await owner.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy();
  });
  await owner.transaction(async db => {
    for (const name of ['ShortsMetadata', 'ShortsUploads', 'ShortsWorkers',
      'ShortsWorkerAuthority', 'ShortsProcessingCapacity', 'ShortsRetentionHolds',
      'ShortsHlsInventory', 'ShortsWorkerBackpressure', 'ShortsOriginalContent',
      'ShortsAdaptiveInventory'])
      await new schemaMigrations[name]().up(db);
    await new Migration().up(db);
  });
  await owner.transaction(db => new Migration().down(db)); await owner.transaction(db => new Migration().up(db));
  const descriptor = structuredClone(fixture.descriptor), scope = { network: descriptor.network, contract: descriptor.contract };
  await owner.query('INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,4)',
    [scope.network, scope.contract, 'a'.repeat(64)]);
  const insert = async d => owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [d.network, d.contract, d.id, 'ak_creator', JSON.stringify({ ...d, creator: 'ak_creator', createdAt: 1, publication: 'published' })]);
  await insert(descriptor);
  let service = new ShortsDeliveryPackagesService(owner);
  const key = sourceKey(descriptor), expected = validateSourcePackage(descriptor, fixture.package);
  const args = [scope.network, scope.contract, descriptor.id, key, adaptiveSourceIdentity(descriptor), JSON.stringify(expected)];
  const rawInsert = values => owner.query('INSERT INTO shorts_delivery_packages(network,contract,short_id,source_key,source_identity,prepared) VALUES($1,$2,$3,$4,$5,$6)', values);
  await t.test('wrong identity, generation fence and fabricated key cannot attach to an original', async () => {
    assert.equal(await service.get(descriptor), undefined);
    await assert.rejects(rawInsert(args.map((v,i) => i === 3 ? '0'.repeat(64) : v)), { code: 'SH409' });
    for (const mutate of [d => { d.derivatives.generation.fence = '2'; }, d => { d.derivatives.generation.job = 'new-job'; },
      d => { d.cid = 'bafy' + 'z'.repeat(50); }, d => { d.bytes += 1; }]) {
      const changed = structuredClone(descriptor); mutate(changed);
      await assert.rejects(service.acknowledge(changed, expected), { code: 'SH409' });
    }
    await assert.rejects(rawInsert(args.map((v,i) => i === 5 ? '{}' : v)), { code: '23514' });
    await assert.rejects(rawInsert(args.map((v,i) => i === 5 ? JSON.stringify({ ...expected, cid: null }) : v)), { code: '23514' });
  });
  await t.test('concurrent retries converge and a different HLS package cannot replace the acknowledgement', async () => {
    await Promise.all(Array.from({ length: 8 }, () => service.acknowledge(descriptor, fixture.package)));
    assert.deepEqual(await service.get(descriptor), expected);
    assert.equal((await owner.query('SELECT count(*)::integer AS n FROM shorts_delivery_packages'))[0].n, 1);
    await assert.rejects(service.acknowledge(descriptor, { ...expected, cid: 'bafy' + 'z'.repeat(50) }), { status: 409 });
    assert.deepEqual(await service.get(descriptor), expected);
  });
  await t.test('reconnect restores exact metadata without mutating the original or requiring Redis', async () => {
    await owner.destroy(); owner = new DataSource(options); await owner.initialize(); service = new ShortsDeliveryPackagesService(owner);
    assert.deepEqual(await service.get(descriptor), expected);
    const [row] = await owner.query('SELECT body FROM shorts_content WHERE id=$1', [descriptor.id]);
    assert.equal(row.body.cid, descriptor.cid); assert.equal(row.body.bytes, descriptor.bytes);
    assert.deepEqual(row.body.derivatives, descriptor.derivatives);
  });
  await t.test('retention includes acknowledged HLS with holds and cross-record reference counts even without a Redis index', async () => {
    const other = structuredClone(descriptor); other.id = 'another-short'; other.derivatives.generation.job = other.id;
    await insert(other); await service.acknowledge(other, expected);
    const retention = new ShortsRetentionService(owner, { scope, sourceHash: 'a'.repeat(64) });
    await retention.hold({ id: randomUUID(), resourceId: descriptor.id, reason: 'recovery', reference: 'restore-check' });
    const inventory = await retention.inventory(); const row = inventory.items.find(item => item.id === descriptor.id);
    assert.equal(row.activeHolds, 1); assert.equal(row.eligibleForDeletion, false);
    assert.deepEqual(row.pins.find(pin => pin.kind === 'hls'), { kind: 'hls', cid: expected.cid,
      bytes: expected.files.reduce((n,f) => n+f.bytes, 0), references: 2 });
    const { ShortsHlsInventoryService } = require('./shorts-hls-inventory.service');
    const scanner = new ShortsHlsInventoryService(owner, { scope, sourceHash: 'a'.repeat(64), storageId: 'b'.repeat(64), namespace: 'delivery-test' },
      retention, { page: async () => ({ epoch: 'c'.repeat(40), next: '0', items: [] }) });
    const run = randomUUID(); await scanner.start(run); let status;
    do { status = await scanner.step(run); } while (!status.indexTraversalComplete);
    assert.equal(status.referenceVersion, 5); assert.equal(status.entries, '0');
    const observed = (await scanner.roots(run)).items.find(item => item.id === descriptor.id || item.resourceId === descriptor.id);
    assert.ok(observed); assert.equal(observed.indexObserved, false); assert.equal(observed.activeHolds, 1);
    assert.equal(observed.pins.find(pin => pin.kind === 'hls').cid, expected.cid);
  });
  await t.test('workers have no delivery metadata authority; acknowledgements cannot be erased by normal writes or rollback', async () => {
    identity = await workerRole(admin, { url: url.href, schema, scope });
    worker = new DataSource({ ...options, url: identity.url }); await worker.initialize();
    await assert.rejects(worker.query('SELECT * FROM shorts_delivery_packages'), { code: '42501' });
    for (const sql of ['UPDATE shorts_delivery_packages SET acknowledged_at=clock_timestamp()',
      'DELETE FROM shorts_delivery_packages', 'TRUNCATE shorts_delivery_packages'])
      await assert.rejects(owner.query(sql), { code: 'SH409' });
    await assert.rejects(owner.transaction(db => new Migration().down(db)), /Preserve acknowledged/);
  });
});
