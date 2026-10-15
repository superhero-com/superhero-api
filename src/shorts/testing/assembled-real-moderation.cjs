// Actual model service is provided separately, dedicated to these generated clips.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readFile } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AccountMemory } = require('@aeternity/aepp-sdk');
const run = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
exports.assembledRealModeration = async (t, f) => {
  const { owner, meta, scope, dir, b, c, request, until, createWorker } = f;
  assert.equal(process.env.SHORTS_TEST_MODERATION_DISPOSABLE, '1');
  const endpoint = new URL(process.env.SHORTS_TEST_MODERATION_URL);
  assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.pathname, '/'); assert.equal(endpoint.username + endpoint.password + endpoint.search + endpoint.hash, '');
  const credential = process.env.SHORTS_TEST_MODERATION_TOKEN_FILE; assert.ok(isAbsolute(credential));
  assert.ok((await readFile(credential, 'utf8')).trim().length >= 32);
  const modelHealth = await (await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(3000) })).json();
  assert.equal(modelHealth.ready, true); assert.equal(modelHealth.accepting, true);
  const workers = [], sockets = new Set(), upstreams = new Set(), waiting = [];
  const statuses = {}, jobs = [], started = performance.now(); let pairing = true, barrierTimer, paired = 0;
  const requests = {}, proxyErrors = [];
  // Hold the first inspection until another worker has observed real readiness
  // and committed its claim. Simultaneous claims may correctly lose the DB's
  // nonblocking capacity lock, which would never reach the scanner race.
  // Release both unchanged bodies to the actual single-slot model service.
  const proxy = http.createServer((req, res) => {
    if (!['/health', '/inspect'].includes(req.url)) { res.writeHead(404).end(); return; }
    requests[req.url] = (requests[req.url] || 0) + 1;
    const upstream = http.request(new URL(req.url, endpoint), { method: req.method, headers: req.headers }, response => {
      const status = response.statusCode; statuses[`${req.url}:${status}`] = (statuses[`${req.url}:${status}`] || 0) + 1;
      res.writeHead(status, response.headers); response.pipe(res);
    });
    upstreams.add(upstream); upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', error => { proxyErrors.push(error.code || error.name); if (!res.headersSent) res.writeHead(503); res.end(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    if (req.url === '/inspect' && pairing) {
      waiting.push(() => req.pipe(upstream));
      if (waiting.length === 2) { clearTimeout(barrierTimer); pairing = false; paired = 2; waiting.splice(0).forEach(send => send()); }
      else barrierTimer = setTimeout(() => { pairing = false; waiting.splice(0).forEach(send => send()); }, 10000);
    } else req.pipe(upstream);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  async function stop(worker) {
    if (worker.process.exitCode !== null || worker.process.signalCode !== null) return;
    const exited = once(worker.process, 'exit'); worker.process.kill('SIGTERM');
    const force = setTimeout(() => worker.process.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  try {
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    for (const seconds of [60, 2]) {
      const file = join(dir, `real-scan-${seconds}.mp4`);
      await run('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i',`color=c=blue:s=128x128:r=10:d=${seconds}`,
        '-c:v','libx264','-threads','1',file], { timeout: 15000 });
      const bytes = await readFile(file), wallet = AccountMemory.generate();
      const challenge = await request(b, '/auth/challenge', { address: wallet.address }); assert.equal(challenge.status, 201);
      const session = await request(c, '/auth/verify', { id: challenge.body.id, signature: Buffer.from(await wallet.signMessage(challenge.body.message)).toString('hex') });
      assert.equal(session.status, 201); const token = session.body.token;
      const created = await request(b, '/uploads', { title: `Real scan ${seconds}`, topic: 'Art', rights: true, bytes: bytes.length, sha256: hash(bytes), details: {} }, token);
      assert.equal(created.status, 201); const id = created.body.id;
      const form = new FormData(); form.append('file', new Blob([bytes]), 'part');
      assert.equal((await request(c, `/uploads/${id}/parts/0`, form, token)).status, 201);
      assert.equal((await request(b, `/uploads/${id}/finish`, {}, token)).status, 202);
      jobs.push({ id, creator: wallet.address, token, sourceHash: hash(bytes), seconds });
    }
    const rows = () => owner.query('SELECT id,status,attempts,fence FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=ANY($3::text[]) ORDER BY id', [scope.network, scope.contract, jobs.map(job => job.id)]);
    const env = { SHORTS_TEST_REAL_MODERATION: '1', SHORTS_MODERATION_URL: `http://127.0.0.1:${proxy.address().port}`,
      SHORTS_MODERATION_TOKEN_FILE: credential };
    workers.push(createWorker(env)); await workers[0].wait('started');
    await until(() => requests['/inspect'] === 1, 15000);
    workers.push(createWorker(env)); await workers[1].wait('started');
    await until(() => statuses['/inspect:429'] > 0, 15000); assert.equal(paired, 2);
    const deferred = await until(async () => (await rows()).find(row => row.status === 'queued' && row.attempts === 0 && Number(row.fence) === 1), 10000);
    await assert.rejects(meta.get(scope, deferred.id), { status: 404 }, 'busy scan cannot create a safety result');
    // Stop both: the interrupted scan is cancelled; the already-deferred job
    // keeps its refunded attempt. A fresh worker uses ordinary lease recovery.
    await Promise.all(workers.map(stop)); const stopped = await rows();
    assert.equal(stopped.find(row => row.id === deferred.id).attempts, 0);
    const interrupted = stopped.find(row => row.id !== deferred.id); assert.equal(interrupted.status, 'processing');
    const replacement = createWorker(env); workers.push(replacement); await replacement.wait('started');
    await until(async () => { const current = await rows(); assert.ok(current.every(row => row.status !== 'failed')); return current.every(row => row.status === 'ready'); }, 210000);
    const completed = await rows(); const observations = [];
    for (const job of jobs) {
      const state = completed.find(row => row.id === job.id), record = (await meta.get(scope, job.id)).record;
      assert.equal(state.attempts, job.id === deferred.id ? 1 : 2); assert.equal(Number(state.fence), 2);
      assert.equal(record.privateMedia.fence, '2'); assert.equal(record.creator, job.creator);
      assert.equal(record.safety.sourceSha256, job.sourceHash); assert.equal(record.safety.humanReviewRequired, true);
      assert.equal(record.safety.models.safety.repository, 'Falconsai/nsfw_image_detection');
      assert.equal(record.safety.models.topics.repository, 'openai/clip-vit-base-patch32');
      assert.deepEqual(record.safety.models, modelHealth.models); assert.equal(record.safety.policy, modelHealth.policy);
      assert.ok(record.safety.frameCount >= job.seconds * 2); assert.match(record.safety.evidenceHash, /^[a-f0-9]{64}$/);
      assert.equal(record.publication, undefined); assert.equal(record.moderation, record.safety.status === 'blocked' ? 'rejected' : 'pending');
      assert.equal((await request(b, `/playback/${job.id}`)).status, 404);
      assert.equal((await request(c, `/${job.id}/publish`, {}, job.token)).status, 403);
      assert.equal((await request(b, `/uploads/${job.id}`, undefined, jobs.find(other => other.id !== job.id).token)).status, 404);
      observations.push({ seconds: job.seconds, frames: record.safety.frameCount, status: record.safety.status, attempts: state.attempts, fence: Number(state.fence) });
    }
    const [{ count }] = await owner.query('SELECT count(*) FROM shorts_publication_jobs WHERE network=$1 AND contract=$2 AND id=ANY($3::text[])', [scope.network, scope.contract, jobs.map(job => job.id)]);
    assert.equal(Number(count), 0);
    t.diagnostic(JSON.stringify({ realModeration: true, elapsedMs: Math.round(performance.now() - started), statuses, observations }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ realModerationFailure: true, paired, requests, statuses, proxyErrors,
      workers: workers.map(worker => ({ exit: worker.process.exitCode, signal: worker.process.signalCode })),
      jobs: await owner.query('SELECT status,attempts,fence FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=ANY($3::text[])', [scope.network, scope.contract, jobs.map(job => job.id)]) }));
    throw error;
  } finally {
    clearTimeout(barrierTimer); waiting.splice(0).forEach(send => send());
    await Promise.all(workers.map(stop));
    for (const upstream of upstreams) upstream.destroy(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
};
