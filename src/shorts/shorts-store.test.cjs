const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');

// Real OS processes exercise SQLite ownership, including suspension and a crash.
// No node, wallet or production data is accessed.
const worker = `
require('reflect-metadata');
const { ShortsStoreService } = require('./src/shorts/shorts-store.service');
try {
  const store = new ShortsStoreService();
  process.send({ ready: true, state: store.load() });
  process.on('message', async message => {
    if (message === 'release') return;
    if (message === 'close') {
      store.onApplicationShutdown();
      store.onApplicationShutdown();
      process.exit(0);
    }
    if (message === 'drain') {
      const { NestFactory } = require('@nestjs/core');
      const { ShortsWorkQueueService } = require('./src/shorts/shorts-work-queue.service');
      const work = new ShortsWorkQueueService();
      const app = await NestFactory.createApplicationContext({
        module: class TestModule {},
        providers: [
          { provide: ShortsStoreService, useValue: store },
          { provide: ShortsWorkQueueService, useValue: work },
        ],
      }, { logger: false });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const operation = work.run(async () => { await gate; store.save({ drained: true }); });
      process.once('message', () => release());
      const closing = app.close();
      process.send({ draining: true });
      await operation;
      await closing;
      process.exit(0);
    } else {
      store.save(message);
      process.send({ saved: true, state: store.load() });
    }
  });
} catch (error) {
  process.send({ error: error.message });
  process.exitCode = 1;
  process.disconnect();
}
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-store-test-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGCONT');
        child.kill('SIGKILL');
      }
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const child = spawn(process.execPath, ['-r', 'ts-node/register', '-e', worker], {
      cwd: process.cwd(),
      env: { ...process.env, SHORTS_DATA_DIR: directory, TS_NODE_TRANSPILE_ONLY: 'true' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    child.exited = once(child, 'exit');
    let diagnostics = '';
    child.stderr.on('data', bytes => { diagnostics += bytes; });
    const message = once(child, 'message');
    const first = await Promise.race([
      message.then(([value]) => value),
      child.exited.then(() => { throw new Error(`Store worker exited before initialization: ${diagnostics}`); }),
    ]);
    return { child, first };
  }
  async function send(child, value) {
    const received = once(child, 'message');
    child.send(value);
    return (await received)[0];
  }
  return { start, send };
}

test('exclusive owner rejects overlapping instances, survives suspension and recovers saved state after a crash', { timeout: 30000 }, async t => {
  const { start, send } = await fixture(t);
  const first = await start();
  assert.equal(first.first.ready, true);
  assert.deepEqual((await send(first.child, { shorts: ['persisted'], receipts: ['receipt'] })).state,
    { shorts: ['persisted'], receipts: ['receipt'] });
  const overlap = await start();
  assert.match(overlap.first.error, /already in use/);
  await overlap.child.exited;
  first.child.kill('SIGSTOP');
  const suspended = await start();
  assert.match(suspended.first.error, /already in use/);
  await suspended.child.exited;
  first.child.kill('SIGKILL');
  await first.child.exited;
  const recovered = await start();
  assert.deepEqual(recovered.first.state, { shorts: ['persisted'], receipts: ['receipt'] });
  recovered.child.send('close');
  await recovered.child.exited;
  const restarted = await start();
  assert.deepEqual(restarted.first.state, { shorts: ['persisted'], receipts: ['receipt'] });
});

test('Nest shutdown retains database ownership until an active mutation is saved', { timeout: 30000 }, async t => {
  const { start, send } = await fixture(t);
  const first = await start();
  assert.deepEqual(await send(first.child, 'drain'), { draining: true });
  const overlap = await start();
  assert.match(overlap.first.error, /already in use/);
  await overlap.child.exited;
  first.child.send('release');
  await first.child.exited;
  const restarted = await start();
  assert.deepEqual(restarted.first.state, { drained: true });
});
