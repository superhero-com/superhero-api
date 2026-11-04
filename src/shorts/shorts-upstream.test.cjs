const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readShortsResponse, readShortsJson } = require('./shorts-upstream');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsSafetyService } = require('./shorts-safety.service');
const { ShortsLabelsService } = require('./shorts-labels.service');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function streamed(chunks, headers) {
  let reads = 0,
    cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (reads < chunks.length)
          controller.enqueue(new Uint8Array(chunks[reads++]));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { headers }),
    reads: () => reads,
    cancelled: () => cancelled,
  };
}

test('upstream byte budgets stop dishonest and chunked bodies before unbounded buffering', async () => {
  const small = streamed([Buffer.from('a'), Buffer.from('bc')]);
  assert.equal((await readShortsResponse(small.response, 3)).toString(), 'abc');
  for (const headers of [undefined, { 'content-length': '1' }]) {
    const large = streamed(
      [Buffer.alloc(3), Buffer.alloc(3), Buffer.alloc(10000)],
      headers,
    );
    await assert.rejects(readShortsResponse(large.response, 4), /too large/);
    assert.equal(large.reads(), 2);
    assert.equal(large.cancelled(), true);
  }
  for (const size of ['9000000', '-1', 'NaN']) {
    const large = streamed([Buffer.alloc(1)], { 'content-length': size });
    await assert.rejects(
      readShortsResponse(large.response, 4),
      /too large or invalid/,
    );
    assert.equal(large.reads(), 0);
    assert.equal(large.cancelled(), true);
  }
  for (const size of [-1, NaN, 1.5, 67108865]) {
    const bad = streamed([Buffer.alloc(1)]);
    await assert.rejects(
      readShortsResponse(bad.response, size),
      /Invalid.*limit/,
    );
    assert.equal(bad.cancelled(), true);
  }
  await assert.rejects(
    readShortsJson(new Response(new Uint8Array([0xff])), 4),
    /Invalid upstream JSON/,
  );
  await assert.rejects(
    readShortsJson(new Response('{'), 4),
    /Invalid upstream JSON/,
  );
  assert.deepEqual(await readShortsJson(new Response('{"ok":true}'), 11), {
    ok: true,
  });
});

test('caller cancellation stops a stalled body and never returns a partial result', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const controller = new AbortController();
  const read = readShortsResponse(response, 100, controller.signal);
  controller.abort();
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(cancelled, true);
  const pre = streamed([Buffer.alloc(1)]);
  await assert.rejects(
    readShortsResponse(pre.response, 10, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(pre.reads(), 0);
  assert.equal(pre.cancelled(), true);
});

test(
  'real HTTP bounds decoded gzip bytes and closes stalled and oversize responses',
  { timeout: 10000 },
  async (t) => {
    const closed = new Set();
    const server = createServer((req, res) => {
      res.on('close', () => closed.add(req.url));
      if (req.url === '/gzip' || req.url === '/gzip-small') {
        const bytes = gzipSync(
          req.url === '/gzip-small'
            ? Buffer.from('valid')
            : Buffer.alloc(100000, 65),
        );
        res.writeHead(200, {
          'content-encoding': 'gzip',
          'content-length': bytes.length,
        });
        res.end(bytes);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.from('first'));
      if (req.url === '/flood') {
        const timer = setInterval(() => res.write(Buffer.alloc(1024)), 2);
        res.on('close', () => clearInterval(timer));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    let signal = AbortSignal.timeout(1000);
    assert.equal(
      (
        await readShortsResponse(
          await fetch(url + '/gzip-small', { signal }),
          5,
          signal,
        )
      ).toString(),
      'valid',
    );
    await assert.rejects(
      readShortsResponse(await fetch(url + '/gzip', { signal }), 4096, signal),
      /too large/,
    );
    signal = AbortSignal.timeout(1000);
    await assert.rejects(
      readShortsResponse(await fetch(url + '/flood', { signal }), 4096, signal),
      /too large/,
    );
    signal = AbortSignal.timeout(200);
    await assert.rejects(
      readShortsResponse(
        await fetch(url + '/stalled', { signal }),
        4096,
        signal,
      ),
      (error) => ['TimeoutError', 'AbortError'].includes(error.name),
    );
    for (
      let i = 0;
      i < 100 && !(closed.has('/flood') && closed.has('/stalled'));
      i++
    )
      await pause(5);
    assert.ok(closed.has('/flood'));
    assert.ok(closed.has('/stalled'));
  },
);

test('IPFS media uses the committed byte budget and discards unread status bodies', async (t) => {
  const bytes = Buffer.from('owned fixture');
  const short = {
    id: 'owned',
    cid: 'bafyfixture',
    files: [
      {
        name: 'video.mp4',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
  const media = new ShortsMediaService({});
  let reply = () => new Response(bytes);
  let requests = 0;
  t.mock.method(media, 'ipfsFetch', async (_path, init) => {
    assert.ok(init.signal);
    requests++;
    return reply();
  });
  assert.deepEqual(await media.retrieve(short, 'video.mp4'), bytes);
  const overflow = streamed([bytes, Buffer.from('extra'), Buffer.alloc(10000)]);
  reply = () => overflow.response;
  await assert.rejects(media.retrieve(short, 'video.mp4'), /too large/);
  assert.equal(overflow.cancelled(), true);
  const n = requests;
  for (const size of [NaN, -1, 0, 67108865])
    await assert.rejects(
      media.retrieve(
        { ...short, files: [{ ...short.files[0], bytes: size }] },
        'video.mp4',
      ),
      /manifest size/,
    );
  assert.equal(requests, n);
  let cancelled = false;
  reply = () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );
  await assert.rejects(media.retrieve(short, 'video.mp4'), /unavailable/);
  assert.equal(cancelled, true);
  cancelled = false;
  assert.equal(await media.health(), false);
  assert.equal(cancelled, true);
  reply = () => new Response('x'.repeat(16385));
  await assert.rejects(
    media.add([{ name: 'video.mp4', data: bytes }], false),
    /too large/,
  );
  reply = () => new Response('x'.repeat(262145));
  await assert.rejects(media.pins(), /too large/);
  reply = () =>
    new Response(
      JSON.stringify({
        Keys: Object.fromEntries(
          Array.from({ length: 4097 }, (_, i) => ['cid' + i, {}]),
        ),
      }),
    );
  await assert.rejects(media.pins(), /inventory exceeds local limit/);
});

test('oversized or interrupted moderation and topic responses retain fail-closed decisions', async (t) => {
  const keys = [
    'SHORTS_DEMO_AUTO_APPROVE',
    'SHORTS_TESTNET_MVP',
    'NODE_ENV',
    'SHORTS_MODERATION_URL',
    'SHORTS_MODERATION_TOKEN_FILE',
    'SHORTS_JEV_ENABLED',
    'SHORTS_JEV_MODEL',
    'TYPESAFE_API_KEY',
  ];
  const saved = keys.map((key) => process.env[key]);
  keys.forEach((key) => delete process.env[key]);
  const dir = await mkdtemp(join(tmpdir(), 'shorts-upstream-'));
  t.after(async () => {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    await rm(dir, { recursive: true });
  });
  process.env.SHORTS_MODERATION_TOKEN_FILE = join(dir, 'token');
  await writeFile(
    process.env.SHORTS_MODERATION_TOKEN_FILE,
    'test-token'.repeat(8),
    { mode: 0o600 },
  );
  process.env.SHORTS_JEV_ENABLED = '1';
  process.env.SHORTS_JEV_MODEL = 'jev-1.13.0';
  process.env.TYPESAFE_API_KEY = 'owned-test-only';
  let reply = () => new Response(JSON.stringify({ ready: true }));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return reply();
  });
  const safety = new ShortsSafetyService(),
    labels = new ShortsLabelsService();
  assert.equal(await safety.health(), true);
  reply = () =>
    new Response(JSON.stringify({ ready: true, extra: 'x'.repeat(16384) }));
  assert.equal(await safety.health(), false);
  reply = () => new Response(JSON.stringify({ extra: 'x'.repeat(262145) }));
  assert.equal((await safety.scan(Buffer.from('owned'))).status, 'error');
  reply = () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { topic: { type: 'choice', choice: 'Art', confidence: 0.99 } },
        extra: 'x'.repeat(16384),
      }),
    );
  assert.equal(
    (await labels.classify({ title: 'Art', topic: 'Art' })).status,
    'review-needed',
  );
  for (const invoke of [
    (signal) => safety.scan(Buffer.from('owned'), signal),
    (signal) => labels.classify({ title: 'Art', topic: 'Art' }, signal),
  ]) {
    let cancelled = false;
    reply = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from('{'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    const controller = new AbortController();
    const result = invoke(controller.signal);
    setTimeout(() => controller.abort(), 10);
    assert.ok(['error', 'review-needed'].includes((await result).status));
    assert.equal(cancelled, true);
  }
});
