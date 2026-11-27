require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { createHttpHeaders } = require('@azure/core-rest-pipeline');
const {
  AccountMemory,
  AeSdk,
  Contract,
  encode,
  Encoding,
  Tag,
  unpackTx,
} = require('@aeternity/aepp-sdk');
const {
  ContractByteArrayEncoder,
  TypeResolver,
} = require('@aeternity/aepp-calldata');
const { ShortsNodeAccessService } = require('./shorts-node-access.service');
const { ShortsChainService } = require('./shorts-chain.service');
const { ShortsWorkQueueService } = require('./shorts-work-queue.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsPrivateMediaService } = require('./shorts-private-media.service');
const { ShortsSafetyService } = require('./shorts-safety.service');
const { ShortsLabelsService } = require('./shorts-labels.service');
const {
  ShortsHostedHostingService,
} = require('./shorts-hosted-hosting.service');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(5);
  }
  assert.fail('Expected local fixture event');
}
async function serverFor(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const request = (url, overrides = {}) => ({
  url,
  method: 'GET',
  headers: createHttpHeaders(),
  ...overrides,
});

test('read-only node transport rejects broadcast, other origins, redirects and unsafe bodies', async (t) => {
  const calls = [];
  const { origin } = await serverFor(t, (req, res) => {
    calls.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    if (req.url === '/v3/redirect') {
      res.writeHead(302, { location: '/v3/ok' });
      res.end();
    } else res.end('{"ok":true}');
  });
  const access = new ShortsNodeAccessService(),
    client = access.transport(origin);
  for (const value of [
    request('https://other.example/v3/status'),
    request(origin + '/v2/status'),
    request(origin + '/v3/status', { method: 'DELETE' }),
    request(origin + '/v3/transactions', { method: 'POST', body: '{}' }),
    request(origin + '/v3/dry-run', {
      method: 'POST',
      body: 'é'.repeat(66000),
    }),
  ])
    await assert.rejects(client.sendRequest(value), /authority|too large/);
  assert.deepEqual(calls, []);
  await assert.rejects(client.sendRequest(request(origin + '/v3/redirect')));
  assert.deepEqual(calls, ['/v3/redirect']);
  assert.equal(
    (
      await client.sendRequest(
        request(origin + '/v3/status', {
          headers: createHttpHeaders({ authorization: 'must-not-forward' }),
        }),
      )
    ).bodyAsText,
    '{"ok":true}',
  );
  const sdkNode = access.createNode(origin);
  assert.equal(
    sdkNode.pipeline
      .getOrderedPolicies()
      .some((p) => p.name === 'combine-get-requests'),
    false,
  );
  // Explicit local compatibility only; the hosted API never selects this transport mode.
  assert.equal(
    (
      await access.transport(origin, true).sendRequest(
        request(origin + '/v3/transactions', {
          method: 'POST',
          body: '{"tx":"owned-fixture-only"}',
        }),
      )
    ).status,
    200,
  );
  access.onModuleDestroy();
  const count = calls.length;
  await assert.rejects(client.sendRequest(request(origin + '/v3/status')), {
    status: 503,
  });
  assert.equal(calls.length, count);
});

test('production cannot enable the local transaction-submission transport', (t) => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (old === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = old;
  });
  const access = new ShortsNodeAccessService();
  assert.throws(
    () => access.createNode('https://node.example', true),
    /unavailable in production/,
  );
  assert.throws(() => access.createNode('http://127.0.0.1'), /Invalid/);
  assert.doesNotThrow(() => access.createNode('https://node.example'));
  access.onModuleDestroy();
});

test(
  'node request admission is bounded, releases on cancellation, and has no implicit retries',
  { timeout: 10000 },
  async (t) => {
    const pending = [];
    let calls = 0,
      failStatus = false;
    const { origin } = await serverFor(t, (req, res) => {
      calls++;
      if (req.url === '/v3/fail' || (failStatus && req.url === '/v3/status')) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      res.writeHead(200);
      res.write('{');
      pending.push(res);
    });
    const access = new ShortsNodeAccessService(),
      client = access.transport(origin),
      controllers = Array.from({ length: 16 }, () => new AbortController());
    const results = controllers.map((c) =>
      client
        .sendRequest(request(origin + '/v3/hold', { abortSignal: c.signal }))
        .catch((e) => e),
    );
    await eventually(() => pending.length === 16);
    await assert.rejects(client.sendRequest(request(origin + '/v3/hold')), {
      status: 503,
    });
    assert.equal(calls, 16);
    controllers[0].abort();
    assert.equal((await results[0]).status, 503);
    const extraController = new AbortController(),
      extra = client
        .sendRequest(
          request(origin + '/v3/hold', { abortSignal: extraController.signal }),
        )
        .catch((e) => e);
    await eventually(() => pending.length === 17);
    extraController.abort();
    assert.equal((await extra).status, 503);
    for (let i = 1; i < 16; i++) pending[i].end('"ok":true}');
    for (const outcome of (await Promise.all(results)).slice(1))
      assert.equal(outcome.bodyAsText, '{"ok":true}');
    assert.equal(
      (await client.sendRequest(request(origin + '/v3/fail'))).status,
      503,
    );
    assert.equal(calls, 18);
    failStatus = true;
    await assert.rejects(access.createNode(origin).getStatus());
    assert.equal(
      calls,
      19,
      'the real SDK must not retry a failed node response',
    );
    assert.equal(access.activeRequests, 0);
    access.onModuleDestroy();
  },
);

test(
  'node deadlines cover headers and streamed bodies, with body and UTF-8 bounds',
  { timeout: 10000 },
  async (t) => {
    const closed = new Set();
    const { origin } = await serverFor(t, (req, res) => {
      res.on('close', () => closed.add(req.url));
      if (req.url === '/v3/headers') return;
      if (req.url === '/v3/large') {
        res.writeHead(200, { 'content-length': 6000000 });
        res.end();
        return;
      }
      if (req.url === '/v3/invalid') {
        res.end(Buffer.from([0xff]));
        return;
      }
      res.writeHead(200);
      res.write('{');
    });
    const access = new ShortsNodeAccessService(),
      client = access.transport(origin, false, 150);
    for (const path of ['headers', 'body'])
      await assert.rejects(
        client.sendRequest(request(origin + '/v3/' + path)),
        { status: 503 },
      );
    await assert.rejects(
      client.sendRequest(request(origin + '/v3/large')),
      /too large/,
    );
    await assert.rejects(
      client.sendRequest(request(origin + '/v3/invalid')),
      /encoded data/,
    );
    await eventually(() => closed.has('/v3/headers') && closed.has('/v3/body'));
    assert.equal(access.activeRequests, 0);
    access.onModuleDestroy();
  },
);

test(
  'real SDK contract reads have a whole-operation deadline and independent account cancellation',
  { timeout: 10000 },
  async (t) => {
    const creator = AccountMemory.generate().address,
      contract = encode(randomBytes(32), Encoding.ContractAddress);
    const aci = [
      {
        contract: {
          name: 'Fixture',
          kind: 'contract_main',
          typedefs: [],
          functions: [
            {
              name: 'get_value',
              arguments: [],
              returns: 'int',
              payable: false,
              stateful: false,
            },
          ],
        },
      },
    ];
    const encoded = new ContractByteArrayEncoder().encodeWithType(
      42,
      new TypeResolver().resolveType('int'),
    );
    let malformed = 0,
      holdAccounts = false;
    const held = [],
      calls = [];
    const { origin } = await serverFor(t, async (req, res) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = parts.length ? JSON.parse(Buffer.concat(parts)) : undefined;
      calls.push([req.method, req.url]);
      res.setHeader('content-type', 'application/json');
      let result;
      if (req.url === '/v3/status')
        result = {
          node_version: '7.2.0',
          network_id: 'ae_uat',
          protocols: [{ version: 6, effective_at_height: 0 }],
          top_block_height: 100,
        };
      else if (req.url.startsWith('/v3/accounts/')) {
        result = {
          id: req.url.split('/')[3],
          nonce: 0,
          balance: '100000000000000000000',
          kind: 'basic',
        };
        if (holdAccounts) {
          held.push({ res, result });
          return;
        }
      } else if (req.url === `/v3/contracts/${contract}`)
        result = {
          id: contract,
          active: true,
          owner_id: creator,
          vm_version: 8,
          abi_version: 3,
          referrer_ids: [],
        };
      else if (req.url === '/v3/recent-gas-prices')
        result = [{ min_gas_price: 1000000000, utilization: 0, minutes: 1 }];
      else if (req.url === '/v3/key-blocks/current/height')
        result = { height: 100 };
      else if (req.url === '/v3/dry-run')
        result = {
          results: malformed
            ? Array.from({ length: malformed === 1 ? 0 : 2 }, () => ({
                result: 'ok',
              }))
            : body.txs.map((v) => {
                const tx = unpackTx(v.tx, Tag.ContractCallTx);
                return {
                  type: 'contract_call',
                  result: 'ok',
                  call_obj: {
                    caller_id: tx.callerId,
                    caller_nonce: tx.nonce,
                    contract_id: contract,
                    height: 100,
                    gas_price: 1000000000,
                    gas_used: 1000,
                    log: [],
                    return_type: 'ok',
                    return_value: encoded,
                  },
                };
              }),
        };
      else {
        res.statusCode = 404;
        result = {};
      }
      res.end(JSON.stringify(result));
    });
    const access = new ShortsNodeAccessService(),
      node = access.createNode(origin),
      sdk = new AeSdk({ nodes: [{ name: 'fixture', instance: node }] });
    const chain = new ShortsChainService(
      { save() {} },
      { run: (f) => f() },
      undefined,
      access,
    );
    chain.sdk = sdk;
    chain.contract = await Contract.initialize({
      ...sdk.getContext(),
      aci,
      address: contract,
    });
    assert.equal(await chain.read('get_value'), 42n);
    for (malformed of [1, 2])
      await assert.rejects(
        chain.read('get_value'),
        /Invalid Shorts node dry-run results/,
      );
    assert.equal(access.activeRequests, 0);
    malformed = 0;
    assert.equal(await chain.read('get_value'), 42n);
    holdAccounts = true;
    await assert.rejects(
      access.read(() => node.getAccountByPubkey(creator), undefined, 150),
      { status: 503 },
    );
    assert.equal(held.length, 1);
    held.length = 0;
    const one = new AbortController(),
      two = new AbortController();
    const a = access
        .read(() => node.getAccountByPubkey(creator), one.signal)
        .catch((e) => e),
      b = access.read(() => node.getAccountByPubkey(creator), two.signal);
    await eventually(() => held.length === 2);
    one.abort();
    assert.equal((await a).status, 503);
    held[1].res.end(JSON.stringify(held[1].result));
    assert.equal((await b).id, creator);
    await assert.rejects(
      node.postTransaction({ tx: 'tx_not_signed' }),
      /outside its authority/,
    );
    assert.equal(
      calls.some(
        ([method, path]) => method === 'POST' && path === '/v3/transactions',
      ),
      false,
    );
    access.onModuleDestroy();
    await assert.rejects(chain.read('get_value'), { status: 503 });
  },
);

test('read-operation admission stays bounded even if an SDK promise never settles', async () => {
  const access = new ShortsNodeAccessService();
  const work = Array.from({ length: 32 }, () =>
    access.read(() => new Promise(() => {}), undefined, 200).catch((e) => e),
  );
  await assert.rejects(
    access.read(async () => 42),
    { status: 503 },
  );
  access.onModuleDestroy();
  for (const error of await Promise.all(work)) assert.equal(error.status, 503);
  assert.equal(access.activeReads, 0);
});

test('an abandoned read cannot start later network work', async (t) => {
  let calls = 0,
    resume;
  const { origin } = await serverFor(t, (_req, res) => {
    calls++;
    res.end('{}');
  });
  const access = new ShortsNodeAccessService(),
    client = access.transport(origin);
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  let continuation;
  await assert.rejects(
    access.read(
      async () => {
        await gate;
        continuation = client
          .sendRequest(request(origin + '/v3/status'))
          .catch((error) => error);
        return continuation;
      },
      undefined,
      50,
    ),
    { status: 503 },
  );
  resume();
  await eventually(() => continuation !== undefined);
  assert.equal((await continuation).status, 503);
  assert.equal(calls, 0);
  assert.equal(access.activeRequests, 0);
  access.onModuleDestroy();
});

test(
  'Nest shutdown cancels node work before waiting for the mutation queue to drain',
  { timeout: 5000 },
  async (t) => {
    let started = false,
      closed = false;
    const { origin } = await serverFor(t, (_req, res) => {
      started = true;
      res.on('close', () => {
        closed = true;
      });
      res.writeHead(200);
      res.write('{');
    });
    class Core {}
    Module({
      providers: [ShortsNodeAccessService, ShortsWorkQueueService],
      exports: [ShortsNodeAccessService, ShortsWorkQueueService],
    })(Core);
    const app = await NestFactory.createApplicationContext(Core, {
      logger: false,
    });
    t.after(() => app.close());
    const access = app.get(ShortsNodeAccessService),
      queue = app.get(ShortsWorkQueueService),
      client = access.transport(origin);
    const pending = queue
      .run(() =>
        access.read(() => client.sendRequest(request(origin + '/v3/status'))),
      )
      .catch((e) => e);
    await eventually(() => started);
    await app.close();
    assert.equal((await pending).status, 503);
    await eventually(() => closed);
    await assert.rejects(
      queue.run(async () => {}),
      { status: 503 },
    );
    assert.equal(access.activeRequests, 0);
  },
);

test(
  'media shutdown aborts active IPFS reads and forwards cancellation to private S3 sources',
  { timeout: 5000 },
  async (t) => {
    let started = false,
      closed = false;
    const { origin } = await serverFor(t, (_req, res) => {
      started = true;
      res.on('close', () => {
        closed = true;
      });
      res.writeHead(200);
      res.write('{');
    });
    const old = process.env.SHORTS_IPFS_API;
    process.env.SHORTS_IPFS_API = origin + '/api/v0';
    t.after(() => {
      if (old === undefined) delete process.env.SHORTS_IPFS_API;
      else process.env.SHORTS_IPFS_API = old;
    });
    const media = new ShortsMediaService({});
    const reading = media.pinned('bafyfixture').catch((e) => e);
    await eventually(() => started);
    media.onModuleDestroy();
    assert.equal((await reading).name, 'AbortError');
    await eventually(() => closed);
    await assert.rejects(media.pinned('bafyfixture'), { name: 'AbortError' });
    const controller = new AbortController();
    let sourceSignal, fileSignal;
    const record = {
      id: 'owned',
      creator: 'ak_creator',
      files: [{ name: 'video.mp4', bytes: 3, sha256: 'hash' }],
      privateMedia: {
        files: { 'video.mp4': { bytes: 3, sha256: 'hash' } },
        source: {},
      },
    };
    const privateMedia = new ShortsPrivateMediaService(
      {
        get: async (_scope, _ref, signal) => {
          fileSignal = signal;
          return Buffer.from('abc');
        },
      },
      {
        read: async (_scope, _input, signal) => {
          sourceSignal = signal;
          return Buffer.from('abc');
        },
      },
    );
    await privateMedia.file(
      { network: 'ae_uat', contract: 'ct_owned' },
      record,
      'video.mp4',
      controller.signal,
    );
    await privateMedia.original(
      { network: 'ae_uat', contract: 'ct_owned' },
      record,
      controller.signal,
    );
    assert.equal(fileSignal, controller.signal);
    assert.equal(sourceSignal, controller.signal);
  },
);

test(
  'parent recovery module cancels its node read before the imported core module shuts down',
  { timeout: 5000 },
  async (t) => {
    let started = false,
      closed = false,
      claimed = false,
      settled = false,
      repaired = false;
    const { origin } = await serverFor(t, (_req, res) => {
      started = true;
      res.on('close', () => {
        closed = true;
      });
      res.writeHead(200);
      res.write('{');
    });
    class Core {}
    Module({
      providers: [ShortsNodeAccessService, ShortsWorkQueueService],
      exports: [ShortsNodeAccessService, ShortsWorkQueueService],
    })(Core);
    class Parent {}
    Module({
      imports: [Core],
      providers: [
        {
          provide: ShortsHostedHostingService,
          inject: [ShortsNodeAccessService, ShortsWorkQueueService],
          useFactory: (access, queue) => {
            const node = access.createNode(origin);
            return new ShortsHostedHostingService(
              {
                release: { network: 'ae_uat', contract: 'ct_owned' },
                state: { contract: 'ct_owned', sourceHash: 'a'.repeat(64) },
                serial: (fn) => queue.run(fn),
                read: (_method, _args, signal) =>
                  access.read(() => node.getStatus(), signal),
              },
              {
                pinned: () => {
                  repaired = true;
                },
              },
              { demoAutoApprove: false, publisher: {} },
              {
                shared: true,
                get: async () => ({
                  id: 'owned',
                  moderation: 'approved',
                  safety: { status: 'no_flags' },
                  publication: 'published',
                }),
              },
              {
                verify: async () => {},
                renew: async () => true,
                claim: async () => {
                  if (claimed) return undefined;
                  claimed = true;
                  return {
                    id: 'owned',
                    generation: '1',
                    fence: '1',
                    token: 'owned-token',
                  };
                },
                settle: async () => {
                  settled = true;
                },
              },
            );
          },
        },
      ],
    })(Parent);
    const app = await NestFactory.createApplicationContext(Parent, {
      logger: false,
    });
    t.after(() => app.close());
    await app.get(ShortsHostedHostingService).initialize();
    app.get(ShortsHostedHostingService).start();
    await eventually(() => started);
    await app.close();
    await eventually(() => closed);
    assert.equal(
      settled,
      false,
      'stopped work must remain recoverable by its lease',
    );
    assert.equal(repaired, false);
    assert.equal(app.get(ShortsNodeAccessService).activeRequests, 0);
    assert.equal(app.get(ShortsHostedHostingService).pending, undefined);
  },
);

test(
  'inspection and optional classification shutdown close active bodies without approving',
  { timeout: 5000 },
  async (t) => {
    const keys = [
      'NODE_ENV',
      'SHORTS_DEMO_AUTO_APPROVE',
      'SHORTS_TESTNET_MVP',
      'SHORTS_MODERATION_URL',
      'SHORTS_MODERATION_TOKEN_FILE',
      'SHORTS_JEV_ENABLED',
      'SHORTS_JEV_MODEL',
      'TYPESAFE_API_KEY',
    ];
    const saved = keys.map((key) => process.env[key]);
    keys.forEach((key) => delete process.env[key]);
    const dir = await mkdtemp(join(tmpdir(), 'shorts-node-shutdown-'));
    t.after(async () => {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
      await rm(dir, { recursive: true });
    });
    const started = new Set(),
      closed = new Set();
    const { origin } = await serverFor(t, (req, res) => {
      started.add(req.url);
      res.on('close', () => closed.add(req.url));
      res.writeHead(200);
      res.write('{');
    });
    process.env.SHORTS_MODERATION_URL = origin;
    process.env.SHORTS_MODERATION_TOKEN_FILE = join(dir, 'token');
    await writeFile(
      process.env.SHORTS_MODERATION_TOKEN_FILE,
      'owned-test-token'.repeat(4),
      { mode: 0o600 },
    );
    process.env.SHORTS_JEV_ENABLED = '1';
    process.env.SHORTS_JEV_MODEL = 'jev-1.13.0';
    process.env.TYPESAFE_API_KEY = 'owned-test-fixture';
    const nativeFetch = globalThis.fetch;
    // Only the optional classifier URL is redirected to this owned HTTP fixture.
    t.mock.method(globalThis, 'fetch', (url, options) =>
      nativeFetch(
        url === 'https://api.typesafe.ai/v1/systemone'
          ? origin + '/classify'
          : url,
        options,
      ),
    );
    const safety = new ShortsSafetyService(),
      labels = new ShortsLabelsService();
    const health = safety.health(),
      inspection = safety.scan(Buffer.from('owned')),
      classification = labels.classify({ title: 'Art', topic: 'Art' });
    await eventually(() => started.size === 3);
    safety.onModuleDestroy();
    labels.onModuleDestroy();
    assert.equal(await health, false);
    assert.equal((await inspection).status, 'error');
    assert.equal((await classification).status, 'review-needed');
    await eventually(() => closed.size === 3);
    assert.equal(await safety.health(), false);
    assert.equal((await safety.scan(Buffer.from('owned'))).status, 'error');
    assert.equal(
      (await labels.classify({ title: 'Art', topic: 'Art' })).status,
      'review-needed',
    );
    assert.equal(started.size, 3);
  },
);
