const { ShortsMediaAdmission1791763225000 } = require('../migrations/1791763225000-ShortsMediaAdmission');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { ShortsLifecycle1791763213000 } = require('../migrations/1791763213000-ShortsLifecycle');
const { ShortsLifecycleJobsService } = require('./shorts-lifecycle-jobs.service');
const { ShortsHostedHostingService } = require('./shorts-hosted-hosting.service');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DataSource } = require('typeorm');
const { NestFactory } = require('@nestjs/core');
const { Module, Global } = require('@nestjs/common');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsMetadataModule } = require('./shorts-metadata.module');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsSharedCutover1791763214000 } = require('../migrations/1791763214000-ShortsSharedCutover');
const { ShortsProcessingCapacity1791763215000 } = require('../migrations/1791763215000-ShortsProcessingCapacity');

test('shared Shorts metadata: real PostgreSQL isolation, competing workers and crash recovery', { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 45000 }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an isolated local test database');
  const schema = `shorts_metadata_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema,
    extra: { options: `-c search_path=${schema}`, max: 8 }, synchronize: false,
    migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsLifecycle1791763213000, ShortsSharedCutover1791763214000, ShortsProcessingCapacity1791763215000, ShortsUploadBudget1791763224000, ShortsMediaAdmission1791763225000] };
  const first = new DataSource(options), second = new DataSource(options);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await second.destroy(); await first.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy();
  });
  await first.initialize(); await second.initialize(); await first.runMigrations({ transaction: 'all' });
  class DatabaseModule {}
  Global()(DatabaseModule); Module({ providers: [{ provide: DataSource, useValue: first }], exports: [DataSource] })(DatabaseModule);
  class TestModule {}
  Module({ imports: [DatabaseModule, ShortsMetadataModule] })(TestModule);
  app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  const a = app.get(ShortsMetadataService), b = new ShortsMetadataService(second);
  const hash = 'a'.repeat(64);
  const input = (id = 'input') => ({ objectKey: `originals/${id}`, sha256: hash, bytes: 100,
    title: 'Owned clip', topic: 'Art', details: { language: 'en' } });
  const record = (job, createdAt = 100) => ({ id: job.id, creator: job.creator, cid: `bafy${job.id}`,
    bytes: 200, duration: 10, createdAt, title: 'Owned clip', topic: 'Art', moderation: 'pending',
    files: [{ name: 'video.mp4', bytes: 200, sha256: hash }], reports: 0, views: [] });
  async function scope(max = 20, own = 10) {
    const scope = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
    await a.initialize(scope, hash, max, own); return scope;
  }
  const accepted = results => results.filter(result => result.status === 'fulfilled');
  // Large bursts deliberately exceed the SQL pool. Only a pre-execution
  // admission refusal is safe to retry here; ambiguous transaction failures are not.
  async function admittedBurst(operations) {
    const results = await Promise.allSettled(operations.map(run => run()));
    const values = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') values.push(result.value);
      else {
        assert.equal(result.reason.status, 503);
        assert.equal(result.reason.message, 'Shorts database is busy; retry shortly');
        values.push(await operations[i]());
      }
    }
    return values;
  }


  await t.test('content adapters read and change identical IDs only in their release network', async () => {
    const { ShortsRecordsService } = require('./shorts-records.service');
    const one = await scope(), two = { ...one, network: 'ae_mainnet' };
    await b.initialize(two, hash);
    const id = randomUUID(), row = record({ id, creator: 'ak_creator' });
    await a.insertDraft(one, { ...row, title: 'Testnet content' });
    await b.insertDraft(two, { ...row, title: 'Mainnet content' });
    const adapter = (deployment, metadata) => new ShortsRecordsService({ release: { ...deployment }, state: { ...deployment, sourceHash: hash, shorts: [] } }, metadata);
    const testRecords = adapter(one, a), mainRecords = adapter(two, b);
    assert.equal((await testRecords.get(id)).title, 'Testnet content');
    assert.equal((await mainRecords.get(id)).title, 'Mainnet content');
    await mainRecords.change(id, value => { value.title = 'Mainnet edited'; });
    assert.equal((await testRecords.get(id)).title, 'Testnet content');
    assert.equal((await mainRecords.get(id)).title, 'Mainnet edited');
  });

  await t.test('legacy import is explicit, atomic and never restores stale approval over shared decisions', async () => {
    const { createHash } = require('node:crypto');
    const { ShortsRecordsService } = require('./shorts-records.service');
    const s = await scope(8, 2);
    const legacy = [{ ...record({ id: 'legacy', creator: 'ak_creator' }), moderation: 'approved', publication: 'published', safety: { status: 'no_flags' } }];
    const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const chain = { release: { network: 'ae_uat', contract: s.contract }, state: { contract: s.contract, sourceHash: hash, shorts: legacy } };
    const records = new ShortsRecordsService(chain, a);
    const previous = process.env.SHORTS_IMPORT_LEGACY_CONTENT;
    delete process.env.SHORTS_IMPORT_LEGACY_CONTENT;
    try {
      await assert.rejects(records.onModuleInit(), { status: 409 });
      assert.equal((await a.page(s)).items.length, 0);
      await assert.rejects(a.importLegacy(s, [...legacy, { ...legacy[0], id: 'invalid', creator: 'bad' }], fingerprint(legacy), true), { status: 400 });
      assert.equal((await a.page(s)).items.length, 0, 'a failed import rolls back earlier rows');
      await a.importLegacy(s, legacy, fingerprint(legacy), true);
      await b.change(s, 'legacy', value => { value.moderation = 'rejected'; });
      await a.importLegacy(s, legacy, fingerprint(legacy), true);
      assert.equal((await records.get('legacy')).moderation, 'rejected');
      assert.equal(chain.state.shorts[0].moderation, 'approved', 'the old local snapshot is not used as live metadata');
      process.env.SHORTS_IMPORT_LEGACY_CONTENT = '1';
      chain.state.shorts.push({ ...legacy[0], id: 'unexpected' });
      await assert.rejects(a.importLegacy(s, chain.state.shorts, fingerprint(chain.state.shorts), true), { status: 409 });
      assert.equal((await records.reviewPage()).items.length, 1);
      const nonempty = await scope();
      await a.insertDraft(nonempty, record({ id: 'fresh', creator: 'ak_creator' }));
      await assert.rejects(a.importLegacy(nonempty, legacy, fingerprint(legacy), true), { status: 409 });
    } finally {
      if (previous === undefined) delete process.env.SHORTS_IMPORT_LEGACY_CONTENT; else process.env.SHORTS_IMPORT_LEGACY_CONTENT = previous;
    }
  });

  await t.test('draft registration is bounded across connections and retries cannot replace current metadata', async () => {
    const s = await scope();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? a : b).insertDraft(s, record({ id: `draft${i}`, creator: 'ak_creator' }), 2)));
    assert.equal(accepted(results).length, 2);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 503));
    const draft = accepted(results)[0].value.record;
    await b.change(s, draft.id, current => { current.moderation = 'rejected'; current.reports = 3; });
    const retry = await a.insertDraft(s, draft, 2);
    assert.equal(retry.record.moderation, 'rejected'); assert.equal(retry.record.reports, 3);
    await assert.rejects(a.insertDraft(s, { ...draft, cid: 'different' }), { status: 409 });
    await assert.rejects(a.insertDraft(s, { ...draft, id: 'approved', moderation: 'approved' }), { status: 400 });
  });

  async function runtime() {
    const { ShortsRecordsService } = require('./shorts-records.service');
    const { ShortsService } = require('./shorts.service');
    const s = await scope(8, 2), effects = [], published = new Map();
    const chain = { release: { network: 'ae_uat', contract: s.contract }, state: { contract: s.contract, sourceHash: hash, shorts: [] }, address: value => value,
      operator: { address: 'ak_operator' }, read: async (method, [id]) => method === 'has_liked' ? false : published.get(id),
      write: async () => assert.fail('Hosted metadata cannot sign publications') };
    const one = new ShortsRecordsService(chain, a), two = new ShortsRecordsService({ ...chain, state: structuredClone(chain.state) }, b);
    await one.onModuleInit(); await two.onModuleInit();
    const media = { pin: async () => effects.push('pin'), ensurePinned: async () => media.pin() };
    // The restricted publisher's queue and signatures have their own integration suite.
    // These metadata tests simulate an immediately confirmed publisher response.
    const publisher = {
      async capacity() { return true; },
      async enqueue(id) { const item = await one.get(id); effects.push('admit'); published.set(id, { creator: item.creator, cid: item.cid, size: BigInt(item.bytes), likes: 0n, withdrawn: false }); },
      async status(id) { return published.has(id) ? { status: 'confirmed' } : undefined; },
    };
    const service = records => new ShortsService(chain, media, { counters: () => ({ views: 0 }) }, {}, {}, {}, { enqueue: () => effects.push('enqueue') }, {}, records, publisher);
    const firstService = service(one), secondService = service(two);
    await one.register({ ...record({ id: 'clip', creator: 'ak_creator' }), safety: { status: 'no_flags' } });
    await firstService.moderate('clip', true);
    const hosting = new ShortsHostedHostingService(chain, media, firstService, one, new ShortsLifecycleJobsService(first));
    const recover = async () => { await hosting.reconcile(); return firstService.publication('ak_creator', 'clip'); };
    return { scope: s, one, two, firstService, secondService, chain, media, effects, published, recover };
  }

  await t.test('hosted content changes, ownership and publication work without a local registry snapshot', async () => {
    const f = await runtime();
    assert.equal(f.one.shared, true); assert.equal(f.chain.state.shorts.length, 0);
    assert.equal((await f.two.page('ak_other')).items.length, 0);
    await assert.rejects(f.secondService.publish('ak_other', 'clip'), /Only the creator/);
    await f.firstService.publish('ak_creator', 'clip'); await f.recover();
    assert.equal((await f.secondService.shared('clip')).status, 'active');
    assert.equal((await f.secondService.catalog()).items.length, 1);
    await f.secondService.moderate('clip', false, 'Restricted by a newer decision');
    await assert.rejects(f.firstService.playbackDescriptor('clip'), { status: 404 });
    assert.deepEqual((await f.firstService.catalog()).items, []);
    assert.equal((await f.firstService.catalog('ak_creator', undefined, true)).items.length, 1);
    await f.secondService.moderate('clip', true);
    f.published.get('clip').cid = 'different';
    assert.deepEqual((await f.firstService.catalog()).items, [], 'the feed checks on-chain media identity');
    await assert.rejects(f.firstService.publish('ak_creator', 'clip'), { status: 409 });
  });

  await t.test('a shared revocation during pinning, chain reads or like reads prevents publication and discovery', async () => {
    const f = await runtime();
    f.media.pin = async () => { await f.secondService.moderate('clip', false); };
    await f.firstService.publish('ak_creator', 'clip'); await f.recover();
    assert.equal(f.effects.includes('admit'), false);
    await f.secondService.moderate('clip', true);
    f.media.pin = async () => {}; await f.firstService.publish('ak_creator', 'clip'); await f.recover();
    const original = f.chain.read;
    f.chain.read = async (...args) => { await f.secondService.moderate('clip', false); return original(...args); };
    await assert.rejects(f.firstService.playbackDescriptor('clip'), { status: 404 });
    f.chain.read = original; await f.secondService.moderate('clip', true);
    f.chain.read = async (...args) => { if (args[0] === 'has_liked') await f.secondService.moderate('clip', false); return original(...args); };
    assert.deepEqual((await f.firstService.catalog('ak_viewer')).items, []);
    await f.secondService.moderate('clip', true);
    await assert.rejects(f.firstService.shared('clip', 'ak_viewer'), { status: 404 });
  });

  await t.test('overlapping scans and review decisions fence older inspection responses', async () => {
    const f = await runtime();
    const waiting = [];
    f.media.rescan = () => new Promise(resolve => waiting.push(resolve));
    const waitFor = async n => { for (let i = 0; i < 100 && waiting.length < n; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(waiting.length, n); };
    const old = f.firstService.rescan('clip'); await waitFor(1);
    const newer = f.secondService.rescan('clip'); await waitFor(2);
    waiting[1]({ status: 'blocked', evidenceHash: 'newer' }); await newer;
    const stale = assert.rejects(old, { status: 409 }); waiting[0]({ status: 'no_flags', evidenceHash: 'old' }); await stale;
    assert.equal((await f.one.get('clip')).safety.evidenceHash, 'newer');
    const third = f.firstService.rescan('clip'); await waitFor(3);
    await f.secondService.moderate('clip', false, 'Urgent decision while scanning');
    const revoked = assert.rejects(third, { status: 409 }); waiting[2]({ status: 'no_flags' }); await revoked;
    assert.equal((await f.one.get('clip')).moderation, 'rejected');
  });

  await t.test('reports and appeals update the shared record without losing concurrent changes', async () => {
    const f = await runtime(), reports = Array.from({ length: 12 }, () => ({ id: randomUUID(), reason: 'Safety' }));
    await admittedBurst(reports.flatMap((report, i) => [
      () => (i % 2 ? f.firstService : f.secondService).report('clip', report), () => f.secondService.report('clip', report)]));
    assert.equal((await f.one.get('clip')).reports, 12);
    await f.firstService.moderate('clip', false);
    await assert.rejects(f.firstService.appeal('ak_other', 'clip', 'Please reconsider my clip'), /Only the creator/);
    const result = await Promise.allSettled([f.firstService, f.secondService].map(service => service.appeal('ak_creator', 'clip', 'Please reconsider my clip')));
    assert.equal(accepted(result).length, 1);
    assert.equal((await f.two.get('clip')).appeal.status, 'pending');
    await f.secondService.moderate('clip', true);
    assert.equal((await f.one.get('clip')).appeal.status, 'resolved');
    assert.equal((await f.one.get('clip')).reports, 12);
  });

  await t.test('hosted upload status recovers a committed draft from another connection without preparation', async () => {
    const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
    const f = await runtime();
    const job = await a.enqueue(f.scope, 'recovered', 'ak_creator', input());
    const claimed = await a.claim(f.scope);
    await a.complete(f.scope, claimed, record(job));
    // The worker committed, but the HTTP caller never received its acknowledgement.
    const uploads = new ShortsHostedUploadsService(f.two, b, {
      get: async (scope, id, creator) => {
        assert.deepEqual(scope, f.scope); assert.equal(id, job.id);
        return { id, creator, state: 'enqueued', parts: [], expiresAt: 0 };
      },
    }, { finish: async () => assert.fail('Polling a committed upload must not prepare it again') });
    const result = await uploads.get(job.creator, job.id);
    assert.equal(result.status, 'ready'); assert.equal(result.complete, true);
    assert.equal(result.video.id, job.id); assert.equal(f.chain.state.shorts.length, 0);
    assert.equal((await f.one.get(job.id)).publication, undefined);
    await assert.rejects(uploads.get('ak_other', job.id), { status: 404 });
  });

  await t.test('deployment identities and admission limits cannot silently cross or diverge', async () => {
    const s = await scope();
    await b.initialize(s, hash, 20, 10);
    await assert.rejects(b.initialize(s, 'b'.repeat(64), 20, 10), { status: 409 });
    await assert.rejects(b.initialize(s, hash, 30, 10), { status: 409 });
    await assert.rejects(a.initialize(s, hash, NaN, 1), { status: 400 });
    const other = { ...s, network: 'ae_mainnet' };
    await a.initialize(other, hash);
    await a.enqueue(s, 'same', 'ak_creator', input());
    await assert.rejects(b.getJob(other, 'ak_creator', 'same'), { status: 404 });
    await assert.rejects(b.getJob(s, 'ak_other', 'same'), { status: 404 });
    await assert.rejects(a.enqueue(s, 'invalid', 'ak_creator', { ...input(), objectKey: '../private/key' }), { status: 400 });
    await assert.rejects(a.enqueue(s, 'invalid', 'ak_creator', { ...input(), objectKey: 'https://untrusted.invalid/source' }), { status: 400 });
  });
  await t.test('concurrent duplicate admission returns one immutable job even when capacity is full', async () => {
    const s = await scope(1, 1);
    const jobs = await admittedBurst(Array.from({ length: 16 }, (_, i) => () => (i % 2 ? a : b).enqueue(s, 'one', 'ak_creator', input())));
    assert.ok(jobs.every(job => job.id === 'one' && job.attempts === 0));
    assert.equal((await a.health(s)).counts.queued, 1);
    await b.enqueue(s, 'one', 'ak_creator', { ...input(), details: { language: 'en' } });
    await assert.rejects(a.enqueue(s, 'one', 'ak_other', input()), { status: 409 });
    await assert.rejects(a.enqueue(s, 'one', 'ak_creator', { ...input(), sha256: 'b'.repeat(64) }), { status: 409 });
    await assert.rejects(a.enqueue(s, 'two', 'ak_creator', input()), { status: 503 });
  });
  await t.test('global and creator admission remain bounded across independent connection pools', async () => {
    const s = await scope(4, 2);
    let results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).enqueue(s, `own${i}`, 'ak_creator', input())));
    assert.equal(accepted(results).length, 2);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 503));
    results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).enqueue(s, `others${i}`, `ak_creator${i}`, input())));
    assert.equal(accepted(results).length, 2);
    assert.equal((await b.health(s)).counts.queued, 4);
    const claims = (await admittedBurst(Array.from({ length: 10 }, (_, i) => () => (i % 2 ? a : b).claim(s)))).filter(Boolean);
    assert.ok(claims.length > 0 && claims.length <= 2);
    while (claims.length < 2) claims.push(await a.claim(s));
    assert.equal(new Set(claims.map(c => c.id)).size, 2);
    assert.ok(claims.every(c => c.attempts === 1 && c.fence === '1'));
    assert.equal((await a.health(s)).counts.processing, 2);
    assert.equal((await a.health(s)).counts.queued, 2);
    await assert.rejects(a.enqueue(s, 'overflow', 'ak_new', input()), { status: 503 });
  });
  await t.test('one locked job cannot block another worker from claiming unrelated work', async () => {
    const s = await scope();
    await a.enqueue(s, 'first', 'ak_creator', input());
    await a.enqueue(s, 'second', 'ak_creator', input());
    const runner = first.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    try {
      await runner.query('SELECT id FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE', [s.network, s.contract, 'first']);
      const next = await b.claim(s);
      assert.equal(next.id, 'second');
    } finally { await runner.rollbackTransaction(); await runner.release(); }
  });
  await t.test('lease expiry fences the old worker from heartbeats, failures and content commits', async () => {
    const s = await scope(); await a.enqueue(s, 'owned', 'ak_creator', input());
    const stale = await a.claim(s);
    assert.equal(await b.heartbeat(s, { ...stale, leaseToken: randomUUID() }), false);
    assert.equal(await b.heartbeat(s, stale), true);
    await first.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE network=$1 AND contract=$2", [s.network, s.contract]);
    assert.equal(await a.heartbeat(s, stale), false);
    const current = await b.claim(s); assert.equal(current.fence, '2'); assert.equal(current.attempts, 2);
    assert.notEqual(current.leaseToken, stale.leaseToken);
    await assert.rejects(a.complete(s, stale, record(stale)), { status: 409 });
    assert.equal(await a.fail(s, stale), false);
    await assert.rejects(a.complete(s, current, { ...record(current), moderation: 'approved' }), { status: 409 });
    await assert.rejects(a.complete(s, current, { ...record(current), publication: 'published' }), { status: 409 });
    await b.complete(s, current, record(current));
    assert.equal((await a.getJob(s, 'ak_creator', current.id)).status, 'ready');
    assert.equal((await a.get(s, current.id)).revision, '1');
    await assert.rejects(a.complete(s, current, record(current)), { status: 409 });
    assert.equal(await a.claim(s), undefined);
    assert.equal((await a.page(s)).items.length, 1);
  });
  await t.test('a lease expiring during the completion transaction leaves neither a partial record nor a false success', async () => {
    const s = await scope(); await a.enqueue(s, 'slow', 'ak_creator', input());
    await first.query(`CREATE FUNCTION slow_content_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(1.2); RETURN NEW; END; $$`);
    await first.query('CREATE TRIGGER slow_content_test BEFORE INSERT ON shorts_content FOR EACH ROW EXECUTE FUNCTION slow_content_test()');
    try {
      const job = await a.claim(s, 1000);
      await assert.rejects(b.complete(s, job, record(job)), { status: 409 });
      await assert.rejects(a.get(s, 'slow'), { status: 404 });
      assert.equal((await a.getJob(s, 'ak_creator', 'slow')).status, 'processing');
    } finally {
      await first.query('DROP TRIGGER slow_content_test ON shorts_content');
      await first.query('DROP FUNCTION slow_content_test()');
    }
    const recovered = await b.claim(s); await b.complete(s, recovered, record(recovered));
    assert.equal((await a.getJob(s, 'ak_creator', 'slow')).status, 'ready');
  });
  await t.test('a worker waiting for an unchanged row lock cannot renew or fail its claim after expiry', async () => {
    for (const action of ['heartbeat', 'fail']) {
      const s = await scope(); await a.enqueue(s, 'waiting', 'ak_creator', input());
      const job = await a.claim(s, 1000);
      const runner = first.createQueryRunner(); await runner.connect(); await runner.startTransaction();
      let pending;
      try {
        await runner.query('SELECT id FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE', [s.network, s.contract, 'waiting']);
        pending = b[action](s, job);
        await new Promise(resolve => setTimeout(resolve, 1100));
        await runner.commitTransaction();
      } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
      assert.equal(await pending, false);
      const replacement = await a.claim(s); assert.equal(replacement.fence, '2');
    }
  });
  await t.test('concurrent content changes preserve every update and stale replacements cannot overwrite review decisions', async () => {
    const s = await scope(); await a.enqueue(s, 'counted', 'ak_creator', input());
    const job = await a.claim(s); await a.complete(s, job, record(job));
    const initial = await a.get(s, 'counted');
    await admittedBurst(Array.from({ length: 20 }, (_, i) => () => (i % 2 ? a : b).change(s, 'counted', value => { value.reports += 1; })));
    const current = await b.change(s, 'counted', value => { value.moderation = 'rejected'; });
    assert.equal(current.record.reports, 20); assert.equal(current.revision, '22');
    await assert.rejects(a.replace(s, { ...initial.record, moderation: 'approved' }, initial.revision), { status: 409 });
    for (const field of ['creator', 'id', 'cid', 'bytes', 'duration', 'createdAt', 'files']) {
      await assert.rejects(a.change(s, 'counted', value => {
        value[field] = field === 'files' ? [] : typeof value[field] === 'number' ? value[field] + 1 : `different${value[field]}`;
      }));
    }
    await assert.rejects(a.change(s, 'counted', async () => {}), /synchronous/);
    assert.equal((await a.get(s, 'counted')).revision, '22');
    const writes = await Promise.allSettled([a.replace(s, { ...current.record, title: 'A' }, current.revision), b.replace(s, { ...current.record, title: 'B' }, current.revision)]);
    assert.equal(accepted(writes).length, 1);
    assert.equal((await b.get(s, 'counted')).revision, '23');
  });
  await t.test('bounded cursor pagination handles timestamp ties and separates creators/deployments', async () => {
    const s = await scope();
    for (let i = 0; i < 7; i++) {
      await a.enqueue(s, `page${i}`, i % 2 ? 'ak_other' : 'ak_creator', input());
      const job = await a.claim(s); await a.complete(s, job, record(job));
    }
    const ids = []; let after;
    do { const page = await b.page(s, { limit: 2, after }); ids.push(...page.items.map(item => item.record.id)); after = page.next; } while (after);
    assert.deepEqual(ids, ['page6', 'page5', 'page4', 'page3', 'page2', 'page1', 'page0']);
    assert.equal((await a.page(s, { creator: 'ak_creator' })).items.length, 4);
    assert.equal((await a.page(await scope())).items.length, 0);
    await assert.rejects(a.page(s, { limit: 101 }), { status: 400 });
    await assert.rejects(a.page(s, { after: { at: 0, id: "' OR true;--" } }), { status: 400 });
  });
  await t.test('failed jobs retain their reservation and can finish while new ingress is paused', async () => {
    const s = await scope(8, 2);
    await a.enqueue(s, 'retry-capacity', 'ak_creator', input());
    await a.fail(s, await a.claim(s));
    for (let i = 0; i < 49; i++)
      await a.insertDraft(s, record({ id: `capacity${i}`, creator: 'ak_creator' }));
    const attempts = await Promise.allSettled([
      a.retry(s, 'ak_creator', 'retry-capacity'),
      b.enqueue(s, 'new-capacity', 'ak_other', input()),
    ]);
    assert.equal(accepted(attempts).length, 1);
    assert.equal(attempts[0].status, 'fulfilled');
    assert.equal(attempts[1].reason.code, 'SH509');
    const [counts] = await first.query(`SELECT
      (SELECT count(*) FROM shorts_content WHERE network=$1 AND contract=$2) AS content,
      (SELECT count(*) FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND status IN ('queued','processing')) AS jobs`, [s.network, s.contract]);
    assert.equal(Number(counts.content) + Number(counts.jobs), 50);
    const job = await a.claim(s);
    await b.complete(s, job, record(job));
    await assert.rejects(a.enqueue(s, 'overflow', 'ak_creator', input()), { status: 503 });
    assert.equal((await a.uploadBudget(s)).usedUploads, '50');
  });
  await t.test('explicit retry limits, cancellation and exhausted crashed attempts remain durable', async () => {
    const s = await scope(2, 2);
    await a.enqueue(s, 'cancel', 'ak_creator', input());
    await assert.rejects(a.cancel(s, 'ak_other', 'cancel'), { status: 404 });
    await a.cancel(s, 'ak_creator', 'cancel'); await a.cancel(s, 'ak_creator', 'cancel');
    await assert.rejects(a.retry(s, 'ak_creator', 'cancel'), { status: 409 });
    await a.enqueue(s, 'retry', 'ak_creator', input());
    let job = await a.claim(s);
    await assert.rejects(a.cancel(s, 'ak_creator', 'retry'), { status: 409 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(job.attempts, attempt); assert.equal(await a.fail(s, job), true);
      if (attempt < 3) { await b.retry(s, 'ak_creator', 'retry'); job = await b.claim(s); }
    }
    await assert.rejects(b.retry(s, 'ak_creator', 'retry'), { status: 409 });
    await a.enqueue(s, 'crashes', 'ak_creator', input());
    for (let attempt = 1; attempt <= 3; attempt++) {
      job = await a.claim(s); assert.equal(job.attempts, attempt);
      await first.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE network=$1 AND contract=$2 AND id='crashes'", [s.network, s.contract]);
    }
    assert.equal(await b.claim(s), undefined);
    assert.equal((await b.getJob(s, 'ak_creator', 'crashes')).errorCode, 'attempts_exhausted');
    const health = await a.health(s);
    assert.equal(health.counts.failed, 2); assert.equal(health.counts.cancelled, 1);
    assert.equal(JSON.stringify(health).includes('creator'), false);
  });
  await t.test('a killed worker is replaced after its database lease expires, without lost or duplicate content', async () => {
    const s = await scope(); await a.enqueue(s, 'crash', 'ak_creator', input());
    const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/shorts/testing/metadata-worker.cjs'], {
      cwd: process.cwd(), env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', SHORTS_TEST_PG_SCHEMA: schema, SHORTS_TEST_PG_SCOPE: JSON.stringify(s) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    let diagnostics = ''; child.stderr.on('data', bytes => { diagnostics += bytes; });
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(diagnostics); })]);
    assert.equal(message.job.id, 'crash');
    child.kill('SIGKILL'); await exited;
    let recovered;
    for (let attempt = 0; attempt < 40 && !recovered; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50)); recovered = await b.claim(s);
    }
    assert.ok(recovered); assert.equal(recovered.fence, '2');
    await assert.rejects(a.complete(s, message.job, record(message.job)), { status: 409 });
    await b.complete(s, recovered, record(recovered));
    assert.equal((await a.page(s)).items.length, 1);
    assert.equal((await a.getJob(s, 'ak_creator', 'crash')).status, 'ready');
  });
});
