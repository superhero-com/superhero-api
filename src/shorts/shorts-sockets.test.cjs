const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Redis } = require('ioredis');
const WebSocket = require('ws');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { WebSocketGateway, WebSocketServer } = require('@nestjs/websockets');
const { DataSource } = require('typeorm');
const { ShortsGateway } = require('./shorts.gateway');
const { ShortsIndexService } = require('./shorts-index.service');
const { ShortsSocketService, SHORTS_SOCKET_LIMITS, shortsSocketLimits } = require('./shorts-socket.service');
const { SHORTS_RATE_CONFIG, shortsClientIdentity } = require('./shorts-rate.config');

let redisProcess, directory, port, control;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'shorts-socket-admission-'));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  redisProcess = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory,
    '--save', '', '--appendonly', 'no', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction']);
  await new Promise((resolve, reject) => {
    redisProcess.on('error', reject);
    redisProcess.stdout.on('data', chunk => { if (String(chunk).includes('Ready to accept connections')) resolve(); });
    redisProcess.on('exit', code => reject(new Error(`Fixture Redis exited ${code}`)));
  });
  control = new Redis({ host: '127.0.0.1', port }); await control.ping();
});
after(async () => {
  control?.disconnect();
  if (redisProcess && redisProcess.exitCode === null) { redisProcess.kill('SIGTERM'); await once(redisProcess, 'exit'); }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function until(fn) {
  for (let i = 0; i < 120; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Condition did not become true');
}
async function fixture(t, options = {}) {
  const limits = { ...shortsSocketLimits, clientConnections: 2, globalConnections: 3, nodeConnections: 6,
    clientAttempts: 100, globalAttempts: 1000, leaseMs: 5000, renewMs: 1000, ...options.limits };
  const contract = `ct_${randomUUID().replaceAll('-', '')}`;
  const identity = { network: 'ae_uat', contract };
  const apps = [], clients = [], listeners = [];
  const oldOrigins = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://web.example';
  t.after(async () => {
    clients.forEach(client => client.terminate());
    for (const app of apps) await app.close();
    if (oldOrigins === undefined) delete process.env.ALLOWED_ORIGINS; else process.env.ALLOWED_ORIGINS = oldOrigins;
  });
  async function origin() {
    class RootGateway {}
    WebSocketGateway()(RootGateway); WebSocketServer()(RootGateway.prototype, 'server');
    class FixtureModule {}
    const db = { createQueryRunner: () => {
      const client = new EventEmitter(); listeners.push(client);
      return { connect: async () => client, query: async () => [], release: async () => {} };
    } };
    Module({ providers: [RootGateway, ShortsGateway, ShortsSocketService,
      { provide: DataSource, useValue: db }, { provide: ShortsIndexService, useValue: { identity: () => identity } },
      { provide: SHORTS_SOCKET_LIMITS, useValue: limits },
      { provide: SHORTS_RATE_CONFIG, useValue: { key: Buffer.alloc(32, 7), redis: { host: '127.0.0.1', port },
        client: shortsClientIdentity(options.trust === false ? 'false' : '127.0.0.1/32') } },
    ] })(FixtureModule);
    const app = await NestFactory.create(FixtureModule, { logger: false }); apps.push(app);
    await app.listen(0, '127.0.0.1');
    return { app, port: app.getHttpServer().address().port, gateway: app.get(ShortsGateway),
      limiter: app.get(ShortsSocketService), root: app.get(RootGateway) };
  }
  async function connect(origin, ip = '192.0.2.1', options = {}) {
    const path = options.root ? '/socket.io' : '/shorts/socket.io';
    const ws = new WebSocket(`ws://127.0.0.1:${origin.port}${path}/?EIO=4&transport=websocket${options.sid ? `&sid=${encodeURIComponent(options.sid)}` : ''}`,
      { headers: { 'X-Forwarded-For': ip, ...(options.headers || {}) } });
    clients.push(ws);
    const frames = [];
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Fixture socket did not settle')); }, 3000);
      const done = result => { clearTimeout(timeout); resolve({ ws, frames, ...result }); };
      ws.on('error', () => {});
      ws.on('unexpected-response', (_req, response) => { response.resume(); done({ status: response.statusCode }); });
      ws.on('message', chunk => {
        const value = chunk.toString(); frames.push(value);
        if (value === '2') { ws.send('3'); return; }
        if (value.startsWith('0')) {
          if (options.engineOnly) { done({ status: 200 }); return; }
          ws.send(options.root ? '40' : '40/shorts,');
        }
        if (value.startsWith(options.root ? '40{' : '40/shorts,')) done({ status: 200 });
      });
      ws.on('close', () => { clearTimeout(timeout); resolve({ ws, frames, status: 0 }); });
    });
  }
  const notify = (payload = identity) => listeners.forEach(client => client.emit('notification', {
    channel: 'shorts_updated', payload: JSON.stringify(payload),
  }));
  return { origin, connect, notify, identity, limits, listeners };
}

test('two actual Nest socket servers share connection capacity before namespace admission', async t => {
  const f = await fixture(t); const a = await f.origin(), b = await f.origin();
  const first = await f.connect(a); const second = await f.connect(b, '::ffff:192.0.2.1');
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal((await f.connect(b)).status, 400, 'client capacity spans replicas');
  const third = await f.connect(a, '2001:db8::1', { engineOnly: true });
  assert.equal(third.status, 200);
  assert.equal((await f.connect(b, '192.0.2.2')).status, 400, 'even an unjoined transport holds a global slot');
  const lease = [...a.gateway.connections.values()][0].lease;
  assert.equal(await control.zcard(lease.global), 3);
  first.ws.terminate(); await until(async () => await control.zcard(lease.global) === 2);
  assert.equal((await f.connect(b, '192.0.2.2')).status, 200);
});

test('IPv6 /64, explicit proxy trust, browser origin and local node bounds are enforced', async t => {
  const f = await fixture(t, { limits: { clientConnections: 1, globalConnections: 10, nodeConnections: 2 } });
  const a = await f.origin();
  assert.equal((await f.connect(a, '2001:db8:1:2::1')).status, 200);
  assert.equal((await f.connect(a, '2001:db8:1:2::99')).status, 400);
  assert.equal((await f.connect(a, '192.0.2.4', { headers: { Origin: 'https://bad.example' } })).status, 400);
  assert.equal((await f.connect(a, '192.0.2.4', { headers: { Origin: 'https://web.example' } })).status, 200);
  assert.equal((await f.connect(a, '192.0.2.5')).status, 400, 'per-process bound');
  const g = await fixture(t, { trust: false, limits: { clientConnections: 1 } }); const direct = await g.origin();
  assert.equal((await g.connect(direct, '192.0.2.1')).status, 200);
  assert.equal((await g.connect(direct, '192.0.2.2')).status, 400, 'untrusted forwarding headers cannot rotate identity');
});

test('shared handshake budget applies after disconnect and preserves no raw IP in Redis', async t => {
  const f = await fixture(t, { limits: { clientAttempts: 2 } }); const a = await f.origin(), b = await f.origin();
  for (const server of [a, b]) {
    const result = await f.connect(server); assert.equal(result.status, 200); result.ws.terminate();
    await until(() => server.gateway.connections.size === 0);
  }
  assert.equal((await f.connect(a)).status, 400);
  assert.equal((await f.connect(b, '192.0.2.99')).status, 200);
  const lease = [...b.gateway.connections.values()][0].lease;
  const prefix = lease.global.replace(/connections$/, '');
  for (const key of await control.keys(`${prefix}*`)) {
    assert.ok(!key.includes('192.0.2')); assert.ok(await control.pttl(key) > 0);
  }
});

test('live invalidations are scoped, coalesced and do not leak onto the application socket', async t => {
  const f = await fixture(t); const a = await f.origin();
  const shorts = await f.connect(a); const root = await f.connect(a, '192.0.2.1', { root: true });
  assert.equal(shorts.status, 200); assert.equal(root.status, 200);
  await new Promise(resolve => setTimeout(resolve, 150)); shorts.frames.length = 0; root.frames.length = 0;
  for (let i = 0; i < 50; i++) f.notify({ ...f.identity, untrusted: 'not forwarded' });
  await until(() => shorts.frames.some(frame => frame.startsWith('42/shorts,')));
  const updates = shorts.frames.filter(frame => frame.startsWith('42/shorts,'));
  assert.equal(updates.length, 1); assert.deepEqual(JSON.parse(updates[0].slice('42/shorts,'.length)), ['shorts-updated', f.identity]);
  assert.equal(root.frames.some(frame => frame.includes('shorts-updated')), false);
  shorts.frames.length = 0; f.notify({ ...f.identity, network: 'ae_mainnet' });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(shorts.frames.some(frame => frame.startsWith('42/shorts,')), false);
  shorts.ws.send('42/shorts,["unsupported-write",{}]');
  await until(() => shorts.ws.readyState === WebSocket.CLOSED);
  a.root.server.emit('token-updated', { token: 'still-working' });
  await until(() => root.frames.some(frame => frame.includes('still-working')));
  assert.equal(root.ws.readyState, WebSocket.OPEN);
});

test('oversized packets close only the Shorts transport and polling is rejected', async t => {
  const f = await fixture(t); const a = await f.origin();
  const root = await f.connect(a, undefined, { root: true }); const shorts = await f.connect(a);
  assert.equal(shorts.status, 200); assert.equal(root.status, 200);
  shorts.ws.send(`42/shorts,["oversize","${'a'.repeat(5000)}"]`);
  await until(() => shorts.ws.readyState === WebSocket.CLOSED);
  assert.equal(root.ws.readyState, WebSocket.OPEN);
  const live = await f.connect(a);
  const sid = JSON.parse(live.frames.find(frame => frame.startsWith('0')).slice(1)).sid;
  assert.equal((await f.connect(a, undefined, { sid })).status, 400, 'SID reuse cannot bypass admission');
  assert.equal(live.ws.readyState, WebSocket.OPEN);
  const response = await fetch(`http://127.0.0.1:${a.port}/shorts/socket.io/?EIO=4&transport=polling`);
  assert.equal(response.status, 400);
});

test('expired leases are not resurrected and Redis failure closes live Shorts sockets', async t => {
  const f = await fixture(t); const a = await f.origin(); const first = await f.connect(a);
  assert.equal(first.status, 200);
  const entry = [...a.gateway.connections.values()][0];
  await control.zadd(entry.lease.global, 1, entry.lease.id);
  await control.zadd(entry.lease.client, 1, entry.lease.id);
  await until(() => first.ws.readyState === WebSocket.CLOSED);
  assert.equal(await control.zscore(entry.lease.global, entry.lease.id), null);
  const next = await f.connect(a); assert.equal(next.status, 200);
  await control.call('CLIENT', 'PAUSE', '1800', 'ALL');
  // A real admission timeout marks the dependency unavailable before renewal.
  const denied = await f.connect(a, '192.0.2.88'); assert.ok([0, 400].includes(denied.status), 'upgrade is refused or closed when Redis times out');
  await until(() => next.ws.readyState === WebSocket.CLOSED);
  await until(() => a.limiter.healthy());
  assert.equal((await f.connect(a, '192.0.2.89')).status, 200);
});

test('renewal preserves active connections and listener reconnect triggers a refresh', async t => {
  const f = await fixture(t); const a = await f.origin(); const socket = await f.connect(a);
  assert.equal(socket.status, 200);
  const lease = [...a.gateway.connections.values()][0].lease;
  const before = Number(await control.zscore(lease.global, lease.id));
  await until(async () => Number(await control.zscore(lease.global, lease.id)) > before);
  socket.frames.length = 0;
  f.listeners[0].emit('end');
  await until(() => socket.frames.some(frame => frame.includes('shorts-updated')));
  assert.equal(socket.ws.readyState, WebSocket.OPEN);
});


test('simultaneous admissions across instances never exceed global capacity', async t => {
  const f = await fixture(t, { limits: { clientConnections: 10, globalConnections: 3 } });
  const a = await f.origin(), b = await f.origin();
  const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => f.connect(i % 2 ? a : b, `192.0.2.${i + 1}`)));
  assert.equal(attempts.filter(result => result.status === 200).length, 3);
  assert.ok(attempts.every(result => [200, 400].includes(result.status)));
  assert.equal(a.gateway.connections.size + b.gateway.connections.size, 3);
});

test('abandoned leases expire and cannot be renewed after replacement', async t => {
  const f = await fixture(t, { limits: { globalConnections: 1 } }); const a = await f.origin(), b = await f.origin();
  const orphan = await a.limiter.acquire({ socket: { remoteAddress: '192.0.2.55' }, headers: {} });
  assert.ok(orphan);
  assert.equal((await f.connect(b)).status, 400);
  await until(async () => {
    const [seconds, micros] = await control.time();
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000) > Number(await control.zscore(orphan.global, orphan.id));
  });
  assert.equal((await f.connect(b)).status, 200);
  assert.equal((await a.limiter.renew([orphan])).size, 0);
  assert.equal(await control.zcard(orphan.global), 1);
});

test('outage admission has a bounded pending command set and recovers without an offline queue', async t => {
  const f = await fixture(t, { limits: { globalConnections: 100, nodeConnections: 100 } }); const a = await f.origin();
  await control.call('CLIENT', 'PAUSE', '1800', 'ALL');
  const pending = Promise.all(Array.from({ length: 80 }, (_, i) => f.connect(a, `192.0.2.${i + 1}`)));
  await until(() => a.limiter.pending.size === 32);
  assert.equal(a.gateway.acquiring, 32);
  const results = await pending;
  assert.ok(results.every(result => [0, 400].includes(result.status)));
  assert.equal(a.gateway.acquiring, 0); assert.equal(a.limiter.pending.size, 0);
  await until(() => a.limiter.healthy());
  assert.equal((await f.connect(a, '192.0.2.200')).status, 200);
});
