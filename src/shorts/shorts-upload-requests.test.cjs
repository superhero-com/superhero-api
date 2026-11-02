require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsUploadRecordsService } = require('./shorts-upload-records.service');
const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
const { ShortsUploadPolicyService, shortsUploadPolicyConfig } = require('./shorts-upload-policy.service');
const { shortsUploadRequest, validateUploadRequest } = require('./shorts-upload-request');
const { ShortsUploadRequests1793232007000: Migration } = require('../migrations/1793232007000-ShortsUploadRequests');
const { releaseFixture } = require('./shorts-release.fixture.cjs');
const { workerRole } = require('./testing/worker-role.cjs');
const sha = createHash('sha256').update('source').digest('hex');
const input = () => ({ requestKey: randomUUID(), title: 'Original', topic: 'Art', rights: true, bytes: 10,
  sha256: sha, details: { language: 'en', description: 'Caption' }, expectedFormat: 'original-file-v1' });

test('creation identity binds public metadata independently of JSON key order and private policy fields', () => {
  const value = input(), request = shortsUploadRequest(value);
  assert.deepEqual(shortsUploadRequest({ ...value, details: { description: 'Caption', language: 'en' }, acceptedMaxBytes: 1, processingProfile: 'caller-value' }), request);
  for (const change of [{ title: 'Different' }, { topic: 'Gaming' }, { bytes: 11 }, { sha256: 'b'.repeat(64) },
    { rights: false }, { expectedFormat: undefined }, { details: { ...value.details, sponsored: true } }]) {
    assert.notEqual(shortsUploadRequest({ ...value, ...change }).hash, request.hash);
  }
  for (const key of ['', 'not-a-uuid', null, [value.requestKey], value.requestKey.toUpperCase(), 'a'.repeat(1000)])
    assert.throws(() => shortsUploadRequest({ ...value, requestKey: key }), { status: 400 });
  assert.throws(() => validateUploadRequest({ key: value.requestKey, hash: [request.hash] }), { status: 400 });
  assert.throws(() => shortsUploadRequest({ ...value, expectedFormat: 'unknown' }), { status: 400 });
  assert.equal(shortsUploadRequest({ ...value, requestKey: undefined }), undefined);
  const defaults = new ShortsUploadPolicyService(shortsUploadPolicyConfig({}));
  assert.equal(defaults.describe({ maxVideoBytes: 100000000 }, true).creation, undefined);
  assert.throws(() => shortsUploadPolicyConfig({ SHORTS_UPLOAD_REQUEST_KEYS_ADVERTISED: 'yes' }));
  const policy = new ShortsUploadPolicyService(shortsUploadPolicyConfig({ SHORTS_UPLOAD_REQUEST_KEYS_ADVERTISED: 'true' }));
  assert.equal(policy.describe({ maxVideoBytes: 100000000 }, true).creation, 'request-key-v1');
  assert.equal(policy.describe({ maxVideoBytes: 100000000 }, false).creation, undefined);
});

test('hosted creation survives lost replies, concurrency, policy rollback and expiry without another upload', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_upload_requests_' + randomUUID().replaceAll('-', '');
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 } };
  let first, second, worker, identity;
  t.after(async () => {
    for (const db of [worker, first, second]) if (db?.isInitialized) await db.destroy();
    if (identity) await identity.dispose();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.destroy();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  first = new DataSource(options); second = new DataSource(options); await first.initialize(); await second.initialize();
  await first.transaction(async manager => {
    for (const name of ['1791763200000-ShortsMetadata','1791763202000-ShortsUploads','1791763203000-ShortsWorkers',
      '1791763204000-ShortsWorkerAuthority','1791763215000-ShortsProcessingCapacity','1791763216000-ShortsRetentionHolds',
      '1791763222000-ShortsWorkerBackpressure','1791763224000-ShortsUploadBudget','1792022400000-ShortsDirectUploads',
      '1793145600000-ShortsOriginalContent','1793145602000-ShortsDeliveryPackages','1793145603000-ShortsDeliveryGenerations',
      '1793145606000-ShortsDeliveryStaging','1793232000000-ShortsOriginalUploads'])
      await new (Object.values(require('../migrations/' + name))[0])().up(manager);
    await new Migration().up(manager);
  });
  await first.transaction(manager => new Migration().down(manager));
  await first.transaction(manager => new Migration().up(manager));
  const { release } = releaseFixture();
  const scope = { network: release.network, contract: release.contract }, actor = 'ak_creator';
  const chain = { release, state: { contract: release.contract }, address() {}, policy: async () => ({ maxVideoBytes: 100000000 }) };
  const metadata = new ShortsMetadataService(first);
  await metadata.initialize(scope, sha, 30, 30);
  await metadata.configureUploadBudget(scope, { uploads: 500, sourceBytes: 20971520000 });
  const a = new ShortsUploadRecordsService(first, metadata), b = new ShortsUploadRecordsService(second, new ShortsMetadataService(second));
  const policy = new ShortsUploadPolicyService({ originals: true, maxOriginalBytes: 100000000 });
  const hosted = (records, currentPolicy = policy, source = { assertDirectUploadsConfigured() {} }) =>
    new ShortsHostedUploadsService({ shared: true, chain }, metadata, records, source, currentPolicy);
  const serviceA = hosted(a), serviceB = hosted(b);
  let saved;

  await t.test('lost commit reply and parallel replica retries charge one admission', async () => {
    const value = input();
    const transaction = first.transaction.bind(first);
    first.transaction = async (...args) => { await transaction(...args); throw new Error('response connection lost'); };
    try { await assert.rejects(serviceA.create(actor, value), /response connection lost/); }
    finally { first.transaction = transaction; }
    const sessions = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? serviceA : serviceB).create(actor, value)));
    assert.ok(sessions.every(s => s.id === sessions[0].id && s.requestKey === value.requestKey));
    const [count] = await first.query('SELECT count(*)::int AS n FROM shorts_upload_admission'); assert.equal(count.n, 1);
    const [budget] = await first.query('SELECT used_uploads,used_source_bytes FROM shorts_upload_budgets');
    assert.equal(Number(budget.used_uploads), 1); assert.equal(Number(budget.used_source_bytes), 10);
    saved = { value, session: sessions[0] };
  });
  await t.test('simultaneous new requests also converge inside the transaction', async () => {
    const value = input();
    const sessions = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? serviceA : serviceB).create(actor, value)));
    assert.equal(new Set(sessions.map(s => s.id)).size, 1);
    const [count] = await first.query('SELECT count(*)::int AS n FROM shorts_upload_requests WHERE request_key=$1', [value.requestKey]); assert.equal(count.n, 1);
  });
  await t.test('metadata conflict and scoped keys preserve deliberate new uploads', async () => {
    for (const change of [{ title: 'Changed' }, { details: { language: 'fr' } }, { sha256: 'b'.repeat(64) }, { expectedFormat: 'legacy-directory-v1' }])
      await assert.rejects(serviceA.create(actor, { ...saved.value, ...change }), { status: 409 });
    const other = await serviceB.create('ak_other', saved.value); assert.notEqual(other.id, saved.session.id);
    const deliberate = await serviceB.create(actor, { ...saved.value, requestKey: randomUUID() }); assert.notEqual(deliberate.id, saved.session.id);
    const otherScope = { ...scope, contract: 'ct_other' }; await metadata.initialize(otherScope, sha, 30, 30);
    assert.equal(await b.getRequest(otherScope, actor, shortsUploadRequest(saved.value)), undefined);
    assert.equal(await b.getRequest({ ...scope, network: 'ae_mainnet' }, actor, shortsUploadRequest(saved.value)), undefined);
  });
  await t.test('restart and disabled or reduced admission preserve the accepted source policy', async () => {
    await second.destroy(); second = new DataSource(options); await second.initialize();
    const restarted = new ShortsUploadRecordsService(second, new ShortsMetadataService(second));
    const disabled = new ShortsUploadPolicyService({ originals: false, maxOriginalBytes: 1 });
    const source = { assertDirectUploadsConfigured() { throw new Error('direct upload configuration unavailable'); } };
    const recovered = await hosted(restarted, disabled, source).create(actor, saved.value);
    assert.equal(recovered.id, saved.session.id); assert.deepEqual(recovered.source, saved.session.source);
    assert.equal(recovered.source.format, 'original-file-v1'); assert.equal(recovered.source.maxBytes, 100000000);
    await assert.rejects(hosted(restarted, disabled, source).create(actor, input()), /configuration unavailable/);
    const reduced = new ShortsUploadPolicyService({ originals: true, maxOriginalBytes: 1 });
    assert.equal((await hosted(restarted, reduced).create(actor, saved.value)).id, saved.session.id);
    await assert.rejects(hosted(restarted, reduced).create(actor, input()), { status: 400 });
  });
  await t.test('expired and cleaned sessions retain an immutable tombstone', async () => {
    await first.query("UPDATE shorts_upload_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [saved.session.id]);
    await assert.rejects(serviceA.create(actor, saved.value), { status: 410 });
    await first.query('DELETE FROM shorts_upload_admission WHERE upload_id=$1', [saved.session.id]);
    await first.query('DELETE FROM shorts_upload_sessions WHERE id=$1', [saved.session.id]);
    await assert.rejects(serviceA.create(actor, saved.value), { status: 410 });
    await assert.rejects(a.create(scope, randomUUID(), actor, policy.accept(saved.value, { maxVideoBytes: 100000000 }), shortsUploadRequest(saved.value)), { status: 410 });
    for (const sql of ["UPDATE shorts_upload_requests SET request_hash=repeat('b',64)", 'DELETE FROM shorts_upload_requests', 'TRUNCATE shorts_upload_requests'])
      await assert.rejects(first.query(sql), /identities are immutable/);
    await assert.rejects(first.query('INSERT INTO shorts_upload_requests(network,contract,creator,request_key,request_hash,upload_id) VALUES($1,$2,$3,$4,$5,$6)',
      [scope.network, scope.contract, actor, randomUUID(), sha, 'missing']), /requires its accepted session/);
    await assert.rejects(first.transaction(manager => new Migration().down(manager)), /Preserve upload request identities/);
  });
  await t.test('an enqueued or cancelled job is recovered without re-enqueueing after upload expiry', async () => {
    const value = input(), session = await serviceA.create(actor, value);
    const object = { key: `private/source/key1/${sha}`, keyId: 'key1', bytes: 10, sha256: sha };
    await a.part(scope, session.id, actor, 0, object); await a.seal(scope, session.id, actor);
    await a.enqueue(scope, session.id, actor, { ...object, bytes: 100 });
    await first.query("UPDATE shorts_upload_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [session.id]);
    const queued = await serviceA.create(actor, value); assert.equal(queued.id, session.id); assert.equal(queued.status, 'queued');
    await metadata.cancel(scope, actor, session.id);
    const cancelled = await serviceA.create(actor, value); assert.equal(cancelled.id, session.id); assert.equal(cancelled.status, 'failed');
    const [jobs] = await first.query('SELECT count(*)::int AS n FROM shorts_ingestion WHERE id=$1', [session.id]); assert.equal(jobs.n, 1);
    const [admission] = await first.query('SELECT count(*)::int AS n FROM shorts_upload_admission WHERE upload_id=$1', [session.id]); assert.equal(admission.n, 1);
  });
  await t.test('failed admission leaves no request identity, session or budget charge', async () => {
    const value = input(), request = shortsUploadRequest(value);
    await first.query('CREATE FUNCTION reject_request_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'request commit failed\'; END $$; CREATE TRIGGER reject_request AFTER INSERT ON shorts_upload_requests FOR EACH ROW EXECUTE FUNCTION reject_request_fixture()');
    const [{ n: before }] = await first.query('SELECT count(*)::int AS n FROM shorts_upload_sessions');
    const [budgetBefore] = await first.query('SELECT used_uploads,used_source_bytes FROM shorts_upload_budgets WHERE contract=$1', [scope.contract]);
    try { await assert.rejects(serviceA.create(actor, value), /request commit failed/); }
    finally { await first.query('DROP TRIGGER reject_request ON shorts_upload_requests; DROP FUNCTION reject_request_fixture()'); }
    const [{ n: after }] = await first.query('SELECT count(*)::int AS n FROM shorts_upload_sessions'); assert.equal(after, before);
    const [budgetAfter] = await first.query('SELECT used_uploads,used_source_bytes FROM shorts_upload_budgets WHERE contract=$1', [scope.contract]); assert.deepEqual(budgetAfter, budgetBefore);
    assert.equal(await a.getRequest(scope, actor, request), undefined);
    assert.equal((await serviceA.create(actor, value)).requestKey, value.requestKey);
  });
  await t.test('media worker cannot read or mutate the request ledger', async () => {
    identity = await workerRole(admin, { url: url.href, schema, scope });
    worker = new DataSource({ ...options, url: identity.url }); await worker.initialize();
    for (const sql of ['SELECT * FROM shorts_upload_requests', 'DELETE FROM shorts_upload_requests', 'TRUNCATE shorts_upload_requests'])
      await assert.rejects(worker.query(sql), /permission denied/);
  });
});
