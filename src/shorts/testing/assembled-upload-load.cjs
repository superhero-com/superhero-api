// Owned-fixture upload/worker workload. Actual HTTP/auth/SQL/S3/FFmpeg;
// classification remains controlled, and no signer or public publication runs.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { performance } = require('node:perf_hooks');
const { AccountMemory } = require('@aeternity/aepp-sdk');
const run = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const mix = [
  { name: 'short-silent', seconds: 2.2, width: 360, height: 640, audio: false },
  { name: 'portrait-audio', seconds: 12, width: 720, height: 1280, audio: true },
  { name: 'landscape-audio', seconds: 30, width: 1280, height: 720, audio: true },
  { name: 'maximum-silent', seconds: 60, width: 540, height: 960, audio: false },
];

exports.assembledUploadLoad = async (t, f) => {
  const { owner, scope, dir, b, c, request, meta, until, pause, createWorker } = f;
  const jobs = [], workers = [], readyAt = new Map();
  const mode = process.env.SHORTS_TEST_UPLOAD_MODE || 'recovery';
  assert.ok(['recovery', 'concurrent'].includes(mode));
  const uploadResponses = {}, resumedResponses = {};
  let stopped = false, sampler, sampleError, samples = 0, maxActive = 0, maxQueued = 0, interrupted;
  const budgetBefore = await meta.uploadBudget(scope);
  const [{ max_processing: capacity }] = await owner.query('SELECT max_processing FROM shorts_runtime WHERE network=$1 AND contract=$2', [scope.network, scope.contract]);
  assert.equal(capacity, 2, 'measure the default shared ceiling');
  const before = performance.now();
  async function stop(worker, signal = 'SIGTERM') {
    if (worker.process.exitCode === null && worker.process.signalCode === null) {
      const exited = once(worker.process, 'exit');
      worker.process.kill(signal);
      const force = setTimeout(() => worker.process.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(force); }
    }
  }
  try {
    for (const fixture of mix) {
      const path = join(dir, `load-${fixture.name}.mp4`);
      // Independent moving synthetic sources; finite CPU/size and no external media.
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${fixture.width}x${fixture.height}:rate=24`,
        ...(fixture.audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
        '-t', String(fixture.seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
        ...(fixture.audio ? ['-c:a', 'aac', '-b:a', '64k'] : []), '-threads', '2', '-movflags', '+faststart', path],
      { timeout: 60000, maxBuffer: 16384 });
      const bytes = await readFile(path); assert.ok(bytes.length < 40 * 1048576);
      const wallet = AccountMemory.generate();
      const challenge = await request(b, '/auth/challenge', { address: wallet.address }); assert.equal(challenge.status, 201);
      const signed = await request(c, '/auth/verify', { id: challenge.body.id,
        signature: Buffer.from(await wallet.signMessage(challenge.body.message)).toString('hex') }); assert.equal(signed.status, 201);
      jobs.push({ ...fixture, path, bytes, wallet, token: signed.body.token });
    }
    const uploadStarted = performance.now();
    async function resumable(stage, operation) {
      for (let attempt = 0; ; attempt++) {
        const result = await operation(), key = `${stage}:${result.status}`;
        uploadResponses[key] = (uploadResponses[key] || 0) + 1;
        if (![429, 503].includes(result.status) || attempt === 3) return result;
        resumedResponses[key] = (resumedResponses[key] || 0) + 1;
        await pause(500 * 2 ** attempt);
      }
    }
    const submitted = await Promise.allSettled(jobs.map(async (job, index) => {
      const api = index % 2 ? b : c, other = index % 2 ? c : b, start = performance.now();
      const created = await request(api, '/uploads', { title: job.name, topic: 'Art', rights: true,
        bytes: job.bytes.length, sha256: hash(job.bytes), details: { language: job.audio ? 'en' : 'und' } }, job.token);
      assert.equal(created.status, 201, JSON.stringify(created.body)); job.id = created.body.id;
      const partSize = created.body.partSize; assert.equal(partSize, 1048576);
      for (let offset = 0, part = 0; offset < job.bytes.length; offset += partSize, part++) {
        const body = new FormData(); body.append('file', new Blob([job.bytes.subarray(offset, offset + partSize)]), 'part');
        const saved = await resumable('part', () => request(other, `/uploads/${job.id}/parts/${part}`, body, job.token));
        assert.equal(saved.status, 201, JSON.stringify(saved.body));
        // Repeat the first accepted part, as after a lost acknowledgement.
        if (part === 0) assert.equal((await resumable('part', () => request(api, `/uploads/${job.id}/parts/0`, body, job.token))).status, 201);
      }
      const finish = await resumable('finish', () => request(api, `/uploads/${job.id}/finish`, {}, job.token)); assert.equal(finish.status, 202, JSON.stringify(finish.body));
      assert.equal((await resumable('finish', () => request(other, `/uploads/${job.id}/finish`, {}, job.token))).status, 202);
      job.acceptedAt = performance.now(); job.uploadMs = Math.round(job.acceptedAt - start);
    }));
    for (const result of submitted) if (result.status === 'rejected') throw result.reason;
    const acceptedMs = Math.round(performance.now() - uploadStarted), ids = jobs.map(job => job.id);
    const rows = () => owner.query('SELECT id,status,attempts,fence,lease_until>clock_timestamp() AS live FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=ANY($3::text[])', [scope.network, scope.contract, ids]);
    const queued = await rows(); assert.equal(queued.length, jobs.length);
    assert.ok(queued.every(row => row.status === 'queued' && row.attempts === 0));
    const budget = await meta.uploadBudget(scope);
    assert.equal(BigInt(budget.usedUploads), BigInt(budgetBefore.usedUploads) + BigInt(jobs.length));
    assert.equal(BigInt(budget.usedSourceBytes), BigInt(budgetBefore.usedSourceBytes)
      + jobs.reduce((sum, job) => sum + BigInt(job.bytes.length), 0n));
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      assert.equal((await request(b, `/uploads/${job.id}`, undefined, jobs[(i + 1) % jobs.length].token)).status, 404);
    }
    sampler = (async () => {
      while (!stopped) {
        try {
          const current = await rows(); samples++;
          maxActive = Math.max(maxActive, current.filter(row => row.status === 'processing' && row.live).length);
          maxQueued = Math.max(maxQueued, current.filter(row => row.status === 'queued').length);
          assert.ok(maxActive <= capacity, 'workers must share the same capacity');
          for (const row of current) if (row.status === 'ready' && !readyAt.has(row.id)) readyAt.set(row.id, performance.now());
          assert.ok(current.every(row => row.status !== 'failed'), 'accepted media must not be lost');
        } catch (error) { sampleError = error; break; }
        await pause(250);
      }
    })();
    let killedAt;
    if (mode === 'concurrent') {
      // Let each claim commit before starting its peer. Simultaneous claims
      // may correctly lose the nonblocking DB admission lock; this scenario
      // measures overlapping processing, without artificially holding encoders.
      for (let i = 0; i < capacity; i++) {
        const worker = createWorker(false); workers.push(worker);
        await worker.wait('started'); await worker.wait('encoding');
      }
    } else {
      const first = createWorker(true); workers.push(first); await first.wait('started');
      const encoding = await first.wait('encoding'); interrupted = jobs.find(job => job.name === encoding.title); assert.ok(interrupted);
      const lease = (await rows()).find(row => row.id === interrupted.id); assert.equal(lease.status, 'processing');
      // Three additional real workers compete for the two shared slots.
      for (let i = 0; i < 3; i++) { const worker = createWorker(false); workers.push(worker); await worker.wait('started'); }
      await until(() => maxActive === capacity, 15000);
      killedAt = performance.now(); await stop(first, 'SIGKILL');
    }
    await until(async () => {
      if (sampleError) throw sampleError;
      return (await rows()).every(row => row.status === 'ready');
    }, 180000);
    if (mode === 'concurrent') assert.equal(maxActive, capacity, 'both processing slots must be observed in use');
    const completed = await rows();
    for (const row of completed) if (!readyAt.has(row.id)) readyAt.set(row.id, performance.now());
    assert.equal(completed.length, jobs.length); assert.equal(new Set(completed.map(row => row.id)).size, jobs.length);
    for (const job of jobs) {
      const expected = job.id === interrupted?.id ? 2 : 1, state = completed.find(row => row.id === job.id);
      assert.equal(state.attempts, expected); assert.equal(Number(state.fence), expected);
      const stored = (await meta.get(scope, job.id)).record;
      assert.equal(stored.privateMedia.fence, String(expected)); assert.equal(stored.creator, job.wallet.address);
      assert.equal(stored.moderation, 'pending'); assert.equal(stored.publication, undefined);
      assert.ok(Math.abs(stored.duration - job.seconds) < .1);
      assert.ok(Object.values(stored.privateMedia.files).every(ref => ref.key.includes(`/attempt/${expected}/`)));
      const status = await request(c, `/uploads/${job.id}`, undefined, job.token); assert.equal(status.status, 200);
      assert.equal(status.body.status, 'ready'); assert.equal(JSON.stringify(status.body).includes('privateMedia'), false);
      assert.equal((await request(b, `/playback/${job.id}`)).status, 404);
      assert.equal((await request(b, `/${job.id}/publish`, {}, job.token)).status, 403);
      const preview = await request(c, `/review-media/${job.id}`, undefined, job.token); assert.equal(preview.status, 200);
      const path = join(dir, `prepared-${job.name}.mp4`); await writeFile(path, preview.body);
      const probe = JSON.parse((await run('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',path], { timeout: 10000 })).stdout);
      const video = probe.streams.find(stream => stream.codec_type === 'video');
      assert.equal(video.width, 540); assert.equal(video.height, 960);
      assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), job.audio);
      assert.ok(Math.abs(Number(probe.format.duration) - job.seconds) < .2);
      await run('ffmpeg', ['-nostdin','-v','error','-i',path,'-f','null','-'], { timeout: 30000, maxBuffer: 16384 });
      job.preparedBytes = preview.body.length;
    }
    const [{ count }] = await owner.query('SELECT count(*) FROM shorts_publication_jobs WHERE network=$1 AND contract=$2 AND id=ANY($3::text[])', [scope.network, scope.contract, ids]);
    assert.equal(Number(count), 0, 'workers and duplicate finishes cannot publish unapproved media');
    const report = { scope: 'owned loopback synthetic upload/worker mix; controlled safety; no remote signer or HLS workload',
      mode, concurrency: jobs.length, processingCeiling: capacity, samples, maxActive, maxQueued, acceptedMs, uploadResponses, resumedResponses,
      interruptedRecoveryMs: interrupted ? Math.round(readyAt.get(interrupted.id) - killedAt) : null,
      totalMs: Math.round(performance.now() - before),
      jobs: jobs.map(job => ({ name: job.name, sourceBytes: job.bytes.length, preparedBytes: job.preparedBytes,
        seconds: job.seconds, width: job.width, height: job.height, audio: job.audio,
        uploadMs: job.uploadMs, acceptedToReadyMs: Math.round(readyAt.get(job.id) - job.acceptedAt),
        attempts: job.id === interrupted?.id ? 2 : 1 })) };
    const output = process.env.SHORTS_TEST_UPLOAD_LOAD_OUTPUT;
    if (output) { assert.ok(isAbsolute(output)); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
    t.diagnostic(JSON.stringify(report));
    return jobs.map(({ id, token, name, seconds, audio, preparedBytes }) => ({ id, token, name, seconds, audio, preparedBytes }));
  } finally {
    stopped = true; await sampler;
    await Promise.all(workers.map(worker => stop(worker)));
  }
};
