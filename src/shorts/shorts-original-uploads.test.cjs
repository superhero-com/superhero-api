const schemaMigrations = require('./testing/schema-migrations.cjs');
const {
  ShortsOriginalUploads: Migration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsUploadRecordsService } = require('./shorts-upload-records.service');
const { ShortsUploadPolicyService, shortsUploadPolicyConfig } = require('./shorts-upload-policy.service');
const { shortsAcceptedSource } = require('./shorts-upload-policy');
const { WorkerRpc } = require('../../test/shorts/worker-rpc');
const { workerRole } = require('./testing/worker-role.cjs');
const sha = createHash('sha256').update('original').digest('hex');

test('original upload migration, frozen admission, 96 direct parts, enqueue and rollback preservation', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_original_upload_' + randomUUID().replaceAll('-', '');
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  let db, worker, identity;
  t.after(async () => {
    if (worker?.isInitialized) await worker.destroy();
    if (db?.isInitialized) await db.destroy();
    if (identity) await identity.dispose();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.destroy();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = new DataSource({ type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 4 } });
  await db.initialize();
  await db.transaction(async manager => {
    for (const name of ['ShortsMetadata','ShortsUploads','ShortsWorkers',
      'ShortsWorkerAuthority','ShortsProcessingCapacity','ShortsRetentionHolds',
      'ShortsWorkerBackpressure','ShortsUploadBudget','ShortsDirectUploads',
      'ShortsOriginalContent','ShortsDeliveryPackages','ShortsDeliveryGenerations',
      'ShortsDeliveryStaging']) await new schemaMigrations[name]().up(manager);
    await new Migration().up(manager);
  });
  await db.transaction(manager => new Migration().down(manager));
  await db.transaction(manager => new Migration().up(manager));
  const scope = { network: 'ae_uat', contract: 'ct_uploadfixture' }, creator = 'ak_creator';
  const metadata = new ShortsMetadataService(db), records = new ShortsUploadRecordsService(db, metadata);
  await metadata.initialize(scope, sha, 30, 30);
  await metadata.configureUploadBudget(scope, { uploads: 500, sourceBytes: 20971520000 });
  const policy = { maxVideoBytes: 100000000 };
  const enabled = new ShortsUploadPolicyService({ originals: true, maxOriginalBytes: 100000000 });
  const input = enabled.accept({ bytes: 100000000, sha256: sha, title: 'Original', topic: 'Art', rights: true, details: {} }, policy);
  await records.create(scope, 'original', creator, input);
  const reduced = new ShortsUploadPolicyService(shortsUploadPolicyConfig({ SHORTS_ORIGINAL_UPLOAD_MAX_BYTES: '1000' }));
  assert.throws(() => reduced.accept(input, policy), { status: 400 });
  assert.equal(shortsAcceptedSource((await records.get(scope, 'original', creator)).input).maxBytes, 100000000);
  for (let index = 0; index < 96; index++) {
    const object = { key: `${'a'.repeat(402)}${String(index).padStart(3, '0')}/${'a'.repeat(32)}/${sha}`, keyId: 'a'.repeat(32), bytes: Math.min(1048576, input.bytes - index * 1048576), sha256: sha };
    await records.reserveDirect(scope, 'original', creator, index, object);
    await records.bindDirectChecksum(scope, 'original', creator, index, sha);
    await records.part(scope, 'original', creator, index, object);
  }
  const [size] = await db.query("SELECT octet_length(direct_parts::text) AS bytes FROM shorts_upload_sessions WHERE id='original'");
  assert.ok(size.bytes > 65536 && size.bytes <= 131072);
  await assert.rejects(records.reserveDirect(scope, 'original', creator, 96, { key: 'extra', keyId: 'key1', bytes: 1, sha256: sha }), { status: 400 });
  const sealed = await records.seal(scope, 'original', creator);
  assert.equal(sealed.parts.length, 96); assert.equal(sealed.parts.at(-1).object.bytes, 385280);
  const manifest = { key: `source/manifest/key1/${sha}`, keyId: 'key1', bytes: 70000, sha256: sha };
  const job = await records.enqueue(scope, 'original', creator, manifest);
  assert.equal(job.input.processingProfile, 'original-h264-v1');
  assert.equal(job.input.acceptedMaxBytes, 100000000);
  assert.deepEqual((await records.enqueue(scope, 'original', creator, manifest)).input, job.input);
  identity = await workerRole(admin, { url: url.href, schema, scope });
  worker = new DataSource({ type: 'postgres', url: identity.url, schema, extra: { options: `-c search_path=${schema}`, max: 2 } }); await worker.initialize();
  const [{ result: older }] = await worker.query('SELECT shorts_media_worker($1,$2::jsonb) AS result', ['claim', JSON.stringify({ ...scope, sourceHash: sha, mediaProtocol: 3, leaseMs: 120000 })]);
  assert.equal(older, null, 'older workers must not consume a source their reader rejects');
  const repo = new WorkerRpc(worker, { scope, sourceHash: sha }); await repo.verifyRuntime(scope, sha);
  const claimed = await repo.claim(scope);
  assert.equal(claimed.id, 'original'); assert.equal(claimed.input.acceptedMaxBytes, 100000000);
  await assert.rejects(db.transaction(manager => new Migration().down(manager)), /Preserve accepted original uploads/);
  for (let index = 0; index < 3; index++) await records.create(scope, `more-${index}`, creator, input);
  await assert.rejects(records.create(scope, 'quota', creator, input), { status: 429 });
  await assert.rejects(records.create(scope, 'legacy-too-large', 'ak_other', { ...input, processingProfile: undefined, acceptedMaxBytes: undefined }), { status: 400 });
});
