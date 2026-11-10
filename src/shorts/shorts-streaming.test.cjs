const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsStreamingService } = require('./shorts-streaming.service');
const { DatabaseSync } = require('node:sqlite');
const { ShortsDeliveryAcknowledgementService } = require('./shorts-delivery-acknowledgement.service');

test('dispatch requires the current adaptive acknowledgement and leaves incomplete responses pending', async t => {
  const env = { ...process.env }, fetch = global.fetch, fixture = require('./testing/hls-v3.json');
  const directory = await mkdtemp(join(tmpdir(), 'shorts-durable-outbox-')), key = join(directory,'key');
  await writeFile(key,'a'.repeat(64));
  Object.assign(process.env,{SHORTS_STREAM_INTERNAL_URL:'http://127.0.0.1:3337',SHORTS_STREAM_KEY_FILE:key,SHORTS_IPFS_EXPIRING_WRITES:'true'});

  const db = new DatabaseSync(join(directory,'outbox.sqlite'));
  const short = {...structuredClone(fixture.descriptor),publication:'published',moderation:'approved',safety:{status:'no_flags'}};
  const records = {chain:{release:{network:short.network,contract:short.contract},state:{contract:short.contract}},find:async()=>short};
  let saved=0, verified=0, corrupt=true, withdraw=false, value={status:'ready'};
  const packages = {get:async()=>fixture.package,acknowledge:async()=>{saved++;}};
  const acknowledgement = new ShortsDeliveryAcknowledgementService({verifyPreparedDelivery:async()=>{
    verified++;if(corrupt)throw new Error('Corrupt retained media');if(withdraw)short.moderation='rejected';
  }},packages,{});
  const service = new ShortsStreamingService({db},undefined,records,undefined,30000,packages,acknowledgement);
  global.fetch=async()=>Response.json(value);
  t.after(async()=>{await service.onModuleDestroy();db.close();global.fetch=fetch;process.env=env;await rm(directory,{recursive:true,force:true});});
  await service.enqueue(short.id);
  const retry=async()=>{db.exec('UPDATE shorts_stream_outbox SET ready=0,next_at=0');await service.dispatch();return db.prepare('SELECT ready FROM shorts_stream_outbox').get()?.ready;};
  assert.equal(await retry(),0);assert.equal(verified,0);assert.equal(saved,0);
  value={status:'ready',sourceKey:fixture.sourceKey,prepared:fixture.package};
  assert.equal(await retry(),0);assert.equal(verified,1);assert.equal(saved,0);
  corrupt=false;withdraw=true;assert.equal(await retry(),0);assert.equal(saved,0);
  withdraw=false;short.moderation='approved';assert.equal(await retry(),1);assert.equal(saved,1);
});

test('HLS outbox survives failed dispatch and service restart, deduplicates publication, and sends no video or wallet secret', async t => {
  const env = { ...process.env }; const fetch = global.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'shorts-outbox-'));
  const file = join(directory, 'key'); await writeFile(file, 'a'.repeat(64));
  Object.assign(process.env, { SHORTS_STREAM_INTERNAL_URL: 'http://127.0.0.1:3337', SHORTS_STREAM_KEY_FILE: file });
  const db = new DatabaseSync(join(directory, 'outbox.sqlite'));
  const fixture = require('./testing/hls-v3.json');
  const short = { ...structuredClone(fixture.descriptor), publication: 'published', moderation: 'approved', safety: { status: 'no_flags' } };
  const store = { db, load: () => ({ shorts: [short] }) };
  const records = { chain: { release: short, state: { contract: short.contract } }, find: async () => short };
  const start = () => new ShortsStreamingService(store, {}, records, undefined, 30000, { acknowledge: async () => {} });
  const calls = []; let status = 503;
  global.fetch = async (url, init) => { calls.push({ url, init }); return status === 200 ? Response.json({ status: 'ready', sourceKey: fixture.sourceKey, prepared: fixture.package }) : new Response(null, { status }); };
  t.after(async () => { global.fetch = fetch; process.env = env; db.close(); await rm(directory, { recursive: true, force: true }); });
  const first = start();
  first.enqueue(short.id); first.enqueue(short.id);
  await first.dispatch(); first.onModuleDestroy();
  assert.equal(db.prepare('SELECT count(*) AS n FROM shorts_stream_outbox').get().n, 1);
  assert.equal(db.prepare('SELECT ready FROM shorts_stream_outbox').get().ready, 0);
  const next = start();
  db.exec('UPDATE shorts_stream_outbox SET next_at=0'); status = 202; await next.dispatch();
  assert.equal(db.prepare('SELECT ready FROM shorts_stream_outbox').get().ready, 0);
  db.exec('UPDATE shorts_stream_outbox SET next_at=0'); status = 200; await next.dispatch();
  assert.equal(db.prepare('SELECT ready FROM shorts_stream_outbox').get().ready, 1);
  next.enqueue(short.id); await next.dispatch(); next.onModuleDestroy();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://127.0.0.1:3337/internal/videos/protocol-fixture/prepare');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
  const denied = start();
  db.exec('UPDATE shorts_stream_outbox SET ready=0, next_at=0');
  short.moderation = 'rejected';
  await denied.dispatch(); denied.onModuleDestroy();
  assert.equal(calls.length, 3, 'revoked jobs never reach the streaming service after restart');
  assert.equal(db.prepare('SELECT count(*) AS n FROM shorts_stream_outbox').get().n, 0);
});

test('original HLS outbox settles only after a bounded, source-matched durable acknowledgement', async t => {
  const env = { ...process.env }, fetch = global.fetch;
  const fixture = require('./testing/hls-v3.json');
  const directory = await mkdtemp(join(tmpdir(), 'shorts-ack-')), key = join(directory, 'key');
  await writeFile(key, 'a'.repeat(64));
  Object.assign(process.env, { SHORTS_STREAM_INTERNAL_URL: 'http://127.0.0.1:3337', SHORTS_STREAM_KEY_FILE: key });
  const db = new DatabaseSync(join(directory, 'outbox.sqlite'));
  const short = { ...structuredClone(fixture.descriptor), publication: 'published', moderation: 'approved', safety: { status: 'no_flags' } };
  const records = { chain: { release: { network: short.network, contract: short.contract }, state: { contract: short.contract } }, find: async () => short };
  const store = { db, load: () => ({ shorts: [short] }) };
  let saved = 0, available = false, value = { status: 'ready', sourceKey: fixture.sourceKey, prepared: fixture.package };
  const deliveries = { acknowledge: async (descriptor, prepared) => {
    assert.equal(descriptor.cid, short.cid); assert.deepEqual(prepared, fixture.package);
    if (!available) throw new Error('database unavailable'); saved++;
  } };
  global.fetch = async () => new Response(JSON.stringify(value), { status: 200 });
  const service = new ShortsStreamingService(store, undefined, records, undefined, 30000, deliveries);
  t.after(async () => { await service.onModuleDestroy(); db.close(); global.fetch = fetch; process.env = env; await rm(directory, { recursive: true, force: true }); });
  const retry = async () => { db.exec('UPDATE shorts_stream_outbox SET next_at=0'); await service.dispatch(); return db.prepare('SELECT ready FROM shorts_stream_outbox').get().ready; };
  await service.enqueue(short.id);
  assert.equal(await retry(), 0); available = true;
  const good = value; value = { ...good, sourceKey: '0'.repeat(64) }; assert.equal(await retry(), 0);
  value = { ...good, extra: 'x'.repeat(147456) }; assert.equal(await retry(), 0); assert.equal(saved, 0);
  value = good; assert.equal(await retry(), 1); assert.equal(saved, 1);
});

test('prepared verification requires a new receipt for the exact source and file index, bracketed by recursive pin checks', async t => {
  const { createHmac } = require('node:crypto');
  const { ShortsMediaService } = require('./shorts-media.service');
  const { validateSourcePackage } = require('./hls-protocol/hls-package');
  const sample = require('./testing/hls-v3.json');
  const descriptor = sample.descriptor;
  const record = { ...descriptor, creator: 'fixture' };
  const prepared = validateSourcePackage(descriptor, sample.package);
  const env = { ...process.env }, originalFetch = global.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'shorts-readback-')), keyFile = join(dir, 'key');
  t.after(async () => { process.env = env; global.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); });
  delete process.env.SHORTS_STREAM_VERIFY_HLS;
  const local = new ShortsMediaService();
  local.pinned = async () => true;
  let localReads = 0;
  local.verifyPinnedBytes = async () => { localReads++; };
  await local.verifyPreparedDelivery(record, descriptor, prepared);
  assert.equal(localReads, prepared.files.length);

  const key = '1a'.repeat(32);
  await writeFile(keyFile, key, { mode: 0o600 });
  Object.assign(process.env, { NODE_ENV: 'test', SHORTS_STREAM_VERIFY_HLS: 'true',
    SHORTS_STREAM_INTERNAL_URL: 'http://127.0.0.1:3337', SHORTS_STREAM_KEY_FILE: keyFile });
  let alter = x => x, checks = [], transport = 0;
  global.fetch = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:3337/internal/videos/' + descriptor.id + '/verify-prepared');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer ' + key);
    const q = JSON.parse(init.body);
    assert.equal(q.source, sample.sourceKey); assert.equal(q.generation, descriptor.derivatives.generation.job);
    const proof = createHmac('sha256', Buffer.from(key, 'hex'))
      .update(JSON.stringify(['shorts-hls-readback-v1', q.challenge, q.source, prepared])).digest('hex');
    transport++;
    return Response.json(alter({ version: 1, challenge: q.challenge, source: q.source, cid: q.cid, proof }));
  };
  const remote = new ShortsMediaService();
  remote.pinned = async cid => { checks.push(cid); return true; };
  remote.verifyPinnedBytes = async () => assert.fail('Unexpected local readback');
  let previous;
  alter = x => (previous = x);
  assert.deepEqual(await remote.verifyPreparedDelivery(record, descriptor, prepared), prepared);
  assert.deepEqual(checks, [prepared.cid, descriptor.cid, descriptor.derivatives.assetsCid, prepared.cid]);
  for (const mutation of [() => previous, x => ({ ...x, source: '0'.repeat(64) }),
    x => ({ ...x, cid: descriptor.cid }), x => ({ ...x, proof: '0'.repeat(64) }),
    x => ({ ...x, proof: createHmac('sha256', Buffer.from(key, 'hex'))
      .update(JSON.stringify(['shorts-hls-readback-v1', x.challenge, x.source, { ...prepared, files: prepared.files.slice(1) }]))
      .digest('hex') })]) {
    alter = mutation; checks = [];
    await assert.rejects(remote.verifyPreparedDelivery(record, descriptor, prepared), /receipt mismatch/);
    assert.deepEqual(checks, [prepared.cid]);
  }
  const before = transport; remote.pinned = async () => false;
  await assert.rejects(remote.verifyPreparedDelivery(record, descriptor, prepared), /not recursively pinned/);
  assert.equal(transport, before);
});
