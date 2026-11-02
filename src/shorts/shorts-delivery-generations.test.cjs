require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsWorkerRepositoryService } = require('./shorts-worker-repository.service');
const { ShortsDeliveryGenerationsService } = require('./shorts-delivery-generations.service');
const { ShortsDeliveryGenerations1793145603000: Migration } = require('../migrations/1793145603000-ShortsDeliveryGenerations');
const { ShortsLegacyDeliverySources1793232003000: LegacySourcesMigration } = require('../migrations/1793232003000-ShortsLegacyDeliverySources');
const { ShortsGenerationDeliveryPackages1793145605000: PackagesMigration } = require('../migrations/1793145605000-ShortsGenerationDeliveryPackages');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { validateSourcePackage } = require('./hls-protocol/hls-package');
const { workerRole } = require('./testing/worker-role.cjs');
const fixture = require('./testing/hls-v3.json');
const hash = 'a'.repeat(64), scopeHash = createHash('sha256').update(JSON.stringify(['ae_uat', 'ct_protocol'])).digest('hex');
function input(id, source = fixture.descriptor) {
  const key = `shorts-private-v1/${scopeHash}/${id}/source-manifest/key1/${hash}`;
  return { processingProfile: 'original-h264-v1', objectKey: key, manifest: { key, keyId: 'key1', bytes: 100, sha256: hash },
    sha256: source.original.sha256, bytes: source.bytes, title: 'Replacement', topic: 'Art', details: {} };
}
function result(job, source = fixture.descriptor) {
  const value = structuredClone(source); value.id = job.id; delete value.network; delete value.contract;
  value.creator = job.creator; value.title = job.input.title; value.topic = 'Art'; value.duration = 4; value.createdAt = 1;
  value.moderation = 'pending'; value.safety = { status: 'no_flags', sourceSha256: value.original.sha256 };
  value.derivatives.generation = { job: job.id, fence: job.fence };
  value.derivatives.cid = 'bafy' + 'g'.repeat(50); value.derivatives.assetsCid = 'bafy' + 'd'.repeat(50);
  value.privateMedia = { version: 1, fence: job.fence, source: job.input,
    files: Object.fromEntries(value.files.map(file => [file.name, { bytes: file.bytes, sha256: file.sha256, keyId: 'key1',
      key: `shorts-private-v1/${scopeHash}/${job.id}/attempt/${job.fence}/${file.name.replaceAll('.', '-')}/key1/${file.sha256}` }])) };
  return value;
}

test('replacement jobs use fenced workers, preserve the post and expose no creator upload or active replacement', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_generations_' + randomUUID().replaceAll('-', '');
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 4 } };
  const owner = new DataSource(options); await owner.initialize(); const identities = [], clients = [];
  t.after(async () => { for (const db of clients) await db.destroy(); await owner.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    for (const identity of identities) await identity.dispose(); await admin.destroy(); });
  await owner.transaction(async db => {
    for (const name of ['1791763200000-ShortsMetadata', '1791763202000-ShortsUploads', '1791763203000-ShortsWorkers',
      '1791763204000-ShortsWorkerAuthority', '1791763215000-ShortsProcessingCapacity', '1791763216000-ShortsRetentionHolds', '1791763219000-ShortsHlsInventory',
      '1791763220000-ShortsPinInventory', '1791763222000-ShortsWorkerBackpressure', '1791763224000-ShortsUploadBudget', '1793145600000-ShortsOriginalContent',
      '1793145601000-ShortsAdaptiveInventory', '1793145602000-ShortsDeliveryPackages'])
      await new (Object.values(require('../migrations/' + name))[0])().up(db);
    await new Migration().up(db);
  });
  await owner.transaction(db => new Migration().down(db)); await owner.transaction(db => new Migration().up(db));
  await owner.transaction(db => new LegacySourcesMigration().up(db));
  const scope = { network: 'ae_uat', contract: 'ct_protocol' }, metadata = new ShortsMetadataService(owner);
  await metadata.initialize(scope, hash, 30, 30);
  const original = { ...structuredClone(fixture.descriptor), creator: 'ak_creator', title: 'Original post', createdAt: 5, duration: 4,
    publication: 'published', moderation: 'approved', safety: { status: 'no_flags' }, reports: 7, views: ['untouched'], likes: 42 };
  await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,5,$5)',
    [scope.network, scope.contract, original.id, original.creator, JSON.stringify(original)]);
  const packages = new ShortsDeliveryPackagesService(owner);
  await packages.acknowledge(fixture.descriptor, fixture.package);
  await owner.transaction(db => new PackagesMigration().up(db));
  assert.equal((await owner.query('SELECT generation_job_id FROM shorts_delivery_packages'))[0].generation_job_id, original.id);
  await owner.transaction(db => new PackagesMigration().down(db));
  assert.deepEqual(await packages.get(fixture.descriptor), validateSourcePackage(fixture.descriptor, fixture.package));
  await owner.transaction(db => new PackagesMigration().up(db));
  const generations = new ShortsDeliveryGenerationsService(owner, metadata);
  const worker = async () => {
    const identity = await workerRole(admin, { url: url.href, schema, scope }); identities.push(identity);
    const db = new DataSource({ ...options, url: identity.url }); await db.initialize(); clients.push(db);
    const repo = new ShortsWorkerRepositoryService(db, { scope, sourceHash: hash }); await repo.verifyRuntime(scope, hash);
    return { db, repo, rpc: async (action, data = {}) => (await db.query('SELECT shorts_media_worker($1,$2::jsonb) result',
      [action, JSON.stringify({ ...scope, sourceHash: hash, ...data })]))[0].result };
  };
  const first = await worker(), second = await worker();
  assert.equal((await first.rpc('verify')).deliveryGenerationVersion, 1);
  let job;
  await t.test('acceptance binds exact original bytes, rejects duplicate active jobs, and hides operation jobs from upload actions', async () => {
    await assert.rejects(generations.enqueue(scope, 'bad', original.id, { ...input('bad'), sha256: hash }), { status: 409 });
    const accepted = await generations.enqueue(scope, 'replace-1', original.id, input('replace-1'));
    assert.equal(accepted.deliveryShortId, original.id);
    assert.equal((await generations.enqueue(scope, 'replace-1', original.id, input('replace-1'))).id, 'replace-1');
    await assert.rejects(generations.enqueue(scope, 'replace-2', original.id, input('replace-2')), { code: 'SH409' });
    for (const action of ['getJob','retry','cancel']) await assert.rejects(metadata[action](scope, original.creator, 'replace-1'), { status: 404 });
    await assert.rejects(owner.query("UPDATE shorts_ingestion SET input=jsonb_set(input,'{bytes}','99') WHERE id='replace-1'"), { code: 'SH409' });
    await assert.rejects(owner.query("UPDATE shorts_ingestion SET delivery_short_id=NULL WHERE id='replace-1'"), { code: 'SH409' });
    const [budget] = await owner.query('SELECT used_uploads,used_source_bytes FROM shorts_upload_budgets');
    assert.equal(budget.used_uploads, '2'); assert.equal(budget.used_source_bytes, String(original.bytes * 2));
  });
  await t.test('older workers cannot claim replacement work and new workers prioritize creator uploads under one processing ceiling', async () => {
    assert.equal(await first.rpc('claim', { leaseMs: 120000, mediaProtocol: 2 }), null);
    assert.equal(await metadata.claim(scope), undefined);
    await metadata.enqueue(scope, 'upload-1', original.creator, input('upload-1'));
    await owner.query('UPDATE shorts_runtime SET max_processing=1');
    const upload = await first.repo.claim(scope); assert.equal(upload.id, 'upload-1');
    assert.equal(await second.repo.claim(scope), undefined);
    await first.repo.fail(scope, upload);
    job = await first.repo.claim(scope); assert.equal(job.id, 'replace-1'); assert.equal(job.deliveryShortId, original.id);
    assert.equal(await second.repo.claim(scope), undefined);
  });
  await t.test('late and foreign workers cannot attach outputs or replace canonical source identity', async () => {
    await assert.rejects(second.repo.complete(scope, job, result(job)), { status: 409 });
    for (const mutate of [r => { r.cid = 'bafy' + 'z'.repeat(50); }, r => { r.original.mediaType = 'video/quicktime'; },
      r => { r.derivatives.generation.fence = String(BigInt(job.fence) + 1n); r.privateMedia.fence = r.derivatives.generation.fence; }]) {
      const changed = result(job); mutate(changed); await assert.rejects(first.repo.complete(scope, job, changed));
    }
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE id='replace-1'");
    const stale = job; job = await second.repo.claim(scope); assert.equal(BigInt(job.fence), BigInt(stale.fence) + 1n);
    await assert.rejects(first.repo.complete(scope, stale, result(stale)), { status: 409 });
    await second.repo.complete(scope, job, result(job));
  });
  await t.test('completion stores a private generation linked to the same post and leaves all published data untouched', async () => {
    const generation = await generations.get(scope, job.id);
    assert.equal(generation.shortId, original.id); assert.equal(generation.descriptor.id, original.id);
    assert.equal(generation.descriptor.cid, original.cid); assert.equal(generation.record.id, job.id);
    assert.equal(generation.descriptor.derivatives.generation.job, job.id); assert.equal(generation.record.moderation, 'pending');
    assert.equal(generation.record.publication, undefined);
    const rows = await owner.query('SELECT body FROM shorts_content'); assert.equal(rows.length, 1); assert.deepEqual(rows[0].body, original);
    const [stored] = await owner.query('SELECT status,result_id FROM shorts_ingestion WHERE id=$1', [job.id]);
    assert.equal(stored.status, 'ready'); assert.equal(stored.result_id, original.id);
    for (const sql of ['SELECT * FROM shorts_delivery_generations', 'UPDATE shorts_content SET body=body'])
      await assert.rejects(first.db.query(sql), { code: '42501' });
    for (const sql of ['DELETE FROM shorts_delivery_generations', 'UPDATE shorts_delivery_generations SET body=body', 'TRUNCATE shorts_delivery_generations'])
      await assert.rejects(owner.query(sql), { code: 'SH409' });
    await assert.rejects(owner.transaction(db => new Migration().down(db)), /Preserve delivery generation history/);
  });
  await t.test('replacement source/output references inherit the original post holds and review retention reasons', async () => {
    const { ShortsRetentionService } = require('./shorts-retention.service');
    const retention = new ShortsRetentionService(owner, { scope, sourceHash: hash, prefix: 'shorts-private-v1' });
    await retention.hold({ id: randomUUID(), resourceId: original.id, reason: 'recovery', reference: 'original-hold' });
    const row = (await retention.inventory()).items.find(item => item.id === job.id);
    assert.equal(row.deliveryOf, original.id); assert.equal(row.activeHolds, 1);
    assert.ok(row.retainReasons.includes('reports-without-disposition')); assert.ok(row.retainReasons.includes('delivery-generation-reference'));
    assert.equal(row.hlsSource.id, original.id); assert.equal(row.hlsSource.derivatives.generation.job, job.id);
    assert.equal(row.pins.find(pin => pin.kind === 'inputs').cid, result(job).derivatives.cid);
    assert.equal(row.pins.find(pin => pin.kind === 'original').references, 2);
    assert.equal(row.objects.length, fixture.descriptor.files.length + 1);
    assert.equal(row.manifestSources[0].id, job.id); assert.equal(row.eligibleForDeletion, false);
    const { ShortsHlsInventoryService } = require('./shorts-hls-inventory.service');
    const scanner = new ShortsHlsInventoryService(owner, { scope, sourceHash: hash, namespace: 'generation-test', storageId: hash }, retention,
      { page: async () => ({ epoch: 'c'.repeat(40), next: '0', items: [] }) });
    const run = randomUUID(); await scanner.start(run); let status;
    do { status = await scanner.step(run); } while (!status.indexTraversalComplete);
    assert.equal(status.referenceVersion, 5);
    const root = (await scanner.roots(run)).items.find(item => item.id === job.id);
    assert.equal(root.sourceKey, (await generations.get(scope, job.id)).sourceKey); assert.equal(root.activeHolds, 1);
    assert.equal(root.indexObserved, false); assert.deepEqual(root.pins, row.pins);
  });
  await t.test('replacement HLS acknowledgements bind to the accepted generation without changing active playback', async () => {
    const { descriptor } = await generations.get(scope, job.id);
    for (const mutate of [d => { d.derivatives.generation.fence = '999'; }, d => { d.derivatives.generation.job = 'missing'; },
      d => { d.derivatives.fingerprint = '9'.repeat(64); }, d => { d.cid = 'bafy' + 'z'.repeat(50); }]) {
      const changed = structuredClone(descriptor); mutate(changed);
      await assert.rejects(packages.acknowledge(changed, fixture.package), { code: 'SH409' });
    }
    await assert.rejects(owner.transaction(async transaction => {
      const other = structuredClone(original); other.id = 'another-post'; other.derivatives.generation.job = other.id;
      await transaction.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,5,$5)',
        [scope.network, scope.contract, other.id, other.creator, other]);
      // Use the same transaction connection so a foreign canonical post is present for the guard.
      const { sourceKey } = require('./hls-protocol/hls-package');
      const { adaptiveSourceIdentity } = require('./hls-protocol/playback-descriptor');
      const foreign = { ...descriptor, id: other.id };
      await transaction.query('INSERT INTO shorts_delivery_packages(network,contract,short_id,source_key,source_identity,prepared) VALUES($1,$2,$3,$4,$5,$6)',
        [scope.network, scope.contract, other.id, sourceKey(foreign), adaptiveSourceIdentity(foreign), fixture.package]);
    }), { code: 'SH409' });
    await Promise.all(Array.from({ length: 4 }, () => packages.acknowledge(descriptor, fixture.package)));
    assert.deepEqual(await new ShortsDeliveryPackagesService(owner).get(descriptor), validateSourcePackage(descriptor, fixture.package));
    await assert.rejects(packages.acknowledge(descriptor, { ...fixture.package, cid: 'bafy' + 'z'.repeat(50) }), { status: 409 });
    assert.equal((await owner.query('SELECT count(*)::integer AS n FROM shorts_delivery_packages'))[0].n, 2);
    assert.deepEqual((await owner.query('SELECT body FROM shorts_content'))[0].body, original);
    assert.deepEqual(await packages.get(fixture.descriptor), validateSourcePackage(fixture.descriptor, fixture.package));
    await assert.rejects(owner.transaction(db => new PackagesMigration().down(db)), /Preserve acknowledged generation history/);
    for (const sql of ['UPDATE shorts_delivery_packages SET prepared=prepared', 'DELETE FROM shorts_delivery_packages', 'TRUNCATE shorts_delivery_packages'])
      await assert.rejects(owner.query(sql), { code: 'SH409' });
    await assert.rejects(first.db.query('SELECT * FROM shorts_delivery_packages'), { code: '42501' });
    const { ShortsRetentionService } = require('./shorts-retention.service');
    const retention = new ShortsRetentionService(owner, { scope, sourceHash: hash, prefix: 'shorts-private-v1' });
    const rows = (await retention.inventory()).items;
    for (const id of [original.id, job.id]) {
      const row = rows.find(item => item.id === id), hls = row.pins.filter(pin => pin.kind === 'hls');
      assert.equal(hls.length, 1); assert.equal(hls[0].cid, fixture.package.cid); assert.equal(hls[0].references, 2);
      assert.equal(row.activeHolds, 1); assert.equal(row.eligibleForDeletion, false);
    }
    const { ShortsHlsInventoryService } = require('./shorts-hls-inventory.service');
    const scanner = new ShortsHlsInventoryService(owner, { scope, sourceHash: hash, namespace: 'generation-test', storageId: hash }, retention,
      { page: async () => ({ epoch: 'c'.repeat(40), next: '0', items: [] }) });
    const run = randomUUID(); await scanner.start(run); let status;
    do { status = await scanner.step(run); } while (!status.indexTraversalComplete);
    const saved = (await scanner.roots(run)).items.find(item => item.id === job.id);
    assert.equal(saved.indexObserved, false); assert.equal(saved.pins.find(pin => pin.kind === 'hls').references, 2);
    const { ShortsPinInventoryService } = require('./shorts-pin-inventory.service');
    const pins = new ShortsPinInventoryService(owner, { scope, sourceHash: hash, storageId: hash, peerId: 'fixture' }, retention, {
      identity: async () => {}, capacity: async () => ({ repoBytes: '1', storageMaxBytes: '1000' }),
      pins: async function* (type) { if (type === 'recursive') yield [{ cid: fixture.package.cid, type }]; },
    });
    const pinRun = randomUUID(), pinStatus = await pins.scan(pinRun, run);
    assert.equal(pinStatus.referenceCoverage, 'original-and-acknowledged-generation-inventory');
    const observed = (await pins.entries(pinRun)).items[0]; assert.equal(observed.classification, 'held');
    assert.equal(observed.derivativeReferences, '2'); assert.equal(observed.packageReferences, '0');
    assert.ok(!(await pins.missing(pinRun)).items.some(pin => pin.cid === fixture.package.cid));
  });
  await t.test('generation inventory requires unfiltered read access and detects incomplete schema', async () => {
    const { ShortsRetentionService } = require('./shorts-retention.service');
    const role = 'shgenread_' + randomUUID().replaceAll('-', ''), password = randomUUID();
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    identities.push({ dispose: async () => { await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`); } });
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ${['shorts_runtime','shorts_content','shorts_ingestion',
      'shorts_upload_sessions','shorts_upload_parts','shorts_delivery_packages','shorts_retention_holds'].map(name => `${schema}.${name}`).join(',')} TO ${role}`);
    const login = new URL(url); login.username = role; login.password = password;
    const reader = new DataSource({ ...options, url: login.href }); await reader.initialize(); clients.push(reader);
    const retention = new ShortsRetentionService(reader, { scope, sourceHash: hash, prefix: 'shorts-private-v1' });
    await assert.rejects(retention.verify('read-only'), /read-only/);
    await owner.query(`GRANT SELECT ON shorts_delivery_generations TO ${role}`); await retention.verify('read-only');
    await owner.query('ALTER TABLE shorts_delivery_generations ENABLE ROW LEVEL SECURITY');
    await assert.rejects(retention.verify('read-only'), /read-only/);
    await owner.query('ALTER TABLE shorts_delivery_generations DISABLE ROW LEVEL SECURITY');
    await owner.query('ALTER TABLE shorts_delivery_generations RENAME TO hidden_generation_fixture');
    try { await assert.rejects(retention.inventory(), /Incomplete delivery generation schema/); }
    finally { await owner.query('ALTER TABLE hidden_generation_fixture RENAME TO shorts_delivery_generations'); }
  });
});
