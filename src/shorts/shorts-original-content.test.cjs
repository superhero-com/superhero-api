require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { validateOriginalContent } = require('./shorts-original-content');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { workerRole } = require('./testing/worker-role.cjs');
const { ShortsOriginalContent1793145600000: Migration } = require('../migrations/1793145600000-ShortsOriginalContent');
const hash = 'a'.repeat(64), cid = 'bafy' + 'a'.repeat(50);
const profile = 'original-h264-v1';
function input(id, original = true) {
  const key = `shorts-private-v1/${hash}/${id}/source-manifest/key1/${hash}`;
  return { objectKey: key, manifest: { key, keyId: 'key1', bytes: 100, sha256: hash },
    bytes: 1234, sha256: hash, title: 'Original', topic: 'Art', details: {}, ...(original ? { processingProfile: profile } : {}) };
}
function record(job = { id: 'fixture', creator: 'ak_creator', fence: '1', input: input('fixture') }) {
  const files = ['video-1080.mp4', 'video-rescue.mp4', 'video.mp4', 'poster.jpg', 'manifest.json']
    .map(name => ({ name, bytes: 100, sha256: hash }));
  return { id: job.id, creator: job.creator, title: job.input.title, topic: job.input.topic, createdAt: 1,
    cid, bytes: job.input.bytes, duration: 3, files, moderation: 'pending', safety: { status: 'no_flags', sourceSha256: hash },
    original: { version: 1, sha256: hash, mediaType: 'video/mp4', importProfile: 'unixfs-file-v1-262144' },
    derivatives: { version: 1, cid: 'bafy' + 'b'.repeat(50), assetsCid: 'bafy' + 'e'.repeat(50), profile, fingerprint: hash, generation: { job: job.id, fence: String(job.fence) }, videos: [
      { name: 'video-1080.mp4', width: 1080, height: 1920, frameRate: '60000/1001' },
      { name: 'video-rescue.mp4', width: 144, height: 256, frameRate: '15000/1001' },
    ] },
    privateMedia: { version: 1, fence: String(job.fence), source: structuredClone(job.input),
      files: Object.fromEntries(files.map(file => [file.name, { bytes: file.bytes, sha256: hash, keyId: 'key1',
        key: `shorts-private-v1/${hash}/${job.id}/attempt/${job.fence}/${file.name.replaceAll('.', '-')}/key1/${hash}` }])) },
  };
}
const mutations = [
  r => { delete r.original; }, r => { delete r.derivatives; }, r => { r.original = null; },
  r => { r.original.sha256 = 'bad'; }, r => { r.original.mediaType = 'image/jpeg'; },
  r => { r.original.importProfile = 'directory'; }, r => { r.bytes = 500; },
  r => { r.bytes = '1234'; }, r => { r.bytes = 1234.5; }, r => { r.bytes = 100000001; },
  r => { r.derivatives.cid = '../evil'; }, r => { r.derivatives.profile = 'unknown'; },
  r => { delete r.derivatives.assetsCid; }, r => { r.derivatives.assetsCid = '../bad'; },
  r => { r.derivatives.assetsCid = r.cid; }, r => { r.derivatives.assetsCid = r.derivatives.cid; },
  r => { r.files.find(file => file.name === 'video.mp4').bytes = 67108864; },
  r => { r.derivatives.fingerprint = ''; }, r => { r.files[0].bytes = 2.5; },
  r => { delete r.derivatives.generation; }, r => { r.derivatives.generation.job = 'another-job'; },
  r => { r.derivatives.generation.fence = '2'; }, r => { r.derivatives.generation.fence = 1; },
  r => { r.derivatives.generation.fence = '01'; }, r => { r.derivatives.generation.fence = '9223372036854775808'; },
  r => { r.files[0].name = '../video.mp4'; }, r => { r.files[1].name = r.files[0].name; },
  r => { r.files[0].bytes = 100000000; r.files[1].bytes = 100000000; r.files[2].bytes = 100000000; },
  r => { r.captions = true; }, r => { r.files.push({ name: 'audio-main.m4a', bytes: 100, sha256: hash }); },
  r => { r.derivatives.videos[0].width = 1081; }, r => { r.derivatives.videos[0].height = 1922; },
  r => { r.derivatives.videos[0].width = '1080'; }, r => { r.derivatives.videos[0].width = 1920; },
  r => { r.derivatives.videos[0].frameRate = '1/0'; }, r => { r.derivatives.videos[0].frameRate = '61/1'; },
  r => { r.derivatives.videos[0].frameRate = '1/2'; }, r => { r.derivatives.videos.pop(); },
  r => { r.derivatives.videos[1].name = 'video-1080.mp4'; },
  r => { r.privateMedia.source.sha256 = 'b'.repeat(64); },
  r => { r.privateMedia.source.processingProfile = 'unknown'; },
];
test('original identity describes the source separately from its delivery package', () => {
  assert.equal(validateOriginalContent(record()), true);
  assert.equal(validateOriginalContent({}), false);
  for (const mutate of mutations) {
    const candidate = record(); mutate(candidate);
    assert.throws(() => validateOriginalContent(candidate), undefined, String(mutate));
  }
});

test('PostgreSQL fences original identity, handles mixed workers and rejects forged delivery',
  { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 }, async t => {
    const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
    const schema = 'shorts_original_' + randomUUID().replaceAll('-', '');
    const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 2 } };
    const owner = new DataSource(options); await owner.initialize();
    let identity, worker;
    t.after(async () => {
      if (worker) await worker.destroy(); await owner.destroy();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      if (identity) await identity.dispose(); await admin.destroy();
    });
    await owner.transaction(async manager => {
      for (const name of ['1791763200000-ShortsMetadata', '1791763203000-ShortsWorkers',
        '1791763204000-ShortsWorkerAuthority', '1791763215000-ShortsProcessingCapacity', '1791763222000-ShortsWorkerBackpressure']) {
        const M = Object.values(require('../migrations/' + name))[0]; await new M().up(manager);
      }
      await new Migration().up(manager);
    });
    await owner.transaction(manager => new Migration().down(manager));
    await owner.transaction(manager => new Migration().up(manager));
    const metadata = new ShortsMetadataService(owner);
    const scope = { network: 'ae_uat', contract: 'ct_' + randomUUID().replaceAll('-', '') };
    await metadata.initialize(scope, hash);
    identity = await workerRole(admin, { url: url.href, schema, scope });
    worker = new DataSource({ ...options, url: identity.url }); await worker.initialize();
    const rpc = async (action, data = {}) => (await worker.query('SELECT shorts_media_worker($1,$2::jsonb) result',
      [action, JSON.stringify({ ...scope, sourceHash: hash, ...data })]))[0].result;
    assert.equal((await rpc('verify')).originalContentVersion, 1);
    await assert.rejects(worker.query("SELECT shorts_validate_original('{}')"), { code: '42501' });
    await metadata.enqueue(scope, 'original', 'ak_creator', input('original'));
    await metadata.enqueue(scope, 'legacy', 'ak_creator', input('legacy', false));
    const old = await rpc('claim', { leaseMs: 120000 }); assert.equal(old.id, 'legacy');
    assert.equal(await rpc('claim', { leaseMs: 120000 }), null);
    const raw = await rpc('claim', { leaseMs: 120000, mediaProtocol: 2 }); assert.equal(raw.id, 'original');
    const job = { ...raw, fence: String(raw.fence), leaseToken: raw.lease_token };
    for (const mutate of mutations) {
      const candidate = record(job); mutate(candidate);
      await assert.rejects(rpc('complete', { ...job, record: candidate }), { code: 'SH400' }, String(mutate));
    }
    const forgedAttempt = record(job);
    forgedAttempt.derivatives.generation.fence = forgedAttempt.privateMedia.fence = String(BigInt(job.fence) + 1n);
    assert.equal(validateOriginalContent(forgedAttempt), true);
    await assert.rejects(rpc('complete', { ...job, record: forgedAttempt }), { code: 'SH400' });
    await assert.rejects(rpc('complete', { ...old, fence: String(old.fence), leaseToken: old.lease_token, record: record({ ...old, fence: String(old.fence) }) }), { code: 'SH400' });
    const result = await rpc('complete', { ...job, record: record(job) });
    assert.equal(result.record.cid, cid); assert.equal(result.record.bytes, 1234);
    assert.equal(result.record.derivatives.cid, 'bafy' + 'b'.repeat(50));
    assert.equal(validateOriginalContent(result.record), true);
    assert.equal((await metadata.get(scope, job.id)).record.cid, cid);
    await metadata.change(scope, job.id, r => { r.moderation = 'approved'; });
    for (const [key, value] of [['cid', 'bafy' + 'c'.repeat(50)], ['original', null], ['derivatives', null], ['bytes', 500]]) {
      await assert.rejects(owner.query('UPDATE shorts_content SET body=jsonb_set(body,ARRAY[$1],$2::jsonb) WHERE id=$3',
        [key, JSON.stringify(value), job.id]), { code: 'SH409' });
    }
    await assert.rejects(owner.transaction(manager => new Migration().down(manager)), /rollback is unsafe/);
    // Legacy jobs retain the previous summed-package byte count and no new identity fields.
    const legacy = record({ ...old, fence: String(old.fence) }); delete legacy.original; delete legacy.derivatives;
    legacy.files = legacy.files.filter(f => !f.name.startsWith('video-')); legacy.bytes = 300;
    for (const name of Object.keys(legacy.privateMedia.files)) if (name.startsWith('video-')) delete legacy.privateMedia.files[name];
    const accepted = await rpc('complete', { ...old, fence: String(old.fence), leaseToken: old.lease_token, record: legacy });
    assert.equal(accepted.record.bytes, 300); assert.equal(accepted.record.original, undefined);
  });
