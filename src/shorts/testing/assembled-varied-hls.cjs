// Actual approved API publication preparation -> controlled chain observation ->
// production plugin/outbox -> IPFS/HLS/NGINX. No external signer or model claims.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { join, isAbsolute } = require('node:path');
const { writeFile } = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const exec = promisify(execFile);

exports.assembledVariedHls = async (t, f, { repo, edgeBase, get, prepared, metrics }) => {
  const { owner, meta, scope, b, c, request, uploaded, operatorToken, until, pause } = f;
  const { runPlaybackLoad } = await import(pathToFileURL(join(repo, 'test/load-playback.mjs')).href);
  const sources = new Set(), packages = new Set(), observations = [], sessions = [];
  t.after(async () => {
    // These packages were created by this fixture on its disposable offline node.
    for (const cid of sources) await fetch(f.endpoints.KUBO_API.href + '/pin/rm?arg=' + cid, { method: 'POST', signal: AbortSignal.timeout(5000) });
  });
  const before = await metrics();
  for (const upload of uploaded) {
    const began = performance.now();
    const decision = await request(b, `/review/${upload.id}`, { approved: true }, operatorToken);
    assert.equal(decision.status, 201);
    assert.equal((await request(c, `/${upload.id}/publish`, {}, upload.token)).status, 202);
    assert.equal((await request(b, `/${upload.id}/publish`, {}, upload.token)).status, 202);
    await until(async () => {
      await b.command('reconcile');
      return (await owner.query('SELECT status FROM shorts_publication_jobs WHERE id=$1', [upload.id]))[0]?.status === 'queued';
    });
    const short = (await meta.get(scope, upload.id)).record; sources.add(short.cid);
    assert.equal((await get(f.endpoints.KUBO_API.href + '/pin/ls?arg=' + short.cid, { method: 'POST' })).status, 200);
    await f.registerUpload(upload.id);
    const publication = await request(c, `/${upload.id}/publication`, undefined, upload.token);
    assert.equal(publication.status, 200); assert.equal(publication.body.publicationStatus, 'published');
    await b.command('dispatch');
    const load = await runPlaybackLoad({ urls: [edgeBase + `/videos/${upload.id}/playback`], visits: 1,
      concurrency: 1, prepareTimeoutMs: 120000, requestTimeoutMs: 15000, paceMs: 0, segmentPaceMs: 150 });
    assert.equal(load.completed, 1, JSON.stringify(load.failures));
    const bundle = await prepared(upload.id); assert.ok(bundle); packages.add(bundle.cid);
    assert.ok(bundle.files.length > 2);
    const session = await get(edgeBase + `/videos/${upload.id}/playback`, { method: 'POST' });
    assert.equal(session.status, 200);
    const manifest = new URL(JSON.parse(session.text).manifest, edgeBase);
    assert.equal(manifest.origin, edgeBase);
    const playlist = await get(manifest); assert.equal(playlist.status, 200);
    const first = new URL(playlist.text.split('\n').find(line => line.startsWith('segment-')), manifest);
    const hit = await get(first); assert.equal(hit.status, 200); assert.equal(hit.headers.get('x-cache'), 'HIT');
    assert.equal((await get(edgeBase + `/videos/${upload.id}/video.mp4`)).status, 410);
    // Keep default edge limits; pace full decoder reads rather than bypassing
    // authorization or forging independent client IPs.
    await pause(2200);
    let probe;
    try {
      probe = JSON.parse((await exec('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',manifest.href], { timeout: 20000, maxBuffer: 65536 })).stdout);
      await exec('ffmpeg', ['-nostdin','-v','error','-readrate','4','-i',manifest.href,'-f','null','-'], { timeout: 45000, maxBuffer: 16384 });
    } catch { assert.fail('The owned HLS stream could not be probed or decoded'); }
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.width, 540); assert.equal(video.height, 960);
    assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), upload.audio);
    assert.ok(Math.abs(Number(probe.format.duration) - upload.seconds) < .2);
    observations.push({ name: upload.name, seconds: upload.seconds, audio: upload.audio,
      preparedMp4Bytes: upload.preparedBytes, hlsBytes: bundle.files.reduce((sum, file) => sum + file.bytes, 0),
      segmentCount: bundle.files.filter(file => file.name.startsWith('segment-')).length,
      publicationToDecodedMs: Math.round(performance.now() - began), load });
    sessions.push({ id: upload.id, first });
  }
  assert.equal(sources.size, uploaded.length, 'source packages must be distinct');
  assert.equal(packages.size, uploaded.length, 'prepared HLS packages must be distinct');
  const ids = uploaded.map(upload => upload.id);
  const [{ count }] = await owner.query('SELECT count(*) FROM shorts_publication_jobs WHERE id=ANY($1::text[])', [ids]);
  assert.equal(Number(count), ids.length);
  const visible = await request(b, '/feed/state', { ids });
  assert.deepEqual(new Set(visible.body.items.map(item => item.id)), new Set(ids));
  await pause(2200);
  const warm = await runPlaybackLoad({ urls: ids.map(id => edgeBase + `/videos/${id}/playback`),
    visits: 8, concurrency: 2, paceMs: 1000, segmentPaceMs: 150 });
  assert.equal(warm.completed, 8, JSON.stringify(warm.failures));
  assert.equal(warm.stages.segment.cacheHits, warm.stages.segment.requests);
  const after = await metrics();
  assert.ok(after.cache.bytes > before.cache.bytes + 1000000, 'the workload must populate distinct nontrivial media');
  assert.equal(after.cache.reserved, 0); assert.equal(after.cache.downloads, 0); assert.equal(after.preparation.failed, 0);

  const withdrawn = sessions.at(-1);
  await f.withdrawUpload(withdrawn.id);
  await pause(2100); // Test catalog TTL; production revocation default remains 15s.
  const denied = await get(withdrawn.first); assert.equal(denied.status, 403); assert.equal(denied.headers.has('x-cache'), false);
  assert.equal((await get(edgeBase + `/videos/${withdrawn.id}/playback`, { method: 'POST' })).status, 404);
  for (const session of sessions.slice(0, -1)) {
    const hit = await get(session.first); assert.equal(hit.status, 200); assert.equal(hit.headers.get('x-cache'), 'HIT');
  }
  const remaining = await request(c, '/feed/state', { ids });
  assert.deepEqual(new Set(remaining.body.items.map(item => item.id)), new Set(ids.filter(id => id !== withdrawn.id)));
  const report = { scope: 'four distinct owned synthetic uploads; controlled approval/chain observation; real API journal/plugin/IPFS/HLS/edge/FFmpeg',
    observations, warm, before, after, independentCacheRevocation: true };
  const output = process.env.SHORTS_TEST_VARIED_HLS_OUTPUT;
  if (output) { assert.ok(isAbsolute(output)); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
  t.diagnostic(JSON.stringify({ videos: observations.map(({ name, seconds, hlsBytes, segmentCount, publicationToDecodedMs }) =>
    ({ name, seconds, hlsBytes, segmentCount, publicationToDecodedMs })), warmCompleted: warm.completed,
    cacheBytesBefore: before.cache.bytes, cacheBytesAfter: after.cache.bytes, independentCacheRevocation: true }));
};
