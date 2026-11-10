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
const { ShortsHostedUploadsService: ShortsUploadsService } = require('./shorts-hosted-uploads.service');

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

test('raw video routes authenticate and reject without waiting for the request body', async t => {
  const auth = { authenticate: async token => {
    if (token !== 'Bearer valid-test-session') throw new UnauthorizedException();
    return 'creator';
  } };
  const app = await NestFactory.create({ module: class UploadTestModule {},
    controllers: [ShortsController], providers: [ShortsAuthGuard, ShortsUploadInterceptor,
      { provide: ShortsAuthService, useValue: auth }, { provide: ShortsService, useValue: {} },
    ],
  }, { logger: false });
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const base = await app.getUrl();
  for (const route of ['/shorts/upload', '/shorts/uploads/upload-id/parts/0']) {
    for (const [authorization, expected] of [[undefined, 401], ['Bearer expired-test-session', 401], ['Bearer valid-test-session', 400]]) {
      const status = await new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': '40000000' };
        if (authorization) headers.Authorization = authorization;
        const req = request(base + route, { method: 'POST', headers }, res => {
          res.resume(); resolve(res.statusCode); req.destroy();
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('Server waited for an unsupported upload body')));
        req.flushHeaders();
      });
      assert.equal(status, expected);
    }
  }
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
      { provide: ShortsUploadsService, useValue: { get: forbidden, health: forbidden, finish: forbidden, create: forbidden } },
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
