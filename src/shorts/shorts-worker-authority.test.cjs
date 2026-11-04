const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsWorkerBackpressure1791763222000 } = require('../migrations/1791763222000-ShortsWorkerBackpressure');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsWorkerRepositoryService } = require('./shorts-worker-repository.service');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsWorkers1791763203000 } = require('../migrations/1791763203000-ShortsWorkers');
const { ShortsWorkerAuthority1791763204000 } = require('../migrations/1791763204000-ShortsWorkerAuthority');
const { workerRole } = require('./testing/worker-role.cjs');
const { ShortsLifecycle1791763213000 } = require('../migrations/1791763213000-ShortsLifecycle');

test('media worker database authority survives direct SQL and forged RPC requests', { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 45000 }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = `shorts_authority_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 1 },
    migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsWorkers1791763203000, ShortsWorkerAuthority1791763204000] };
  const owner = new DataSource(options); await owner.initialize(); await owner.runMigrations({ transaction: 'all' });
  // Keep the authority rollback test focused while exercising the later content trigger.
  await new ShortsLifecycle1791763213000().up(owner);
  await new (require('../migrations/1791763215000-ShortsProcessingCapacity').ShortsProcessingCapacity1791763215000)().up(owner);
  await new ShortsWorkerBackpressure1791763222000().up(owner);
  await owner.transaction(manager => new ShortsUploadBudget1791763224000().up(manager));
  const metadata = new ShortsMetadataService(owner), hash = 'a'.repeat(64);
  const scope = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
  const otherScope = { ...scope, contract: `ct_${randomUUID().replaceAll('-', '')}` };
  await metadata.initialize(scope, hash); await metadata.initialize(otherScope, hash);
  const identities = [], connections = [];
  t.after(async () => {
    for (const db of connections) await db.destroy(); await owner.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    for (const identity of identities) await identity.dispose();
    await admin.destroy();
  });
  async function worker(deployment = scope) {
    const identity = await workerRole(admin, { url: url.href, schema, scope: deployment }); identities.push(identity);
    const db = new DataSource({ ...options, migrations: [], url: identity.url }); await db.initialize(); connections.push(db);
    return { ...identity, db, repo: new ShortsWorkerRepositoryService(db, { scope: deployment, sourceHash: hash, leaseMs: 120000 }) };
  }
  const a = await worker(), b = await worker(), foreign = await worker(otherScope);
  let number = 0;
  function input(id) {
    const key = `shorts-private-v1/${hash}/${id}/source-manifest/key1/${hash}`;
    return { objectKey: key, manifest: { key, keyId: 'key1', bytes: 100, sha256: hash }, sha256: hash, bytes: 100,
      title: 'Original title', topic: 'Art', details: { description: 'Owned fixture', language: 'en' } };
  }
  async function enqueue(deployment = scope) {
    const id = `job${number++}`; await metadata.enqueue(deployment, id, 'ak_creator', input(id)); return id;
  }
  async function claimed(w = a) { await enqueue(); return w.repo.claim(scope); }
  function record(job) {
    const files = ['video.mp4', 'poster.jpg', 'manifest.json'].map(name => ({ name, bytes: 100, sha256: hash }));
    return { id: job.id, creator: job.creator, title: 'Worker altered title', topic: 'Gaming', cid: 'bafy' + 'a'.repeat(50),
      bytes: 300, duration: 3, createdAt: 0, files, moderation: 'pending', reports: 99, views: [999],
      safety: { status: 'no_flags', sourceSha256: hash }, privateMedia: { version: 1, fence: job.fence, source: structuredClone(job.input),
        files: Object.fromEntries(files.map(file => [file.name, { bytes: file.bytes, sha256: file.sha256, keyId: 'key1',
          key: `shorts-private-v1/${hash}/${job.id}/attempt/${job.fence}/${file.name.replaceAll('.', '-')}/key1/${hash}` }])) } };
  }
  const raw = (w, action, data = {}, deployment = scope) => w.db.query('SELECT shorts_media_worker($1,$2::jsonb) AS result',
    [action, JSON.stringify({ ...data, ...deployment, sourceHash: hash })]);

  await t.test('restricted logins can verify only their enrolled deployment and cannot read or mutate application tables', async () => {
    await a.repo.verifyRuntime(scope, hash);
    await assert.rejects(a.repo.verifyRuntime(otherScope, hash), { status: 403 });
    await assert.rejects(new ShortsWorkerRepositoryService(a.db, { sourceHash: 'b'.repeat(64) }).verifyRuntime(scope, 'b'.repeat(64)), { status: 403 });
    for (const sql of [
      'SELECT * FROM shorts_content', 'SELECT * FROM shorts_ingestion', 'SELECT * FROM shorts_worker_principals',
      'SELECT * FROM shorts_runtime', 'SELECT * FROM shorts_lifecycle_jobs',
      "UPDATE shorts_lifecycle_jobs SET lease_token=NULL", "UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"approved\"')",
      'DELETE FROM shorts_ingestion', "INSERT INTO shorts_content VALUES ('ae_uat','ct_bad','fake','ak_forged',0,1,'{}')",
      'TRUNCATE shorts_content CASCADE', 'CREATE TABLE arbitrary(data text)',
    ]) await assert.rejects(a.db.query(sql), { code: '42501' }, sql);
    await assert.rejects(raw(a, 'approve'), { code: 'SH400' });
    await assert.rejects(a.db.query(`SET ROLE ${url.username}`), { code: '42501' });
  });
  await t.test('PUBLIC cannot execute the function and temporary objects do not shadow its relations', async () => {
    const [{ publicExecute }] = await owner.query(`SELECT EXISTS(SELECT FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      WHERE p.oid='${schema}.shorts_media_worker(text,jsonb)'::regprocedure AND x.grantee=0 AND x.privilege_type='EXECUTE') AS "publicExecute"`);
    assert.equal(publicExecute, false);
    await a.db.query('CREATE TEMP TABLE shorts_worker_principals(role_oid oid, enabled boolean)');
    await a.db.query('CREATE TEMP TABLE shorts_ingestion(id text)');
    await a.repo.verifyRuntime(scope, hash);
    const job = await claimed(); assert.equal(await a.repo.fail(scope, job), true);
    await a.db.query('DROP TABLE pg_temp.shorts_worker_principals, pg_temp.shorts_ingestion');
  });
  await t.test('accidental grants, role membership and disabled or replaced enrollment fail closed', async () => {
    await owner.query(`GRANT SELECT ON shorts_content TO ${a.role}`);
    await assert.rejects(a.repo.verifyRuntime(scope, hash), { status: 403 });
    await owner.query(`REVOKE SELECT ON shorts_content FROM ${a.role}`);
    await admin.query(`GRANT ${b.role} TO ${a.role}`);
    await assert.rejects(a.repo.verifyRuntime(scope, hash), { status: 403 });
    await admin.query(`REVOKE ${b.role} FROM ${a.role}`);
    await owner.query('UPDATE shorts_worker_principals SET enabled=false WHERE role_name=$1', [a.role]);
    await assert.rejects(a.repo.claim(scope), { status: 403 });
    await owner.query('UPDATE shorts_worker_principals SET enabled=true,role_name=$2 WHERE role_name=$1', [a.role, 'replaced_login']);
    await assert.rejects(a.repo.verifyRuntime(scope, hash), { status: 403 });
    await owner.query('UPDATE shorts_worker_principals SET role_name=$1 WHERE role_name=$2', [a.role, 'replaced_login']);
    await a.repo.verifyRuntime(scope, hash);
  });
  await t.test('the lease belongs to its login, scope and current fence, even with a leaked token', async () => {
    const job = await claimed();
    assert.equal(await b.repo.heartbeat(scope, job), false); assert.equal(await b.repo.fail(scope, job), false);
    await assert.rejects(b.repo.complete(scope, job, record(job)), { status: 409 });
    await assert.rejects(foreign.repo.complete(scope, job, record(job)), { status: 403 });
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    const recovered = await b.repo.claim(scope); assert.equal(recovered.id, job.id); assert.equal(recovered.fence, '2');
    assert.equal(await a.repo.heartbeat(scope, job), false);
    await assert.rejects(a.repo.complete(scope, job, record(job)), { status: 409 });
    assert.equal(await b.repo.fail(scope, recovered), true);
    const foreignId = await enqueue(otherScope); assert.equal((await foreign.repo.claim(otherScope)).id, foreignId);
    assert.equal(await a.repo.claim(scope), undefined);
  });
  await t.test('forged approval, publication, source, output paths and package inconsistencies are rejected atomically', async () => {
    const job = await claimed();
    const mutations = [
      r => { r.moderation = 'approved'; }, r => { r.publication = 'published'; }, r => { r.creator = 'ak_other'; },
      r => { r.privateMedia.fence = '99'; }, r => { r.privateMedia.source.bytes = 50; },
      r => { r.privateMedia.files['video.mp4'].key = r.privateMedia.files['video.mp4'].key.replace('/attempt/1/', '/attempt/99/'); },
      r => { r.privateMedia.files['video.mp4'].sha256 = 'b'.repeat(64); }, r => { r.files[1].name = 'video.mp4'; },
      r => { r.bytes = 999; }, r => { r.bytes = '300'; }, r => { r.duration = null; }, r => { r.duration = 999999; }, r => { r.safety = null; },
      r => { r.privateMedia.version = '1'; }, r => { r.files[0].bytes = '100'; },
      r => { r.privateMedia.files.extra = r.privateMedia.files['video.mp4']; },
    ];
    for (const mutation of mutations) {
      const candidate = record(job); mutation(candidate);
      await assert.rejects(raw(a, 'complete', { ...job, record: candidate }), { code: 'SH400' });
      await assert.rejects(metadata.get(scope, job.id), { status: 404 });
      assert.equal((await metadata.getJob(scope, job.creator, job.id)).status, 'processing');
    }
    const outcome = await a.repo.complete(scope, job, record(job));
    assert.equal(outcome.record.moderation, 'pending'); assert.equal(outcome.record.publication, undefined);
    assert.equal(outcome.record.title, 'Original title'); assert.equal(outcome.record.topic, 'Art');
    assert.equal(outcome.record.reports, 0); assert.deepEqual(outcome.record.views, []); assert.ok(outcome.record.createdAt > 0);
    const [scheduled] = await owner.query('SELECT generation,lease_token FROM shorts_lifecycle_jobs WHERE network=$1 AND contract=$2 AND id=$3', [scope.network, scope.contract, job.id]);
    assert.equal(scheduled.generation, '1'); assert.equal(scheduled.lease_token, null);
    await assert.rejects(a.repo.complete(scope, job, record(job)), { status: 409 });
    await metadata.change(scope, job.id, r => { r.moderation = 'approved'; });
    await assert.rejects(raw(a, 'complete', { ...job, record: record(job) }), { code: 'SH409' });
    assert.equal((await metadata.get(scope, job.id)).record.moderation, 'approved');
  });
  await t.test('competing workers claim different jobs and cannot turn a blocked result into approval', async () => {
    const ids = [await enqueue(), await enqueue()];
    let [one, two] = await Promise.all([a.repo.claim(scope), b.repo.claim(scope)]);
    if (!one) one = await a.repo.claim(scope);
    if (!two) two = await b.repo.claim(scope);
    assert.deepEqual(new Set([one.id, two.id]), new Set(ids));
    const blocked = record(one); blocked.safety.status = 'blocked'; blocked.moderation = 'pending';
    assert.equal((await a.repo.complete(scope, one, blocked)).record.moderation, 'rejected');
    assert.equal((await b.repo.complete(scope, two, record(two))).record.moderation, 'pending');
  });
  await t.test('expiry is checked after row-lock waits and an exhausted killed lease cannot restart', async () => {
    const job = await claimed();
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [job.id]);
    const runner = owner.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    await runner.query('SELECT id FROM shorts_ingestion WHERE id=$1 FOR UPDATE', [job.id]);
    // Observe rejection immediately, including when the lease expires before
    // this runner releases its lock under a busy test process.
    const pending = a.repo.complete(scope, job, record(job)).then(() => null, error => error);
    await new Promise(resolve => setTimeout(resolve, 1100)); await runner.commitTransaction(); await runner.release();
    assert.equal((await pending)?.status, 409); await assert.rejects(metadata.get(scope, job.id), { status: 404 });
    const attempt2 = await b.repo.claim(scope); assert.equal(attempt2.attempts, 2);
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    const attempt3 = await a.repo.claim(scope); assert.equal(attempt3.attempts, 3);
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    assert.equal(await b.repo.claim(scope), undefined);
    assert.equal((await metadata.getJob(scope, job.creator, job.id)).errorCode, 'attempts_exhausted');
  });
  await t.test('heartbeats cannot impersonate another login and enrollment revocation blocks active completion', async () => {
    const id = randomUUID(); await a.repo.workerPulse(scope, id);
    await assert.rejects(b.repo.workerPulse(scope, id), { status: 409 });
    await b.repo.workerStop(scope, id); assert.equal(await metadata.workerCount(scope), 1);
    await a.repo.workerStop(scope, id); assert.equal(await metadata.workerCount(scope), 0);
    const job = await claimed();
    await owner.query('UPDATE shorts_worker_principals SET enabled=false WHERE role_name=$1', [a.role]);
    await assert.rejects(a.repo.complete(scope, job, record(job)), { status: 403 });
    await assert.rejects(a.repo.heartbeat(scope, job), { status: 403 });
    await owner.query('UPDATE shorts_worker_principals SET enabled=true WHERE role_name=$1', [a.role]);
    assert.equal(await a.repo.fail(scope, job), true);
  });
  await t.test('rolling the authority migration back preserves content and requires fresh enrollment after reapplying', async () => {
    const before = await owner.query('SELECT id,body FROM shorts_content ORDER BY id');
    await owner.undoLastMigration({ transaction: 'all' });
    assert.deepEqual(await owner.query('SELECT id,body FROM shorts_content ORDER BY id'), before);
    await assert.rejects(raw(a, 'verify'), { code: '42883' });
    await owner.runMigrations({ transaction: 'all' });
    await assert.rejects(raw(a, 'verify'), { code: '42501' });
    assert.deepEqual(await owner.query('SELECT id,body FROM shorts_content ORDER BY id'), before);
    assert.deepEqual(await owner.query('SELECT * FROM shorts_worker_principals'), []);
  });
});
