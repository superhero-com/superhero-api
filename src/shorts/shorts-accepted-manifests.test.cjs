require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { S3Client, CreateBucketCommand, PutBucketVersioningCommand, ListObjectVersionsCommand, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const { migratePrivateVersionTables } = require('./testing/private-version-database.cjs');
const { workerRole } = require('./testing/worker-role.cjs');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsUploadRecordsService } = require('./shorts-upload-records.service');
const { ShortsSourceService } = require('./shorts-source.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsDeliveryStagingService } = require('./shorts-delivery-staging.service');
const { ShortsDeliveryGenerationsService } = require('./shorts-delivery-generations.service');
const { ShortsWorkerRepositoryService } = require('./shorts-worker-repository.service');
const { ShortsAcceptedManifests1793491201000: Migration } = require('../migrations/1793491201000-ShortsAcceptedManifests');
const hash = value => createHash('sha256').update(value).digest('hex');

test('accepted manifests bind every ordinary and restaged source child atomically without changing public jobs', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_manifests_' + randomUUID().replaceAll('-', '');
  const scope = { network: 'ae_uat', contract: 'ct_protocol' }, args = [scope.network, scope.contract], creator = 'ak_creator';
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  let db, workerDb, workerIdentity, objects;
  t.after(async () => {
    objects?.onModuleDestroy();
    for (const connection of [workerDb, db]) if (connection?.isInitialized) await connection.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await workerIdentity?.dispose(); await admin.destroy();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 5 } };
  db = new DataSource(options); await db.initialize();
  await db.transaction(async runner => {
    await migratePrivateVersionTables(runner);
    for (const name of ['1792022400000-ShortsDirectUploads', '1793232000000-ShortsOriginalUploads'])
      await new (Object.values(require('../migrations/' + name))[0])().up(runner);
  });
  const sourceHash = hash('source'), metadata = new ShortsMetadataService(db), records = new ShortsUploadRecordsService(db, metadata);
  await metadata.initialize(scope, sourceHash, 30, 30);
  await metadata.configureUploadBudget(scope, { uploads: 500, sourceBytes: 20971520000 });
  objects = new ShortsPrivateObjectsService({ endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'unused', prefix: 'shorts-private-v1',
    credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' }, activeKeyId: 'key1', keys: { key1: Buffer.alloc(32) } });
  const stored = new Map();
  const transport = { validateReference: (...values) => objects.validateReference(...values),
    put: async (scope, id, slot, bytes) => {
      const ref = objects.plannedReference(scope, id, slot, { bytes: bytes.length, sha256: hash(bytes) });
      stored.set(ref.key, Buffer.from(bytes)); return ref;
    }, get: async (_scope, ref) => {
      const bytes = stored.get(ref.key); assert.equal(bytes.length, ref.bytes); assert.equal(hash(bytes), ref.sha256); return bytes;
    } };
  const sources = new ShortsSourceService(records, transport, metadata);
  const make = (id, bytes = 5, original = false) => {
    const input = { bytes, sha256: hash('source-' + id), title: 'Title', topic: 'Art', details: {},
      ...(original ? { processingProfile: 'original-h264-v1', acceptedMaxBytes: 100000000 } : {}) };
    const document = { version: 1, id, creator, bytes, sha256: input.sha256,
      parts: Array.from({ length: Math.ceil(bytes / 1048576) }, (_, index) => ({ index,
        object: objects.plannedReference(scope, id, 'part/' + index, {
          bytes: Math.min(1048576, bytes - index * 1048576), sha256: hash('part-' + id + '-' + index),
        }) })) };
    return bind(id, input, document);
  };
  const bind = (id, input, document) => {
    const manifest = JSON.stringify(document);
    const reference = objects.plannedReference(scope, id, 'source-manifest', { bytes: Buffer.byteLength(manifest), sha256: hash(manifest) });
    return { input: { ...input, objectKey: reference.key, manifest: reference }, manifest, document };
  };
  const enqueue = (id, data) => metadata.enqueue(scope, id, creator, data.input, undefined, undefined, data.manifest);
  const row = async id => (await db.query('SELECT * FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3', [...args, id]))[0];
  const epoch = async () => Number((await db.query('SELECT revision FROM shorts_private_storage_epochs WHERE network=$1 AND contract=$2', args))[0].revision);
  const old = make('older');
  await enqueue('older', old);
  assert.equal(Object.hasOwn(await row('older'), 'source_manifest'), false, 'new writers can still use older schemas');
  await db.transaction(runner => new Migration().up(runner));
  await db.transaction(runner => new Migration().down(runner));
  await db.transaction(runner => new Migration().up(runner));

  await t.test('binding an older accepted job advances reference revision once and retries preserve the exact document', async () => {
    const before = await epoch();
    const [a, b] = await Promise.all([enqueue('older', old), enqueue('older', old)]);
    assert.deepEqual(a, b); assert.equal((await row('older')).source_manifest, old.manifest);
    assert.equal(await epoch(), before + 1);
    assert.equal('source_manifest' in a, false); assert.equal('sourceManifest' in a, false);
    await assert.rejects(metadata.enqueue(scope, 'older', creator, old.input, undefined, undefined, old.manifest + ' '), { status: 409 });
    assert.equal(await epoch(), before + 1);
  });
  await t.test('ordinary legacy uploads persist the actual manifest through the existing upload coordinator', async () => {
    const id = 'ordinary', bytes = Buffer.from('hello');
    await records.create(scope, id, creator, { bytes: bytes.length, sha256: hash(bytes), title: 'Title', topic: 'Art', rights: true, details: {} });
    await sources.part(scope, id, creator, 0, bytes);
    const job = await sources.finish(scope, id, creator);
    const accepted = await row(id);
    assert.equal(accepted.source_manifest, stored.get(job.input.manifest.key).toString());
    assert.deepEqual(await sources.read(scope, job), bytes);
    assert.deepEqual(await sources.finish(scope, id, creator), job);
    assert.equal((await records.get(scope, id, creator)).state, 'enqueued');
  });
  await t.test('encrypted storage survives a rolled-back admission and retries bind the exact stored plaintext once', {
    skip: !process.env.SHORTS_TEST_S3_ENDPOINT,
  }, async storageTest => {
    const endpoint = new URL(process.env.SHORTS_TEST_S3_ENDPOINT); assert.equal(endpoint.hostname, '127.0.0.1');
    const config = { endpoint: endpoint.origin, region: 'us-east-1', bucket: 'shorts-manifest-' + randomUUID(), prefix: 'shorts-private-v1', forcePathStyle: true,
      credentials: { accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY, secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY },
      activeKeyId: 'key1', keys: { key1: Buffer.alloc(32, 7) } };
    const raw = new S3Client(config), encrypted = new ShortsPrivateObjectsService(config); let created = false;
    storageTest.after(async () => {
      encrypted.onModuleDestroy();
      try {
        if (created) {
          let next;
          do {
            const listed = await raw.send(new ListObjectVersionsCommand({ Bucket: config.bucket, ...next }));
            const keys = [...(listed.Versions || []), ...(listed.DeleteMarkers || [])].map(item => ({ Key: item.Key, VersionId: item.VersionId }));
            if (keys.length) await raw.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys } }));
            next = listed.IsTruncated ? { KeyMarker: listed.NextKeyMarker, VersionIdMarker: listed.NextVersionIdMarker } : undefined;
          } while (next);
          await raw.send(new DeleteBucketCommand({ Bucket: config.bucket }));
        }
      } finally { raw.destroy(); }
    });
    await raw.send(new CreateBucketCommand({ Bucket: config.bucket })); created = true;
    await raw.send(new PutBucketVersioningCommand({ Bucket: config.bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    let fail = true;
    const fault = { getJob: (...args) => metadata.getJob(...args), enqueue: async (...args) => {
      const result = await metadata.enqueue(...args); if (fail) throw new Error('fixture admission rollback'); return result;
    } };
    const uploadRecords = new ShortsUploadRecordsService(db, fault), source = new ShortsSourceService(uploadRecords, encrypted, metadata);
    const id = 'encrypted', bytes = Buffer.from('exact original source fixture');
    await uploadRecords.create(scope, id, creator, { bytes: bytes.length, sha256: hash(bytes), title: 'Title', topic: 'Art', rights: true, details: {} });
    await source.part(scope, id, creator, 0, bytes);
    await assert.rejects(source.finish(scope, id, creator), /fixture admission rollback/);
    assert.equal(await row(id), undefined); assert.equal((await uploadRecords.get(scope, id, creator)).state, 'sealed');
    fail = false;
    const job = await source.finish(scope, id, creator), accepted = await row(id);
    assert.equal((await encrypted.get(scope, job.input.manifest)).toString(), accepted.source_manifest);
    assert.deepEqual(await source.read(scope, job), bytes);
    assert.deepEqual(await source.finish(scope, id, creator), job);
    const versions = await raw.send(new ListObjectVersionsCommand({ Bucket: config.bucket }));
    assert.equal(versions.Versions.length, 2, 'the part and manifest each retain exactly one encrypted version across rollback/retry');
    assert.equal(versions.DeleteMarkers?.length || 0, 0);
  });
  await t.test('a 100 MB original admits all 96 direct-part references and the original frozen limit', async () => {
    const id = 'maximum', data = make(id, 100000000, true);
    await records.create(scope, id, creator, { ...data.input, rights: true });
    for (const part of data.document.parts) {
      await records.reserveDirect(scope, id, creator, part.index, part.object);
      await records.bindDirectChecksum(scope, id, creator, part.index, hash('ciphertext-' + part.index));
      await records.part(scope, id, creator, part.index, part.object);
    }
    const job = await sources.finish(scope, id, creator), accepted = await row(id);
    assert.equal(job.input.acceptedMaxBytes, 100000000);
    const document = JSON.parse(accepted.source_manifest); assert.equal(document.parts.length, 96);
    assert.equal(document.parts.at(-1).object.bytes, 385280);
    const [{ refs }] = await db.query('SELECT shorts_accepted_source_refs($1,$2,$3,$4,$5,$6) AS refs',
      [...args, id, creator, job.input, accepted.source_manifest]);
    assert.equal(refs.length, 97); assert.deepEqual(refs.slice(1), data.document.parts.map(part => part.object));
  });
  await t.test('invalid exact documents or hidden malformed references roll back admission and upload state together', async () => {
    const bad = make('atomic');
    await records.create(scope, 'atomic', creator, { ...bad.input, rights: true });
    await records.part(scope, 'atomic', creator, 0, bad.document.parts[0].object); await records.seal(scope, 'atomic', creator);
    await assert.rejects(records.enqueue(scope, 'atomic', creator, bad.input.manifest, bad.manifest + ' '), { code: 'SH400' });
    assert.equal(await row('atomic'), undefined); assert.equal((await records.get(scope, 'atomic', creator)).state, 'sealed');
    let index = 0;
    for (const mutate of [doc => { doc.version = 2; }, doc => { doc.id = 'other'; }, doc => { doc.creator = 'ak_other'; },
      doc => { doc.bytes++; }, doc => { doc.parts = []; }, doc => { doc.parts[0].index = 1; },
      doc => { doc.parts[0].object.bytes++; }, doc => { doc.parts[0].object.extra = true; },
      doc => { doc.parts[0].object.key = doc.parts[0].object.key.replace(hash(JSON.stringify(args)), 'f'.repeat(64)); }]) {
      const id = 'invalid-' + index++, data = make(id); mutate(data.document);
      const changed = bind(id, data.input, data.document);
      await assert.rejects(enqueue(id, changed), { code: 'SH400' }); assert.equal(await row(id), undefined);
    }
    const invalid = make('digest');
    await assert.rejects(enqueue('digest', { ...invalid, manifest: invalid.manifest.replace('"version":1', '"version":2') }), /identity mismatch/);
    assert.equal(await row('digest'), undefined);
  });
  await t.test('replacement staging and the internal generation admission path persist the same exact source closure', async () => {
    const canonical = { ...structuredClone(require('./testing/hls-v3.json').descriptor), creator, title: 'Title', topic: 'Art', duration: 4,
      createdAt: 1, publication: 'published', moderation: 'approved', safety: { status: 'no_flags', sourceSha256: '1'.repeat(64) } };
    await db.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)', [...args, canonical.id, creator, canonical]);
    const candidate = id => {
      const data = make(id, canonical.bytes, true); data.input.sha256 = canonical.original.sha256; data.document.sha256 = canonical.original.sha256;
      return bind(id, data.input, data.document);
    };
    const staging = new ShortsDeliveryStagingService(db, metadata), staged = candidate('staged');
    const claim = await staging.reserve(scope, 'staged', canonical.id, staged.input, staged.manifest);
    assert.equal((await row('staged')).source_manifest, claim.manifest); await staging.finish(scope, claim);
    await db.query("UPDATE shorts_ingestion SET status='cancelled' WHERE id='staged'");
    const generations = new ShortsDeliveryGenerationsService(db, metadata), generation = candidate('generation');
    await generations.enqueue(scope, 'generation', canonical.id, generation.input, generation.manifest);
    assert.equal((await row('generation')).source_manifest, generation.manifest);
    await db.query("UPDATE shorts_ingestion SET status='cancelled' WHERE id='generation'");
    const bad = candidate('bad-staged');
    await assert.rejects(staging.reserve(scope, 'bad-staged', canonical.id, bad.input, bad.manifest + ' '), { code: 'SH400' });
    assert.equal(await row('bad-staged'), undefined);
  });
  await t.test('other connections cannot observe an admitted job before its manifest transaction commits', async () => {
    const data = make('atomic-visible'), runner = db.createQueryRunner();
    await runner.connect(); await runner.startTransaction();
    try {
      await metadata.enqueue(scope, 'atomic-visible', creator, data.input, runner.manager, undefined, data.manifest);
      assert.equal(await row('atomic-visible'), undefined);
      await runner.commitTransaction();
      assert.equal((await row('atomic-visible')).source_manifest, data.manifest);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });
  await t.test('bound source identity and document history cannot change while worker leases and retries remain usable', async () => {
    for (const change of ["source_manifest=NULL", "source_manifest=source_manifest||' '",
      "input=jsonb_set(input,'{acceptedMaxBytes}','1')", "input=jsonb_set(input,'{sha256}',to_jsonb(repeat('f',64)))"])
      await assert.rejects(db.query(`UPDATE shorts_ingestion SET ${change} WHERE id='older'`), { code: 'SH409' });
    await assert.rejects(db.query("DELETE FROM shorts_ingestion WHERE id='older'"), { code: 'SH409' });
    await assert.rejects(db.query('TRUNCATE shorts_ingestion CASCADE'), { code: 'SH409' });
    workerIdentity = await workerRole(admin, { url: url.href, schema, scope });
    workerDb = new DataSource({ ...options, url: workerIdentity.url }); await workerDb.initialize();
    const worker = new ShortsWorkerRepositoryService(workerDb, { scope, sourceHash }); await worker.verifyRuntime(scope, sourceHash);
    const job = await worker.claim(scope); assert.equal(job.id, 'older');
    assert.equal('source_manifest' in job, false);
    assert.equal(await worker.heartbeat(scope, job), true); assert.equal(await worker.fail(scope, job), true);
    assert.equal((await row('older')).source_manifest, old.manifest);
    await assert.rejects(workerDb.query('SELECT source_manifest FROM shorts_ingestion'), { code: '42501' });
    await assert.rejects(workerDb.query('SELECT shorts_accepted_source_refs($1,$2,$3,$4,$5,$6)', [...args, 'older', creator, old.input, old.manifest]), { code: '42501' });
    await assert.rejects(db.transaction(runner => new Migration().down(runner)), /Preserve accepted source manifests/);
  });
});
