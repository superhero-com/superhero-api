// Optional cross-repository integration against a locally built streaming checkout.
// Runs real HLS worker/server/NGINX processes; only the API's chain/safety fixtures
// remain controlled. All files, namespaces, pins and containers are test-owned.
const assert = require('node:assert/strict');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { readFile, writeFile, mkdir, rm } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const http = require('node:http');
const Redis = require('ioredis');
const { assembledBrowser } = require('./assembled-browser.cjs');
const { assembledMeasurements } = require('./assembled-measurements.cjs');
const { assembledCapacity } = require('./assembled-capacity.cjs');
const { assembledVariedHls } = require('./assembled-varied-hls.cjs');
const { ownedEdgeName, startOwnedEdge } = require('./owned-edge.cjs');
const exec = promisify(execFile);

exports.assembledPlayback = async (t, f) => {
  const { dir, endpoints, streamPort, id, b, owner, until, pause, request } = f;
  const repo = process.env.SHORTS_TEST_STREAMING_REPO;
  assert.ok(isAbsolute(repo));
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).name, 'superhero-video-streaming');
  const { sourceKey } = require(join(repo, 'dist/streaming/hls-package.js'));
  const namespace = `assembled-${randomUUID()}`, children = [], sockets = new Set();
  const redis = new Redis(endpoints.REDIS_URL.href);
  const workerDir = join(dir, 'hls-worker'), serverDir = join(dir, 'hls-server');
  let edgeName, removeEdge, edgeBase, server, worker, bundle, viewer, closed = false, sourceHeld = false;
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url, endpoints.KUBO_API.origin);
    const upstream = http.request(url, { method: req.method, headers: { ...req.headers, host: url.host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      if (!sourceHeld && url.pathname === '/api/v0/cat' && url.searchParams.get('arg')?.endsWith('/video.mp4')) {
        response.once('data', bytes => { sourceHeld = true; response.pause(); res.write(bytes.subarray(0, 64)); });
      } else response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const close = async () => {
    if (closed) return; closed = true;
    await viewer?.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await removeEdge?.();
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
    const keys = await redis.keys(namespace + ':*');
    const pins = new Set(bundle ? [bundle.cid] : []);
    for (const key of keys.filter(key => key.startsWith(namespace + ':prepared:'))) {
      const value = await redis.get(key); if (value) pins.add(JSON.parse(value).cid);
    }
    if (keys.length) await redis.del(...keys); redis.disconnect();
    for (const cid of pins) await fetch(endpoints.KUBO_API.href + '/pin/rm?arg=' + cid, { method: 'POST', signal: AbortSignal.timeout(5000) });
  };
  t.after(close);
  if (process.env.SHORTS_TEST_WEB_REPO) {
    assert.ok(process.env.SHORTS_TEST_EDGE_IMAGE, 'browser integration requires the real edge');
    viewer = await assembledBrowser(t, { id, api: b.base, port: f.webPort,
      social: f.social && {
        ...f.social,
        // Notify from the other hosted process: the browser uses b, not c.
        notify: accounts => f.c.command('social-notify', { scope: f.social.graph, accounts }),
        notifyOther: () => f.c.command('social-notify', { scope: { ...f.social.graph, contract: f.scope.contract } }),
        disconnect: () => b.command('social-disconnect'),
        async interruptListener(change) {
          const previous = (await b.command('social-listener')).pid;
          assert.ok(Number.isInteger(previous));
          await owner.query('SELECT pg_terminate_backend($1)', [previous]);
          await change();
          return until(async () => {
            try { const current = (await b.command('social-listener')).pid; return current && current !== previous; }
            catch { return false; }
          }, 10000);
        },
      }, creator: f.creator, outsider: require('@aeternity/aepp-sdk').AccountMemory.generate(),
      upload: {
        input: f.input, startWorker: f.startUploadWorker,
        async approve(shortId) {
          assert.equal((await request(b, `/review/${shortId}`, { approved: true }, f.operatorToken)).status, 201);
        },
        async queued(shortId) {
          await b.command('reconcile');
          return until(async () => (await owner.query('SELECT status FROM shorts_publication_jobs WHERE id=$1', [shortId]))[0]?.status === 'queued');
        },
        confirm: f.registerUpload,
        async startPlayback() { worker = await start('worker'); },
        async retire(shortId) {
          if (!(await f.meta.get(f.scope, shortId))) return;
          assert.equal((await request(b, `/review/${shortId}`, { approved: false, reason: 'Completed owned upload fixture' }, f.operatorToken)).status, 201);
        },
      },
      async verifyRevoked(token) { assert.equal((await request(b, '/studio/summary', undefined, token)).status, 401); },
      async changeVisibility(approved, shortId = id) {
        const result = await request(b, `/review/${shortId}`, { approved, reason: 'Owned browser policy fixture' }, f.operatorToken);
        assert.equal(result.status, 201);
      },
      notify: () => owner.query('SELECT pg_notify($1,$2)', ['shorts_updated', JSON.stringify(f.scope)]),
    });
  }
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  await mkdir(workerDir); await mkdir(serverDir);
  const playbackKey = randomBytes(32).toString('hex'), edgeKey = randomBytes(32).toString('hex');
  await writeFile(join(dir, 'playback.key'), playbackKey, { mode: 0o600 });
  await writeFile(join(dir, 'edge.key'), edgeKey, { mode: 0o600 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SHORTS_|STREAM_|AWS_|REDIS_|PORT$|HOST$)/.test(key)) delete env[key];
  Object.assign(env, { NODE_ENV: 'development', DOTENV_CONFIG_PATH: '/dev/null', SHORTS_TEST_STREAMING_REPO: repo,
    STREAM_CATALOG_URL: b.base + '/shorts', STREAM_IPFS_API: `http://127.0.0.1:${proxy.address().port}/api/v0`,
    STREAM_REDIS_URL: endpoints.REDIS_URL.href, STREAM_NAMESPACE: namespace,
    STREAM_INTERNAL_KEY_FILE: join(dir, 'stream.key'), STREAM_PLAYBACK_KEY_FILE: join(dir, 'playback.key'), STREAM_EDGE_KEY_FILE: join(dir, 'edge.key'),
    ...(viewer ? { STREAM_ALLOWED_ORIGINS: viewer.origin } : {}),
    STREAM_DISK_MAX_USED_PERCENT: '99', STREAM_CATALOG_TTL_SECONDS: '2', STREAM_PLAYBACK_TTL_SECONDS: '300' });
  async function start(role) {
    const process = fork(join(__dirname, 'streaming-runtime.cjs'), [], { execArgv: [],
      env: { ...env, STREAM_ROLE: role, STREAM_CACHE_DIR: role === 'worker' ? workerDir : serverDir, PORT: role === 'worker' ? '3335' : String(streamPort) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(process); const messages = []; let output = '';
    process.on('message', value => messages.push(value));
    for (const stream of [process.stdout, process.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-8000); });
    const ready = await until(() => {
      if (process.exitCode !== null || process.signalCode !== null) throw new Error(`Streaming fixture exited: ${output}`);
      return messages.find(message => message.type === 'ready');
    }, 10000);
    return { process, base: ready.base };
  }
  async function get(url, options = {}) {
    // Origin access is restricted to the authenticated edge. Direct origin
    // probes model that trusted hop; real NGINX requests receive no test headers.
    const originHeaders = new URL(url).origin === server?.base ? {
      'X-Playback-Edge-Key': `Bearer ${edgeKey}`, 'X-Playback-Client-IP': '127.0.0.1',
    } : {};
    const response = await fetch(url, { ...options, headers: { ...originHeaders, ...options.headers }, signal: AbortSignal.timeout(15000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') };
  }
  async function dispatch() {
    await owner.query('UPDATE shorts_stream_jobs SET next_at=clock_timestamp() WHERE id=$1', [id]);
    await b.command('dispatch');
  }
  server = await start('server');
  const descriptor = (await request(b, `/playback/${id}`)).body, key = sourceKey(descriptor);
  const packageKey = `${namespace}:prepared:${key}`;
  await t.test('API outbox queues real HLS work; killed worker recovers from the default lease expiry', async () => {
    assert.equal((await get(server.base + '/readyz')).status, 503, 'no worker yet');
    assert.equal((await get(server.base + `/videos/${id}/playback`, {
      method: 'POST', headers: { 'X-Playback-Edge-Key': '' },
    })).status, 403, 'a caller cannot bypass the edge');
    await dispatch();
    assert.equal(await redis.exists(`${namespace}:prepare:${key}`), 1,
      'the API outbox must queue preparation before a viewer session can do so');
    assert.equal((await get(server.base + `/videos/${id}/playback`, { method: 'POST' })).status, 202);
    worker = await start('worker');
    await until(() => sourceHeld, 15000);
    worker.process.kill('SIGKILL'); await once(worker.process, 'exit');
    assert.equal(await redis.get(packageKey), null, 'interrupted source cannot become prepared');
    worker = await start('worker');
    // BullMQ uses its real 60s lock and stalled-job recovery interval here.
    bundle = await until(async () => { const raw = await redis.get(packageKey); return raw && JSON.parse(raw); }, 120000);
    assert.ok(bundle.files.some(file => file.name === 'init.mp4'));
    assert.ok(bundle.files.some(file => /^segment-\d{3}\.m4s$/.test(file.name)));
    await dispatch();
    const [job] = await owner.query('SELECT ready FROM shorts_stream_jobs WHERE id=$1', [id]); assert.equal(job.ready, true);
    assert.equal((await get(server.base + '/readyz')).status, 200);
    assert.equal((await get(endpoints.KUBO_API.href + '/pin/ls?arg=' + bundle.cid, { method: 'POST' })).status, 200);
  });
  await t.test('real origin serves signed HLS, byte ranges and decodable media; cold restart reuses the pin', async () => {
    const response = await get(server.base + `/videos/${id}/playback`, { method: 'POST' });
    assert.equal(response.status, 200); const session = JSON.parse(response.text);
    const manifest = await get(new URL(session.manifest, server.base)); assert.equal(manifest.status, 200);
    const segment = new URL(manifest.text.split('\n').find(line => line.startsWith('segment-')), new URL(session.manifest, server.base));
    const first = await get(segment); assert.equal(first.status, 200); assert.ok(first.bytes.length > 64);
    const range = await get(segment, { headers: { Range: 'bytes=16-63' } }); assert.equal(range.status, 206); assert.deepEqual(range.bytes, first.bytes.subarray(16, 64));
    assert.equal((await get(server.base + `/videos/${id}/video.mp4`)).status, 410);
    const unsigned = new URL(segment); unsigned.search = ''; assert.equal((await get(unsigned)).status, 401);
    try { await exec('ffmpeg', ['-nostdin', '-v', 'error', '-headers', `X-Playback-Edge-Key: Bearer ${edgeKey}\r\nX-Playback-Client-IP: 127.0.0.1\r\n`,
      '-i', new URL(session.manifest, server.base).href, '-f', 'null', '-'], { timeout: 20000, maxBuffer: 8192 }); }
    catch { assert.fail('FFmpeg could not decode the HTTP HLS stream'); }
    server.process.kill('SIGKILL'); await once(server.process, 'exit');
    worker.process.kill('SIGKILL'); await once(worker.process, 'exit');
    // Clear only this stopped origin's disposable cache, never retained media.
    await rm(serverDir, { recursive: true }); await mkdir(serverDir);
    server = await start('server');
    const restored = await get(segment); assert.equal(restored.status, 200); assert.deepEqual(restored.bytes, first.bytes);
    assert.equal(JSON.parse(await redis.get(packageKey)).cid, bundle.cid, 'no worker or retranscode needed');
  });

  let edgeSegment;
  await t.test('real NGINX edge authorizes cached segments and keeps private preparation routes inaccessible', {
    skip: !process.env.SHORTS_TEST_EDGE_IMAGE,
  }, async () => {
    edgeName = ownedEdgeName(process.env.SHORTS_TEST_EDGE_NAME || `sh-shorts-edge-${randomUUID()}`);
    const config = (await readFile(join(repo, 'edge/nginx.conf.template'), 'utf8'))
      .replaceAll('${EDGE_KEY}', edgeKey).replace('server streaming:3335;', `server host.docker.internal:${streamPort};`)
      .replace('worker_processes auto;', 'worker_processes 1;').replace('max_size=5g min_free=1g', 'max_size=64m min_free=1m');
    await writeFile(join(dir, 'nginx.conf'), config);
    await writeFile(join(dir, 'trusted-proxies.conf'), '# Test clients connect directly.\n');
    removeEdge = await startOwnedEdge(exec, edgeName, ['--user', 'nginx', '--memory', '128m',
      '--tmpfs', '/tmp:rw,size=16m,mode=1777', '--tmpfs', '/var/cache/nginx:rw,size=128m,mode=1777',
      '-p', '127.0.0.1::8080', '-v', `${join(dir, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`,
      '-v', `${join(dir, 'trusted-proxies.conf')}:/etc/nginx/trusted-proxies.conf:ro`, '--entrypoint', 'nginx',
      process.env.SHORTS_TEST_EDGE_IMAGE, '-g', 'daemon off;']);
    const { stdout } = await exec('docker', ['port', edgeName, '8080/tcp'], { timeout: 5000 });
    edgeBase = 'http://' + stdout.trim();
    await until(async () => { try { return (await get(edgeBase + '/healthz')).status === 200; } catch { return false; } }, 10000);
    const response = await get(edgeBase + `/videos/${id}/playback`, { method: 'POST' });
    assert.equal(response.status, 200); const session = JSON.parse(response.text);
    const manifest = await get(new URL(session.manifest, edgeBase)); assert.equal(manifest.status, 200);
    edgeSegment = new URL(manifest.text.split('\n').find(line => line.startsWith('segment-')), new URL(session.manifest, edgeBase));
    const first = await get(edgeSegment); assert.equal(first.status, 200);
    const hit = await get(edgeSegment); assert.equal(hit.status, 200); assert.equal(hit.headers.get('x-cache'), 'HIT'); assert.deepEqual(hit.bytes, first.bytes);
    assert.match(hit.headers.get('access-control-expose-headers'), /Retry-After/i);
    const noToken = new URL(edgeSegment); noToken.search = ''; assert.equal((await get(noToken)).status, 401);
    assert.equal((await get(edgeBase + '/internal/metrics')).status, 404);
    assert.equal((await get(edgeBase + `/videos/${id}/video.mp4`)).status, 410);
  });
  await t.test('HTTP bots cannot allocate zero-media records; identity rotation can inflate audience but never revenue', {
    skip: !edgeBase,
  }, () => assembledMeasurements(f, { edgeBase, get }));
  if (viewer) await t.test('real Chromium viewer decodes edge HLS and preserves pause, dialog and unmount behavior', () => viewer.connect(edgeBase));
  await t.test('real edge evidence qualifies analytics, rejects stolen browser proofs and respects privacy deletion', {
    skip: !edgeBase,
  }, async () => {
    const browser = randomUUID(), event = { id: randomUUID(), session: browser, seconds: 0, source: 'shared' };
    const issued = await get(edgeBase + `/videos/${id}/playback`, {
      method: 'POST', headers: { 'X-Playback-Viewer': createHash('sha256').update(browser).digest('hex') },
    });
    assert.equal(issued.status, 200);
    const session = JSON.parse(issued.text), token = new URL(session.manifest, edgeBase).searchParams.get('token');
    const receipt = async () => {
      const value = await get(edgeBase + `/videos/${id}/measurement`, { headers: { 'X-Playback-Token': token } });
      assert.equal(value.status, 200); return JSON.parse(value.text).proof;
    };
    assert.equal((await request(b, `/${id}/playback`, event)).status, 401);
    const first = await request(b, `/${id}/playback`, { ...event, proof: await receipt() }); assert.equal(first.status, 201);
    const manifest = await get(new URL(session.manifest, edgeBase));
    for (const line of manifest.text.split('\n').filter(line => line.startsWith('segment-')))
      assert.equal((await get(new URL(line, new URL(session.manifest, edgeBase)))).status, 200);
    await pause(2200);
    const proof = await receipt();
    assert.equal((await request(b, `/${id}/playback`, { ...event, session: randomUUID(), seconds: 2.2, proof })).status, 401);
    const watched = await request(b, `/${id}/playback`, { ...event, seconds: 2.2, proof });
    assert.equal(watched.status, 201); assert.equal(watched.body.views, first.body.views + 1);
    const replayed = await request(b, `/${id}/playback`, { ...event, seconds: 2.2, proof });
    assert.equal(replayed.body.views, watched.body.views);
    assert.equal((await request(b, '/analytics/forget', { session: browser })).status, 201);
    const forgotten = await request(b, `/${id}/playback`, { ...event, seconds: 2.2, proof: await receipt() });
    assert.equal(forgotten.status, 201); assert.equal(forgotten.body.accepted, false);
  });
  if (viewer) await t.test('actual app routes use the real feed, saved selection, playback and Studio navigation', () => viewer.application());
  if (viewer) await t.test('actual App wallet RPC drives Studio, upload recovery and isolated social feed reads', () => viewer.creator());
  if (viewer) await t.test('multi-video app navigation pages the catalog and bounds live media sources', async () => {
    const catalog = await f.catalog();
    // The cold-restart scenario stopped the worker. New IDs must go through
    // actual preparation; do not copy an existing package into the cache.
    worker = await start('worker');
    try { await viewer.multiple(catalog.ids); } finally { await catalog.close(); }
  });
  if (process.env.SHORTS_TEST_CAPACITY === '1') await t.test('multi-video HTTP load reports preparation, edge backpressure and recovery', async () => {
    assert.ok(edgeBase, 'capacity integration requires the real edge');
    if (worker && worker.process.exitCode === null && worker.process.signalCode === null) {
      worker.process.kill('SIGTERM'); await once(worker.process, 'exit');
    }
    await assembledCapacity(t, f, { repo, edgeBase, startWorker: async () => { worker = await start('worker'); }, metrics: async () => {
      const credential = (await readFile(join(dir, 'stream.key'), 'utf8')).trim();
      const response = await get(server.base + '/internal/metrics', { headers: { Authorization: `Bearer ${credential}` } });
      assert.equal(response.status, 200); return JSON.parse(response.text);
    } });
  });
  if (process.env.SHORTS_TEST_VARIED_HLS === '1') await t.test('distinct uploaded media publish through the API journal, decode as HLS and revoke independently on cache hits', async () => {
    assert.ok(edgeBase && f.uploaded?.length === 4, 'varied HLS requires the upload-load and real-edge fixtures');
    if (!worker || worker.process.exitCode !== null || worker.process.signalCode !== null) worker = await start('worker');
    await assembledVariedHls(t, f, { repo, edgeBase, get,
      async prepared(shortId) {
        const result = await request(b, `/playback/${shortId}`); assert.equal(result.status, 200);
        const raw = await redis.get(`${namespace}:prepared:${sourceKey(result.body)}`);
        return raw && JSON.parse(raw);
      },
      async metrics() {
        const credential = (await readFile(join(dir, 'stream.key'), 'utf8')).trim();
        const result = await get(server.base + '/internal/metrics', { headers: { Authorization: `Bearer ${credential}` } });
        assert.equal(result.status, 200); return JSON.parse(result.text);
      },
    });
  });
  return {
    async denied(reason) {
      // Fixed 2s test policy (production default is 15s); do not erase cache keys.
      await pause(2100);
      assert.equal((await get(server.base + `/videos/${id}/playback`, { method: 'POST' })).status, 404, reason);
      if (edgeSegment) { const denied = await get(edgeSegment); assert.equal(denied.status, 403, reason); assert.ok(!denied.headers.has('x-cache')); }
      await viewer?.denied();
    },
    async restored() {
      await pause(2100);
      assert.equal((await get(server.base + `/videos/${id}/playback`, { method: 'POST' })).status, 200);
      if (edgeSegment) { const hit = await get(edgeSegment); assert.equal(hit.status, 200); assert.equal(hit.headers.get('x-cache'), 'HIT'); }
      await viewer?.restored();
    },
    close,
  };
};
