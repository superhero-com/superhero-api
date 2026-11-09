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
