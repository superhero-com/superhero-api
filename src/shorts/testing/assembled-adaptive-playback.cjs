// Original-format integration through the actual hosted API, BullMQ workers,
// streaming server, NGINX and browser. External chain/safety inputs are controlled
// by the enclosing fixture; media preparation, storage and authorization are real.
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
const { ownedEdgeName, startOwnedEdge } = require('./owned-edge.cjs');
const exec = promisify(execFile);

exports.assembledAdaptivePlayback = async (t, f) => {
  const { dir, endpoints, streamPort, id, b, owner, until, pause, request, video } = f;
  const repo = process.env.SHORTS_TEST_STREAMING_REPO;
  assert.ok(isAbsolute(repo));
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).name, 'superhero-video-streaming');
  const { sourceKey, validateSourcePackage } = require(join(repo, 'dist/streaming/hls-package'));
  const { parseMaster } = require(join(repo, 'dist/streaming/hls-adaptive'));
  const namespace = `adaptive-${randomUUID()}`, children = [], sockets = new Set(), ownedPins = new Set();
  const redis = new Redis(endpoints.REDIS_URL.href);
  const workerDir = join(dir, 'adaptive-worker'), serverDir = join(dir, 'adaptive-server');
  const edgeKey = randomBytes(32).toString('hex');
  let server, worker, viewer, removeEdge, edgeBase, sourceHeld = false, closed = false, edgeSegment, pinWrites = 0;
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url, endpoints.KUBO_API.origin);
    if (req.method === 'POST' && ['/api/v0/add', '/api/v0/pin/add'].includes(url.pathname)) pinWrites++;
    const upstream = http.request(url, { method: req.method, headers: { ...req.headers, host: url.host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      if (!sourceHeld && url.pathname === '/api/v0/cat' && url.searchParams.get('arg')?.endsWith('/video-1080.mp4')) {
        response.once('data', bytes => { sourceHeld = true; response.pause(); res.write(bytes.subarray(0, 64)); });
      } else response.pipe(res);
    });
    upstream.on('error', () => res.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
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
    for (const key of keys.filter(key => key.startsWith(namespace + ':prepared:'))) {
      const value = await redis.get(key); if (value) ownedPins.add(JSON.parse(value).cid);
    }
    if (keys.length) await redis.del(...keys); redis.disconnect();
    for (const cid of ownedPins) {
      const response = await fetch(endpoints.KUBO_API.href + '/pin/rm?arg=' + cid, { method: 'POST', signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
    }
  };
  t.after(close);
  if (process.env.SHORTS_TEST_WEB_REPO) {
    assert.ok(process.env.SHORTS_TEST_EDGE_IMAGE, 'Browser integration requires the real edge');
    viewer = await assembledBrowser(t, { id, api: b.base, port: f.webPort, release: f.release, adaptive: true });
  }
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); await mkdir(workerDir); await mkdir(serverDir);
  await writeFile(join(dir, 'playback.key'), randomBytes(32).toString('hex'), { mode: 0o600 });
  await writeFile(join(dir, 'edge.key'), edgeKey, { mode: 0o600 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SHORTS_|STREAM_|AWS_|REDIS_|PORT$|HOST$)/.test(key)) delete env[key];
  Object.assign(env, { NODE_ENV: 'development', DOTENV_CONFIG_PATH: '/dev/null', SHORTS_TEST_STREAMING_REPO: repo,
    STREAM_CATALOG_URL: b.base + '/shorts', STREAM_IPFS_API: `http://127.0.0.1:${proxy.address().port}/api/v0`,
    STREAM_REDIS_URL: endpoints.REDIS_URL.href, STREAM_NAMESPACE: namespace,
    STREAM_INTERNAL_KEY_FILE: join(dir, 'stream.key'), STREAM_PLAYBACK_KEY_FILE: join(dir, 'playback.key'), STREAM_EDGE_KEY_FILE: join(dir, 'edge.key'),
    ...(viewer ? { STREAM_ALLOWED_ORIGINS: viewer.origin } : {}),
    STREAM_DISK_MAX_USED_PERCENT: '99', STREAM_CATALOG_TTL_SECONDS: '2', STREAM_PLAYBACK_TTL_SECONDS: '30', STREAM_VERSIONED_MEASUREMENTS: 'true' });
  const start = async role => {
    const child = fork(join(__dirname, 'streaming-runtime.cjs'), [], { execArgv: [],
      env: { ...env, STREAM_ROLE: role, STREAM_CACHE_DIR: role === 'worker' ? workerDir : serverDir, PORT: role === 'worker' ? '3335' : String(streamPort) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); let output = ''; const messages = [];
    child.on('message', value => messages.push(value));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-8000); });
    const ready = await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Streaming fixture exited: ${output}`);
      return messages.find(message => message.type === 'ready');
    }, 15000);
    return { process: child, base: ready.base };
  };
  const get = async (url, options = {}) => {
    const headers = new URL(url).origin === server?.base ? { 'X-Playback-Edge-Key': `Bearer ${edgeKey}`, 'X-Playback-Client-IP': '127.0.0.1' } : {};
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') };
  };
  const dispatch = async () => {
    await owner.query('UPDATE shorts_stream_jobs SET next_at=clock_timestamp() WHERE id=$1', [id]); await b.command('dispatch');
  };
  const session = async (base, headers) => {
    const result = await get(`${base}/videos/${id}/playback`, { method: 'POST', headers }); assert.equal(result.status, 200, result.text);
    return new URL(JSON.parse(result.text).manifest, base);
  };
  const playlist = async url => {
    const result = await get(url); assert.equal(result.status, 200); return result.text;
  };
  const graph = async manifest => {
    const master = await playlist(manifest);
    const lists = [...master.split('\n').filter(line => line && !line.startsWith('#')),
      ...[...master.matchAll(/#EXT-X-MEDIA:[^\n]*URI="([^"]+)"/g)].map(match => match[1])].map(path => new URL(path, manifest));
    assert.equal(lists.length, 7); const assets = [];
    for (const list of lists) {
      const text = await playlist(list);
      for (const path of [...text.split('\n').filter(line => line && !line.startsWith('#')), ...[...text.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map(match => match[1])])
        assets.push(new URL(path, list));
    }
    return { lists, assets };
  };
  server = await start('server');
  const descriptorResponse = await request(b, `/playback/${id}`); assert.equal(descriptorResponse.status, 200);
  const descriptor = descriptorResponse.body, key = sourceKey(descriptor), packageKey = `${namespace}:prepared:${key}`;
  const health = await request(b, '/health/playback'); assert.equal(health.status, 200, JSON.stringify(health.body));
  const unprepared = await request(b, `/playback/${id}/prepared/${key}`);
  assert.equal(unprepared.status, 404, JSON.stringify(unprepared.body));
  const original = await get(endpoints.KUBO_API.href + '/cat?arg=' + descriptor.cid, { method: 'POST' });
  assert.equal(original.status, 200); assert.deepEqual(original.bytes, video); assert.equal(descriptor.bytes, video.length);
  let bundle;
  await t.test('original-derived HLS survives a killed streaming worker and gets acknowledged by the API outbox', async () => {
    assert.equal((await get(server.base + `/videos/${id}/playback`, { method: 'POST', headers: { 'X-Playback-Edge-Key': '' } })).status, 403);
    await dispatch(); assert.equal(await redis.exists(`${namespace}:prepare:${key}`), 1);
    assert.equal((await get(server.base + `/videos/${id}/playback`, { method: 'POST' })).status, 202);
    worker = await start('worker'); await until(() => sourceHeld, 20000);
    worker.process.kill('SIGKILL'); await once(worker.process, 'exit'); assert.equal(await redis.get(packageKey), null);
    worker = await start('worker');
    bundle = await until(async () => { const value = await redis.get(packageKey); return value && JSON.parse(value); }, 150000);
    ownedPins.add(bundle.cid); validateSourcePackage(descriptor, bundle); assert.equal(bundle.version, 3);
    const master = parseMaster(bundle.playlist); assert.equal(master.videos.length, 5); assert.equal(master.audio.length, 2);
    assert.deepEqual([master.videos[0].width, master.videos[0].height, master.videos[0].frameRate], [1080, 1920, 60]);
    await dispatch();
    assert.equal((await owner.query('SELECT ready FROM shorts_stream_jobs WHERE id=$1', [id]))[0].ready, true);
    const [saved] = await owner.query('SELECT prepared FROM shorts_delivery_packages WHERE short_id=$1 AND source_key=$2', [id, key]);
    assert.equal(saved.prepared.cid, bundle.cid);
  });
  await t.test('real streaming HTTP serves every adaptive asset and range, then restores the same pin after cold restart', async () => {
    const manifest = await session(server.base), { lists, assets } = await graph(manifest);
    const file = assets.find(url => url.pathname.endsWith('v1080-segment-000.m4s'));
    const first = await get(file); assert.equal(first.status, 200);
    const range = await get(file, { headers: { Range: 'bytes=16-63' } }); assert.equal(range.status, 206); assert.deepEqual(range.bytes, first.bytes.subarray(16, 64));
    for (const url of [manifest, ...lists, ...assets]) {
      const unsigned = new URL(url); unsigned.search = ''; assert.equal((await get(unsigned)).status, 401);
      const response = await get(url); assert.equal(response.status, 200);
      const metadata = bundle.files.find(item => item.name === url.pathname.split('/').at(-1));
      if (metadata && !url.pathname.endsWith('.m3u8')) assert.equal(createHash('sha256').update(response.bytes).digest('hex'), metadata.sha256);
    }
    try {
      const result = await exec('ffprobe', ['-v','error','-headers',`X-Playback-Edge-Key: Bearer ${edgeKey}\r\nX-Playback-Client-IP: 127.0.0.1\r\n`,
        '-show_streams','-of','json',manifest.href], { timeout: 30000, maxBuffer: 65536 });
      const streams = JSON.parse(result.stdout).streams;
      assert.ok(streams.some(stream => stream.width === 1080 && stream.height === 1920 && stream.r_frame_rate === '60/1'));
      assert.ok(streams.some(stream => stream.codec_type === 'audio'));
    } catch { assert.fail('Cannot probe the real adaptive HTTP stream'); }
    worker.process.kill('SIGKILL'); await once(worker.process, 'exit'); server.process.kill('SIGKILL'); await once(server.process, 'exit');
    await rm(serverDir, { recursive: true }); await mkdir(serverDir); server = await start('server');
    const restored = await get(file); assert.equal(restored.status, 200); assert.deepEqual(restored.bytes, first.bytes);
    assert.equal(JSON.parse(await redis.get(packageKey)).cid, bundle.cid);
    assert.equal((await get(`${server.base}/videos/${id}/video.mp4`)).status, 410);
  });
  await t.test('NGINX authorizes all adaptive playlists and cache hits, and signed URLs genuinely expire', { skip: !process.env.SHORTS_TEST_EDGE_IMAGE }, async () => {
    const name = ownedEdgeName(`sh-shorts-edge-${randomUUID()}`);
    const template = await readFile(join(repo, 'edge/nginx.conf.template'), 'utf8');
    assert.match(template, /server streaming:3335(?: resolve)?;/);
    const config = template.replaceAll('${EDGE_KEY}', edgeKey).replace(/server streaming:3335(?: resolve)?;/, `server host.docker.internal:${streamPort};`)
      .replace('worker_processes auto;', 'worker_processes 1;').replace('max_size=5g min_free=1g', 'max_size=64m min_free=1m');
    // The parent fixture directory is private; only these files are mounted
    // read-only for the container's unprivileged nginx user.
    await writeFile(join(dir, 'nginx.conf'), config, { mode: 0o644 }); await writeFile(join(dir, 'trusted-proxies.conf'), '# Owned direct-client fixture.\n');
    removeEdge = await startOwnedEdge(exec, name, ['--user','nginx','--memory','128m','--tmpfs','/tmp:rw,size=16m,mode=1777',
      '--tmpfs','/var/cache/nginx:rw,size=128m,mode=1777','-p','127.0.0.1::8080',
      '-v',`${join(dir,'nginx.conf')}:/etc/nginx/nginx.conf:ro`,'-v',`${join(dir,'trusted-proxies.conf')}:/etc/nginx/trusted-proxies.conf:ro`,
      '--entrypoint','nginx',process.env.SHORTS_TEST_EDGE_IMAGE,'-g','daemon off;']);
    edgeBase = 'http://' + (await exec('docker',['port',name,'8080/tcp'],{ timeout:5000 })).stdout.trim();
    await until(async () => { try { return (await get(edgeBase + '/healthz')).status === 200; } catch { return false; } }, 10000);
    const manifest = await session(edgeBase), { lists, assets } = await graph(manifest);
    for (const url of [manifest, ...lists, ...assets]) {
      const unsigned = new URL(url); unsigned.search = ''; assert.equal((await get(unsigned)).status, 401);
      const first = await get(url); assert.equal(first.status, 200);
      if (url.pathname.endsWith('.mp4') || url.pathname.endsWith('.m4s')) {
        const hit = await get(url); assert.equal(hit.status, 200); assert.equal(hit.headers.get('x-cache'), 'HIT'); assert.deepEqual(hit.bytes, first.bytes);
      }
      await pause(200);
    }
    edgeSegment = assets.find(url => url.pathname.endsWith('v1080-segment-000.m4s'));
    assert.equal((await get(edgeBase + '/internal/metrics')).status, 404);
    assert.equal((await get(`${edgeBase}/videos/${id}/video.mp4`)).status, 410);
    // Use real expiry; expiry is not weakened or forged in the fixture.
    await pause(31000);
    assert.equal((await get(manifest)).status, 401); assert.equal((await get(edgeSegment)).status, 401);
    // Subsequent withdrawal checks need a still-valid token, independently of
    // the expiry case. Restart with the normal five-minute session lifetime.
    server.process.kill('SIGTERM'); await once(server.process, 'exit');
    env.STREAM_PLAYBACK_TTL_SECONDS = '300'; server = await start('server');
    const renewed = await graph(await session(edgeBase)); edgeSegment = renewed.assets.find(url => url.pathname.endsWith('v1080-segment-000.m4s'));
    assert.equal((await get(edgeSegment)).headers.get('x-cache'), 'HIT');
  });
  await t.test('adaptive rendition changes and request retries count one measured view', { skip: !edgeBase }, async () => {
    const event = { id: randomUUID(), session: randomUUID(), seconds: 0, source: 'shared' };
    const manifest = await session(edgeBase, { 'X-Playback-Viewer': createHash('sha256').update(event.session).digest('hex') });
    const token = manifest.searchParams.get('token');
    const proof = async () => {
      const result = await get(`${edgeBase}/videos/${id}/measurement`, { headers: { 'X-Playback-Token': token } });
      assert.equal(result.status, 200); return JSON.parse(result.text).proof;
    };
    const initial = await request(b, `/${id}/playback`, { ...event, proof: await proof() }); assert.equal(initial.status, 201);
    const { assets } = await graph(manifest);
    // The same video time in two renditions must not be counted twice. The
    // separate audio track is fetched too, and cannot inflate watched time.
    for (const url of assets.filter(url => /\/(v1080|v360|amain)-/.test(url.pathname))) {
      assert.equal((await get(url)).status, 200); await pause(100);
    }
    await pause(2200);
    const evidence = await proof();
    assert.equal((await request(b, `/${id}/playback`, { ...event, session: randomUUID(), seconds: 2.2, proof: evidence })).status, 401);
    const watched = await request(b, `/${id}/playback`, { ...event, seconds: 2.2, proof: evidence }); assert.equal(watched.status, 201);
    assert.equal(watched.body.views, initial.body.views + 1);
    for (const next of [event.id, randomUUID()]) {
      const retry = await request(b, `/${id}/playback`, { ...event, id: next, seconds: 2.2, proof: evidence });
      assert.equal(retry.status, 201); assert.equal(retry.body.views, watched.body.views);
    }
  });
  if (viewer) await t.test('the actual web player switches original-derived quality with audio and preserves playback controls', () => viewer.connect(edgeBase));
  if (edgeBase) await require('./assembled-generations.cjs').assembledGenerations(t, f, {
    viewer, edgeBase, get, session, graph, sourceKey,
    async startWorker() { worker = await start('worker'); },
    async recoverIndex(source, playback) {
      assert.match(source, /^[a-f0-9]{64}$/);
      const index = `${namespace}:prepared:${source}`, job = `${namespace}:prepare:${source}`;
      const prepared = JSON.parse(await redis.get(index)); assert.ok(prepared?.cid);
      ownedPins.add(prepared.cid);
      await until(async () => !(await redis.exists(job)), 10000);
      const writes = pinWrites;
      assert.equal(await redis.del(index), 1);
      await playback();
      // SQL acknowledgements canonically sort the inventory. Preserve every
      // file, digest and playlist without treating inventory order as content.
      const inventory = value => ({ ...value, files: [...value.files].sort((a, b) => a.name.localeCompare(b.name)) });
      assert.deepEqual(inventory(JSON.parse(await redis.get(index))), inventory(prepared));
      assert.equal(await redis.exists(job), 0, 'retained playback does not enqueue media preparation');
      assert.equal(pinWrites, writes, 'index recovery does not publish another HLS package');
    },
  });
  return {
    async denied(reason) {
      await pause(2100);
      assert.equal((await get(`${server.base}/videos/${id}/playback`, { method: 'POST' })).status, 404, reason);
      if (edgeSegment) {
        const response = await get(edgeSegment); assert.equal(response.status, 403, reason); assert.equal(response.headers.has('x-cache'), false);
      }
      await viewer?.denied();
    },
    async restored() {
      await pause(2100); assert.equal((await get(`${server.base}/videos/${id}/playback`, { method: 'POST' })).status, 200);
      if (edgeBase) {
        const next = await graph(await session(edgeBase)); edgeSegment = next.assets.find(url => url.pathname.endsWith('v1080-segment-000.m4s'));
        const hit = await get(edgeSegment); assert.equal(hit.status, 200); assert.equal(hit.headers.get('x-cache'), 'HIT');
      }
      await viewer?.restored();
    }, close,
  };
};
