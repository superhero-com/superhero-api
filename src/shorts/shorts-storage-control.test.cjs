require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ShortsStorageControlGuard: Guard, ShortsStorageControlController: Controller } = require('./shorts-storage-control.controller');
const { ShortsPinTransfersService } = require('./shorts-pin-transfers.service');
const { ShortsService } = require('./shorts.service');
const { ShortsDeliveryAcknowledgementService: Acknowledgement } = require('./shorts-delivery-acknowledgement.service');
const { sourceKey } = require('./hls-protocol/hls-package');
const fixture = require('./testing/hls-v3.json');

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { for (const [key,value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}
const scope = { network: fixture.descriptor.network, contract: fixture.descriptor.contract };
const binding = { operationId: randomUUID(), sourceKey: sourceKey(fixture.descriptor), cid: fixture.package.cid };
const chain = () => ({ release: { ...scope }, state: { contract: scope.contract } });

test('storage control is unavailable by default and cannot start enabled without a mounted credential', async t => {
  environment(t, { SHORTS_IPFS_EXPIRING_WRITES: undefined, SHORTS_STORAGE_CONTROL_TOKEN_FILE: undefined });
  await assert.rejects(new Guard().canActivate({}), { status: 404 });
  process.env.SHORTS_IPFS_EXPIRING_WRITES = 'true';
  assert.throws(() => new Guard(), /absolute SHORTS_STORAGE/);
  process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE = 'relative';
  assert.throws(() => new Guard(), /absolute SHORTS_STORAGE/);
});

test('HTTP storage control authenticates, rotates credentials and binds outcomes to the authorized source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-storage-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'key'), key = randomBytes(32).toString('hex');
  await writeFile(file, key, { mode: 0o600 });
  environment(t, { SHORTS_IPFS_EXPIRING_WRITES: 'true', SHORTS_STORAGE_CONTROL_TOKEN_FILE: file });
  const pins = new Map(), events = []; let visible = true;
  const shorts = { chain: chain(), playbackDescriptor: async id => {
    if (!visible || id !== fixture.descriptor.id) throw new (require('@nestjs/common').NotFoundException)();
    return fixture.descriptor;
  }, playbackGeneration: async () => { throw new (require('@nestjs/common').NotFoundException)(); } };
  const ledger = { begin: async (scope, value, operationId) => {
    events.push('begin'); const row = { ...scope, ...value, operationId, state: 'issued', expires: Date.now()+180000 };
    pins.set(operationId, row); return row;
  }, bind:async(id,storage)=>{events.push('bind');const row=pins.get(id);row.storage=storage;return row;}, get: async id => pins.get(id), finish: async (id,state) => { events.push(state); const row = pins.get(id); row.state=state; return row; } };
  class FixtureModule {}
  Module({ controllers: [Controller], providers: [Guard, { provide: ShortsService, useValue: shorts },
    { provide: ShortsPinTransfersService, useValue: ledger }] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const root = await app.getUrl(), path = `/shorts/internal/storage/${fixture.descriptor.id}/pins`;
  const request = async (body=binding, headers={ Authorization: `Bearer ${key}` }, suffix='') => {
    const response = await fetch(root+path+suffix, { method:'POST', headers:{ 'Content-Type':'application/json', ...headers }, body:JSON.stringify(body) });
    const value = await response.json(); return { status:response.status, value };
  };
  for (const headers of [{}, { Authorization:'Bearer invalid' }, { Authorization:`Bearer ${'0'.repeat(64)}` },
    { Authorization:`Bearer ${key}`, Origin:'https://browser.example' }])
    assert.equal((await request(binding, headers)).status, 401);
  assert.deepEqual(events, []);
  for (const body of [{ ...binding, extra: true }, { ...binding, operationId:[binding.operationId] },
    { ...binding, sourceKey:'0'.repeat(64) }, { ...binding, cid:fixture.descriptor.cid }, { ...binding, generation:'withdrawn-generation' }])
    assert.equal((await request(body)).status, 404);
  const issued = await request(); assert.equal(issued.status,200); assert.equal(issued.value.purpose,'hls');
  assert.equal(issued.value.jobId, fixture.descriptor.id); assert.equal(issued.value.contract, scope.contract);
  const epoch={operationId:binding.operationId,sourceKey:binding.sourceKey,peerId:'a'.repeat(52),epoch:'e'.repeat(64)};
  assert.equal((await request(epoch,{},'/bind')).status,401);
  for(const invalid of [{...epoch,sourceKey:'0'.repeat(64)},{...epoch,peerId:[]},{...epoch,epoch:'bad'},{...epoch,extra:true}])
    assert.equal((await request(invalid,undefined,'/bind')).status,404);
  assert.equal((await request(epoch,undefined,'/bind')).status,200);
  visible=false;
  assert.equal((await request({ ...binding, operationId:randomUUID() })).status,404);
  const body = { operationId:binding.operationId, sourceKey:binding.sourceKey, outcome:'pinned',
    receipt:{ version:1, cid:binding.cid, operation:binding.operationId, expires:issued.value.expires, status:'pinned', epoch:'e'.repeat(64) } };
  assert.equal((await request({ ...body, receipt:{ ...body.receipt, expires:1 } }, undefined, '/finish')).status,404);
  assert.equal((await request({ ...body, sourceKey:'0'.repeat(64) }, undefined, '/finish')).status,404);
  assert.equal((await request({ ...body, receipt:{ ...body.receipt, epoch:'f'.repeat(64) } }, undefined, '/finish')).status,404);
  assert.equal((await request(body, undefined, '/finish')).status,200, 'outcome recording must remain possible after withdrawal');
  const rotated=randomBytes(32).toString('hex'); await writeFile(file,rotated,{mode:0o600});
  assert.equal((await request(body,undefined,'/finish')).status,401);
  assert.equal((await request(body,{Authorization:`Bearer ${rotated}`},'/finish')).status,200);
  assert.deepEqual(events,['begin','bind','pinned','pinned']);
});

test('bounded storage-control work drains on shutdown and refuses new work', async () => {
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const controller=new Controller({chain:chain(),playbackDescriptor:async()=>fixture.descriptor}, {begin:async()=>gate});
  const pending=Array.from({length:8},()=>controller.begin(fixture.descriptor.id,binding));
  await assert.rejects(controller.begin(fixture.descriptor.id,binding),{status:503});
  const closing=controller.onModuleDestroy();
  await assert.rejects(controller.begin(fixture.descriptor.id,binding),{status:503});
  release(); await Promise.all(pending); await closing;
});

test('fresh HLS acknowledgement verifies bytes and rechecks policy before consuming pin authority', async t => {
  environment(t,{SHORTS_IPFS_EXPIRING_WRITES:'true'});
  const events=[], operationId=randomUUID(); let withdrawn=false, failVerification=false, existing=false;
  const service=new Acknowledgement({verifyPreparedDelivery:async()=>{events.push('verify'); if(failVerification)throw new Error('missing pin');}},
    {get:async()=>existing?fixture.package:undefined,acknowledge:async(d,p,op)=>{events.push('ack');assert.equal(op,existing?undefined:operationId);}},
    {begin:async(s,b)=>{events.push('begin');assert.deepEqual(s,scope);assert.equal(b.cid,fixture.package.cid);return {operationId};},
      finish:async(op,state)=>{assert.equal(op,operationId);events.push(state);}});
  const recheck=async()=>{events.push('policy');if(withdrawn)throw new Error('withdrawn');};
  const run=()=>service.acknowledge({},fixture.descriptor,fixture.package,recheck,new AbortController().signal);
  await run(); assert.deepEqual(events,['begin','policy','verify','policy','ack']);
  events.length=0; failVerification=true; await assert.rejects(run(),/missing pin/);
  assert.deepEqual(events,['begin','policy','verify','rejected']);
  events.length=0; failVerification=false; withdrawn=true; await assert.rejects(run(),/withdrawn/);
  assert.deepEqual(events,['begin','policy','rejected']);
  events.length=0; withdrawn=false; existing=true; await run(); assert.deepEqual(events,['policy','verify','policy','ack']);
});
