const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { ShortsDirectUploads1792022400000 } = require('../migrations/1792022400000-ShortsDirectUploads');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsUploadRecordsService, SHORTS_PART_BYTES } = require('./shorts-upload-records.service');
const { ShortsSourceService } = require('./shorts-source.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = (bytes = 10) => ({ title: 'My short', topic: 'Art', rights: true, bytes, sha256: hash('source'), details: { language: 'en' } });
const ref = (bytes = 10, sha256 = hash('source')) => ({ key: `private/upload/key1/${sha256}`, keyId: 'key1', bytes, sha256 });

test('shared uploads: atomic admission, immutable parts, frozen input and job acceptance', { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_uploads_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 }, synchronize: false,
    migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsUploadBudget1791763224000, ShortsDirectUploads1792022400000] };
  const first = new DataSource(options), second = new DataSource(options);
  t.after(async () => { if (first.isInitialized) await first.destroy(); if (second.isInitialized) await second.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await first.initialize(); await second.initialize(); await first.runMigrations({ transaction: 'all' });
  const metadataA = new ShortsMetadataService(first), metadataB = new ShortsMetadataService(second);
  const a = new ShortsUploadRecordsService(first, metadataA), b = new ShortsUploadRecordsService(second, metadataB);
  const actor = 'ak_creator';
  async function scope(total = 8, own = 2) {
    const scope = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
    await metadataA.initialize(scope, hash('contract'), total, own);
    await metadataA.configureUploadBudget(scope, { uploads: 500, sourceBytes: 20971520000 }); return scope;
  }
  const accepted = results => results.filter(row => row.status === 'fulfilled');

  await t.test('direct permissions freeze one object and ciphertext per slot across replicas and key rotation', async () => {
    const s = await scope(); await a.create(s, 'direct', actor, input());
    const object = ref(), rotated = { ...object, keyId: 'key2', key: object.key.replace('/key1/', '/key2/') };
    const intents = await Promise.all([a.reserveDirect(s, 'direct', actor, 0, object), b.reserveDirect(s, 'direct', actor, 0, rotated)]);
    assert.deepEqual(intents[0], intents[1]); assert.match(intents[0].iv, /^[a-f0-9]{24}$/);
    assert.equal((await a.get(s, 'direct', actor)).parts.length, 0, 'a permission is not a received part');
    await assert.rejects(b.reserveDirect(s, 'direct', actor, 0, ref(10, hash('different'))), { status: 409 });
    await assert.rejects(b.reserveDirect(s, 'direct', 'ak_other', 0, ref()), { status: 404 });
    await assert.rejects(a.reserveDirect(s, 'direct', actor, 1, ref()), { status: 400 });
    await assert.rejects(a.seal(s, 'direct', actor), { status: 409 });
    const checksums = await Promise.allSettled([a.bindDirectChecksum(s, 'direct', actor, 0, hash('one')), b.bindDirectChecksum(s, 'direct', actor, 0, hash('two'))]);
    assert.equal(accepted(checksums).length, 1);
    assert.equal(checksums.find(row => row.status === 'rejected').reason.status, 409);
    const checksum = accepted(checksums)[0].value.part.checksum;
    assert.equal((await b.bindDirectChecksum(s, 'direct', actor, 0, checksum)).part.checksum, checksum);
    await a.part(s, 'direct', actor, 0, intents[0].object);
    await a.seal(s, 'direct', actor);
    await assert.rejects(b.bindDirectChecksum(s, 'direct', actor, 0, checksum), { status: 409 });
    const [budget] = await first.query('SELECT used_uploads,used_source_bytes FROM shorts_upload_budgets WHERE contract=$1', [s.contract]);
    assert.equal(Number(budget.used_uploads), 1); assert.equal(Number(budget.used_source_bytes), 10);
  });

  await t.test('concurrent creation charges a retry only once and preserves ownership and namespace', async () => {
    const s = await scope();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).create(s, 'same', actor, input())));
    assert.ok(results.every(row => row.id === 'same'));
    const [charges] = await first.query('SELECT count(*)::integer AS n FROM shorts_upload_admission WHERE contract=$1', [s.contract]); assert.equal(charges.n, 1);
    await assert.rejects(b.create(s, 'same', 'ak_someoneElse', input()), { status: 409 });
    await assert.rejects(b.create(s, 'same', actor, { ...input(), title: 'Changed' }), { status: 409 });
    await assert.rejects(b.get(s, 'same', 'ak_someoneElse'), { status: 404 });
    await assert.rejects(b.get({ ...s, network: 'ae_mainnet' }, 'same', actor), { status: 404 });
    assert.equal((await b.get(s, 'same', actor)).input.title, 'My short');
  });
  await t.test('wallet and deployment admission cannot overshoot across independent pools', async () => {
    const s = await scope();
    const wallet = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).create(s, `wallet-${i}`, actor, input())));
    assert.equal(accepted(wallet).length, 10); assert.ok(wallet.filter(r => r.status === 'rejected').every(r => r.reason.status === 429));
    const global = await Promise.allSettled(Array.from({ length: 110 }, (_, i) => (i % 2 ? a : b).create(s, `global-${i}`, `ak_other${i}`, input())));
    assert.equal(accepted(global).length, 90); assert.ok(global.filter(r => r.status === 'rejected').every(r => r.reason.status === 429));
    const [rows] = await first.query('SELECT count(*)::integer AS n FROM shorts_upload_sessions WHERE contract=$1', [s.contract]); assert.equal(rows.n, 100);
  });
  await t.test('first part wins, retries preserve its reference and finish freezes a complete snapshot', async () => {
    const s = await scope(); await a.create(s, 'parts', actor, input(SHORTS_PART_BYTES + 10));
    const results = await Promise.allSettled([a.part(s, 'parts', actor, 0, ref(SHORTS_PART_BYTES, hash('one'))), b.part(s, 'parts', actor, 0, ref(SHORTS_PART_BYTES, hash('two')))]);
    assert.equal(accepted(results).length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    await assert.rejects(b.seal(s, 'parts', actor), { status: 409 });
    await assert.rejects(b.part(s, 'parts', actor, 1, ref(9)), { status: 400 });
    await b.part(s, 'parts', actor, 1, ref(10));
    const snapshot = await a.seal(s, 'parts', actor); assert.equal(snapshot.state, 'sealed'); assert.deepEqual(snapshot.parts.map(p => p.index), [0, 1]);
    const stored = snapshot.parts[0].object;
    const retry = { ...stored, keyId: 'key2', key: stored.key.replace('/key1/', '/key2/') };
    assert.deepEqual(await b.part(s, 'parts', actor, 0, retry), stored);
    await assert.rejects(b.part(s, 'parts', actor, 0, ref(SHORTS_PART_BYTES, hash('different'))), { status: 409 });
    const jobs = await Promise.all([a.enqueue(s, 'parts', actor, ref(100)), b.enqueue(s, 'parts', actor, ref(100))]);
    assert.equal(jobs[0].id, jobs[1].id); assert.equal((await b.get(s, 'parts', actor)).state, 'enqueued');
  });
  await t.test('failed job admission rolls back acceptance; an idempotent retry succeeds without losing parts', async () => {
    const s = await scope(); await a.create(s, 'rollback', actor, input()); await a.part(s, 'rollback', actor, 0, ref()); await a.seal(s, 'rollback', actor);
    const crash = new ShortsUploadRecordsService(first, { enqueue: async (...args) => { await metadataA.enqueue(...args); throw new Error('simulated crash before commit'); } });
    await assert.rejects(crash.enqueue(s, 'rollback', actor, ref(200)), /simulated crash/);
    assert.equal((await b.get(s, 'rollback', actor)).state, 'sealed');
    await assert.rejects(metadataB.getJob(s, actor, 'rollback'), { status: 404 });
    const job = await b.enqueue(s, 'rollback', actor, ref(200)); assert.equal(job.status, 'queued');
    assert.equal((await a.get(s, 'rollback', actor)).parts.length, 1);
  });
  await t.test('queue capacity denial keeps the sealed input retryable and accepted jobs survive session expiry', async () => {
    const s = await scope(1, 1);
    for (const id of ['one', 'two']) { await a.create(s, id, actor, input()); await a.part(s, id, actor, 0, ref()); await a.seal(s, id, actor); }
    await a.enqueue(s, 'one', actor, ref(100));
    await assert.rejects(b.enqueue(s, 'two', actor, ref(100)), { status: 503 });
    assert.equal((await b.get(s, 'two', actor)).state, 'sealed');
    await metadataA.cancel(s, actor, 'one'); await b.enqueue(s, 'two', actor, ref(100));
    await first.query("UPDATE shorts_upload_sessions SET expires_at=clock_timestamp()-interval '1 day' WHERE contract=$1", [s.contract]);
    assert.equal((await a.get(s, 'two', actor)).state, 'enqueued');
    assert.equal((await metadataB.claim(s)).id, 'two');
  });
  await t.test('expiry is checked after row-lock wait, before accepting a late part', async () => {
    const s = await scope(); await a.create(s, 'expires', actor, input());
    await first.query("UPDATE shorts_upload_sessions SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE contract=$1", [s.contract]);
    const lock = first.createQueryRunner(); await lock.connect(); await lock.startTransaction();
    await lock.query('SELECT id FROM shorts_upload_sessions WHERE contract=$1 FOR UPDATE', [s.contract]);
    const pending = assert.rejects(b.part(s, 'expires', actor, 0, ref()), { status: 410 });
    await new Promise(resolve => setTimeout(resolve, 300)); await lock.commitTransaction(); await lock.release(); await pending;
    const [count] = await first.query('SELECT count(*)::integer AS n FROM shorts_upload_parts WHERE contract=$1', [s.contract]); assert.equal(count.n, 0);
  });
  await t.test('an enqueue failure after the object write recovers across API instances and verifies the full private source', { skip: !process.env.SHORTS_TEST_S3_ENDPOINT }, async t => {
    const endpoint = new URL(process.env.SHORTS_TEST_S3_ENDPOINT); assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname));
    const s = await scope();
    const config = { endpoint: endpoint.origin, region: 'us-east-1', bucket: `shorts-source-${randomUUID()}`, prefix: 'quarantine', forcePathStyle: true,
      credentials: { accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY, secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY }, activeKeyId: 'one', keys: { one: randomBytes(32) } };
    const raw = new S3Client({ ...config, requestChecksumCalculation: 'WHEN_REQUIRED' }); await raw.send(new CreateBucketCommand({ Bucket: config.bucket }));
    const objectsA = new ShortsPrivateObjectsService(config), objectsB = new ShortsPrivateObjectsService(config);
    t.after(async () => { objectsA.onModuleDestroy(); objectsB.onModuleDestroy();
      const listed = await raw.send(new ListObjectsV2Command({ Bucket: config.bucket }));
      if (listed.Contents?.length) await raw.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: listed.Contents.map(r => ({ Key: r.Key })) } }));
      await raw.send(new DeleteBucketCommand({ Bucket: config.bucket })); raw.destroy(); });
    const { Test } = require('@nestjs/testing');
    const { Global, Module } = require('@nestjs/common');
    const { ShortsSharedUploadsModule } = require('./shorts-shared-uploads.module');
    const { SHORTS_PRIVATE_OBJECT_CONFIG } = require('./shorts-private-objects.service');
    class DatabaseModule {}
    Global()(DatabaseModule); Module({ providers: [{ provide: DataSource, useValue: first }], exports: [DataSource] })(DatabaseModule);
    const module = await Test.createTestingModule({ imports: [DatabaseModule, ShortsSharedUploadsModule] })
      .overrideProvider(SHORTS_PRIVATE_OBJECT_CONFIG).useValue(config).compile();
    t.after(() => module.close());
    await module.init();
    const sourceA = module.get(ShortsSourceService), sourceB = new ShortsSourceService(b, objectsB, metadataB);
    const source = randomBytes(SHORTS_PART_BYTES + 51), request = { ...input(source.length), sha256: hash(source) };
    await a.create(s, 'source', actor, request);
    await sourceA.part(s, 'source', actor, 0, source.subarray(0, SHORTS_PART_BYTES));
    await sourceB.part(s, 'source', actor, 1, source.subarray(SHORTS_PART_BYTES));
    const crash = new ShortsSourceService({ seal: (...args) => a.seal(...args), enqueue: () => { throw new Error('API died after source object'); } }, objectsA, metadataA);
    await assert.rejects(crash.finish(s, 'source', actor), /API died/);
    assert.equal((await b.get(s, 'source', actor)).state, 'sealed');
    const job = await sourceB.finish(s, 'source', actor); assert.equal(job.status, 'queued');
    assert.deepEqual(await sourceA.read(s, job), source);
    assert.equal((await sourceA.finish(s, 'source', actor)).id, job.id);
    await assert.rejects(sourceB.read(s, { ...job, input: { ...job.input, sha256: hash('tamper') } }), { status: 400 });
    // Each part is valid, but an incorrect whole-video checksum never reaches a decoder.
    await a.create(s, 'wrong-source', actor, { ...input(10), sha256: hash('wrong') });
    await sourceA.part(s, 'wrong-source', actor, 0, Buffer.from('0123456789'));
    const wrong = await sourceB.finish(s, 'wrong-source', actor); await assert.rejects(sourceA.read(s, wrong), { status: 400 });
    // Body/metadata mismatch and cross-wallet access fail before writing an object.
    await assert.rejects(sourceA.part(s, 'source', 'ak_somebody', 0, source.subarray(0, SHORTS_PART_BYTES)), { status: 404 });
    await assert.rejects(sourceA.part(s, 'source', actor, 0, Buffer.from('too-short')), { status: 400 });
  });
});
