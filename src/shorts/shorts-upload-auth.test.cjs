const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request } = require('node:http');
const { NestFactory } = require('@nestjs/core');
const { UnauthorizedException } = require('@nestjs/common');
const { ShortsController } = require('./shorts.controller');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsAuthGuard } = require('./shorts-auth.guard');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const { ShortsService } = require('./shorts.service');
const { ShortsUploadsService } = require('./shorts-uploads.service');

test('invalid upload admission settings cannot disable capacity or receive deadlines', () => {
  for (const [key, invalid] of [
    ['SHORTS_CONCURRENT_UPLOADS', ['0', '9', 'NaN', '1.5', '']],
    ['SHORTS_UPLOAD_BODY_TIMEOUT_MS', ['0', '300001', 'Infinity', '0.1']],
    ['SHORTS_UPLOAD_OPERATION_TIMEOUT_MS', ['0', '600001', 'Infinity', '0.1']],
  ]) {
    const previous = process.env[key];
    try {
      for (const value of invalid) {
        process.env[key] = value;
        assert.throws(() => new ShortsUploadInterceptor({}), new RegExp(key));
      }
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  }
});

test('multipart authentication rejects missing and expired sessions before reading a slow body', async t => {
  let prepared = 0;
  const auth = { authenticate: async token => {
    if (token !== 'Bearer valid-test-session') throw new UnauthorizedException();
    return 'creator';
  } };
  const shorts = { chain: { serial: fn => fn() }, upload: async () => { prepared++; return { id: 'uploaded' }; } };
  const app = await NestFactory.create({ module: class UploadTestModule {},
    controllers: [ShortsController], providers: [ShortsAuthGuard, ShortsUploadInterceptor,
      { provide: ShortsAuthService, useValue: auth }, { provide: ShortsService, useValue: shorts },
      { provide: ShortsUploadsService, useValue: { part: async () => { prepared++; return {}; } } },
    ],
  }, { logger: false });
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const base = await app.getUrl();
  for (const route of ['/shorts/upload', '/shorts/uploads/upload-id/parts/0']) {
    for (const authorization of [undefined, 'Bearer expired-test-session']) {
      const status = await new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': '40000000' };
        if (authorization) headers.Authorization = authorization;
        const req = request(base + route, { method: 'POST', headers }, res => {
          res.resume(); resolve(res.statusCode); req.destroy();
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('Server waited for an unauthenticated upload body')));
        req.flushHeaders(); // Never send the body: a guard must reject immediately.
      });
      assert.equal(status, 401);
    }
    const malformed = await fetch(base + route, { method: 'POST',
      headers: { Authorization: 'Bearer valid-test-session', 'Content-Type': 'multipart/form-data; boundary=test' }, body: 'malformed',
    });
    assert.equal(malformed.status, 400, 'authenticated requests still run multipart validation');
  }
  assert.equal(prepared, 0);
  const part = new FormData(); part.append('file', new Blob(['owned bytes']), 'part');
  const valid = await fetch(base + '/shorts/uploads/upload-id/parts/0', {
    method: 'POST', headers: { Authorization: 'Bearer valid-test-session' }, body: part,
  });
  assert.equal(valid.status, 201); assert.equal(prepared, 1);
});

test('every private controller action waits for asynchronous creator or operator authentication', async t => {
  const authenticate = async () => { await new Promise(resolve => setImmediate(resolve)); throw new UnauthorizedException(); };
  let effects = 0;
  const forbidden = () => { effects++; throw new Error('Private action ran before authentication'); };
  const app = await NestFactory.create({ module: class PrivateAuthTestModule {}, controllers: [ShortsController],
    providers: [ShortsAuthGuard, ShortsUploadInterceptor,
      { provide: ShortsAuthService, useValue: { authenticate, operator: authenticate } },
      { provide: ShortsService, useValue: { dashboard: forbidden, performance: forbidden, item: forbidden,
        records: { all: forbidden }, chain: { serial: forbidden }, media: { preview: forbidden } } },
      { provide: ShortsUploadsService, useValue: { get: forbidden, health: forbidden, finish: forbidden, enqueueFile: forbidden } },
    ],
  }, { logger: false });
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const base = await app.getUrl();
  for (const [method, paths] of [
    ['GET', ['/dashboard', '/performance', '/review', '/review-media/id', '/uploads/id', '/operator/ingestion']],
    ['POST', ['/uploads', '/uploads/id/parts/0', '/uploads/id/parts/0/prepare', '/uploads/id/parts/0/authorize', '/uploads/id/parts/0/complete', '/uploads/id/finish', '/upload', '/review/id', '/id/scan', '/id/appeal', '/id/publish', '/receipt']],
  ]) for (const path of paths) {
    const response = await fetch(`${base}/shorts${path}`, { method,
      headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    await response.arrayBuffer(); assert.equal(response.status, 401, path);
  }
  assert.equal(effects, 0);
});


function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { resolve, promise };
}

async function uploadFixture(t, { timeout = 120000, prepare } = {}) {
  const seen = new Map();
  let prepared = 0;
  const auth = { authenticate: async token => {
    if (!/^Bearer creator-[1-4]$/.test(token || '')) throw new UnauthorizedException();
    const actor = token.slice(7);
    if (!seen.has(actor)) seen.set(actor, deferred());
    setImmediate(() => seen.get(actor).resolve());
    return actor;
  } };
  const run = async () => { prepared++; if (prepare) await prepare(); return { id: 'uploaded', moderation: 'pending' }; };
  const previous = process.env.SHORTS_UPLOAD_BODY_TIMEOUT_MS;
  process.env.SHORTS_UPLOAD_BODY_TIMEOUT_MS = String(timeout);
  const app = await NestFactory.create({ module: class AdmissionTestModule {},
    controllers: [ShortsController], providers: [ShortsAuthGuard, ShortsUploadInterceptor,
      { provide: ShortsAuthService, useValue: auth },
      { provide: ShortsService, useValue: { chain: { serial: fn => fn() }, upload: run } },
      { provide: ShortsUploadsService, useValue: { part: run, finish: run } },
    ],
  }, { logger: false });
  if (previous === undefined) delete process.env.SHORTS_UPLOAD_BODY_TIMEOUT_MS;
  else process.env.SHORTS_UPLOAD_BODY_TIMEOUT_MS = previous;
  const requests = [];
  await app.listen(0, '127.0.0.1');
  t.after(async () => { for (const req of requests) req.destroy(); await app.close(); });
  const base = await app.getUrl();
  function open(route, actor, partial = false) {
    if (!seen.has(actor)) seen.set(actor, deferred());
    const result = deferred(), closed = deferred();
    const req = request(base + route, { method: 'POST', headers: {
      Authorization: `Bearer ${actor}`,
      'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': '40000000',
    } }, res => { res.resume(); result.resolve(res.statusCode); req.destroy(); });
    req.on('error', () => result.resolve('closed'));
    req.on('close', () => closed.resolve());
    req.setTimeout(3000, () => { result.resolve('test-timeout'); req.destroy(); });
    req.flushHeaders();
    if (partial) req.write('--test\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\npartial bytes');
    requests.push(req);
    return { req, result: result.promise, closed: closed.promise, seen: seen.get(actor).promise };
  }
  async function complete(route, actor) {
    const body = new FormData(); body.append('file', new Blob(['owned bytes']), 'part');
    const response = await fetch(base + route, {
      method: 'POST', headers: { Authorization: `Bearer ${actor}` }, body,
    });
    await response.arrayBuffer();
    return response.status;
  }
  return { open, complete, base, count: () => prepared };
}

test('upload capacity rejects a second wallet request and a saturated instance before consuming bodies; aborted parsing frees capacity', { timeout: 10000 }, async t => {
  const f = await uploadFixture(t);
  const partRoute = '/shorts/uploads/upload-id/parts/0';
  const first = f.open('/shorts/upload', 'creator-1', true); await first.seen;
  const same = f.open(partRoute, 'creator-1');
  assert.equal(await same.result, 429);
  const second = f.open(partRoute, 'creator-2', true); await second.seen;
  const third = f.open('/shorts/upload', 'creator-3');
  assert.equal(await third.result, 503);
  assert.equal(f.count(), 0);
  first.req.destroy(); second.req.destroy();
  await Promise.all([first.closed, second.closed]);
  // Disconnect delivery and parser cleanup settle on the server asynchronously.
  let recovered;
  for (let attempt = 0; attempt < 20; attempt++) {
    recovered = await f.complete(partRoute, 'creator-1');
    if (recovered === 201) break;
    assert.ok([429, 503].includes(recovered));
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(recovered, 201);
  assert.equal(f.count(), 1);
});

test('a slow multipart body is disconnected at its deadline without starting video preparation', { timeout: 10000 }, async t => {
  const f = await uploadFixture(t, { timeout: 1000 });
  const held = f.open('/shorts/upload', 'creator-1', true);
  assert.equal(await held.result, 'closed');
  assert.equal(f.count(), 0);
  assert.equal(await f.complete('/shorts/uploads/upload-id/parts/0', 'creator-1'), 201);
});

test('client disconnect after multipart receipt does not free its slot while its write is still running', { timeout: 10000 }, async t => {
  const gate = deferred(), started = deferred();
  t.after(() => gate.resolve());
  const f = await uploadFixture(t, { prepare: async () => { started.resolve(); await gate.promise; } });
  const abort = new AbortController();
  const part = new FormData(); part.append('file', new Blob(['owned bytes']), 'part');
  const operation = fetch(f.base + '/shorts/uploads/upload-id/parts/0', {
    method: 'POST', headers: { Authorization: 'Bearer creator-1' }, body: part, signal: abort.signal,
  }).catch(() => undefined);
  await started.promise;
  abort.abort(); await operation;
  const duplicate = f.open('/shorts/upload', 'creator-1');
  assert.equal(await duplicate.result, 429, 'disconnection must not admit overlapping processing');
  assert.equal(f.count(), 1);
  gate.resolve();
});
