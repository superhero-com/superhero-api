const schemaMigrations = require('./testing/schema-migrations.cjs');
const {
  ShortsDeliveryStaging: Migration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsSourceReaderService } = require('./shorts-source-reader.service');
const { ShortsDeliveryStagingService } = require('./shorts-delivery-staging.service');
const { ShortsOriginalRestagingService } = require('./shorts-original-restaging.service');
const { WorkerRpc } = require('../../test/shorts/worker-rpc');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
const { hashMediaFile } = require('./shorts-media-file');
const { workerRole } = require('./testing/worker-role.cjs');
const fixture = require('./testing/hls-v3.json');
const hash = value => createHash('sha256').update(value).digest('hex');

test('pinned-original restaging reserves before writes, resumes partial transfers and fences worker readiness', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_restage_' + randomUUID().replaceAll('-', ''), directory = await mkdtemp(join(tmpdir(), 'shorts-restage-test-'));
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  let owner, worker, identity, scratch, media, objects, server;
  const sockets = new Set();
  t.after(async () => {
    if (media) await media.onModuleDestroy(); objects?.onModuleDestroy(); scratch?.onModuleDestroy();
    for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve));
    if (worker?.isInitialized) await worker.destroy(); if (owner?.isInitialized) await owner.destroy();
    if (identity) await identity.dispose(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 4 } };
  owner = new DataSource(options); await owner.initialize();
  await owner.transaction(async db => {
    for (const name of ['ShortsMetadata','ShortsUploads','ShortsWorkers',
      'ShortsWorkerAuthority','ShortsProcessingCapacity','ShortsRetentionHolds',
      'ShortsWorkerBackpressure','ShortsUploadBudget','ShortsOriginalContent',
      'ShortsDeliveryPackages','ShortsDeliveryGenerations'])
      await new schemaMigrations[name]().up(db);
    await new Migration().up(db);
  });
  await owner.transaction(db => new Migration().down(db)); await owner.transaction(db => new Migration().up(db));
  const scope = { network: 'ae_uat', contract: 'ct_protocol' }, args = [scope.network, scope.contract], sourceHash = hash('source');
  const metadata = new ShortsMetadataService(owner); await metadata.initialize(scope, sourceHash, 30, 30);
  const source = randomBytes(2 * 1048576 + 37), path = join(directory, 'original'); await writeFile(path, source);
  const file = await hashMediaFile(path), original = { ...structuredClone(fixture.descriptor), bytes: file.bytes,
    cid: await new ShortsPackageService().originalCid(file), creator: 'ak_creator', title: 'Canonical title', topic: 'Art',
    description: 'Preserved description', language: 'en', createdAt: 1, publication: 'published', moderation: 'approved', safety: { status: 'no_flags' }, likes: 42 };
  original.original.sha256 = file.sha256;
  await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)', [...args, original.id, original.creator, original]);
  identity = await workerRole(admin, { url: url.href, schema, scope });
  worker = new DataSource({ ...options, url: identity.url }); await worker.initialize();
  const repo = new WorkerRpc(worker, { scope, sourceHash }); await repo.verifyRuntime(scope, sourceHash);
  const staging = new ShortsDeliveryStagingService(owner, metadata), retention = new ShortsRetentionService(owner, { scope, sourceHash, prefix: 'quarantine' });
  scratch = new ShortsScratchService({ directory: join(directory, 'scratch'), minFreeBytes: 64*1048576, minFreeInodes: 128,
    maxUsedPercent: Number(process.env.SHORTS_TEST_SCRATCH_MAX_USED_PERCENT || 85) }, new ShortsScratchProbeService()); await scratch.onModuleInit();
  let mode = 'valid', activeTransfers = 0, requests = 0, started;
  server = createServer(async (req, res) => {
    requests++; const address = new URL(req.url, 'http://fixture'); assert.equal(req.method, 'POST');
    assert.equal(address.searchParams.get('arg'), original.cid);
    if (address.pathname.endsWith('/pin/ls')) {
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'unpinned') { res.statusCode = 500; res.end(JSON.stringify({ Code: 0, Message: `path '${original.cid}' is not pinned` })); }
      else res.end(JSON.stringify({ Keys: { [original.cid]: { Type: 'recursive' } } }));
      return;
    }
    assert.equal(address.pathname, '/api/v0/cat');
    if (mode === 'stall') { res.write(source.subarray(0, 100)); started(); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/forbidden' }); res.end(); return; }
    const bytes = mode === 'corrupt' ? Buffer.alloc(source.length) : source;
    for (let start = 0; start < bytes.length; start += 17003) if (!res.write(bytes.subarray(start, start+17003))) await once(res, 'drain');
    res.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  media = new ShortsMediaService({}, undefined, { shared: true }, { acquire: async () => {
    activeTransfers++; return { signal: new AbortController().signal, release: async () => { activeTransfers--; } };
  } }, scratch);
  media.api = `http://127.0.0.1:${server.address().port}/api/v0`;
  const config = { endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'unused', prefix: 'quarantine',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, activeKeyId: 'key1', keys: { key1: randomBytes(32), key2: randomBytes(32) } };
  objects = new ShortsPrivateObjectsService(config); const stored = new Map(); let writes = 0, failAt = 0, withdraw = false;
  objects.client.send = async (command, options) => {
    options?.abortSignal?.throwIfAborted(); const input = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      writes++; const id = input.Key.split('/')[2];
      const state = await staging.get(scope, id); assert.equal(state.state, 'staging'); assert.equal(await repo.claim(scope), undefined);
      const root = (await retention.inventory()).items.find(item => item.id === id);
      assert.equal(root.objects.length, 4); assert.equal(root.manifestSources.length, 0); assert.ok(root.retainReasons.includes('original-restaging-reference'));
      if (writes === failAt) throw new Error('interrupted S3 transfer');
      if (stored.has(input.Key)) throw { $metadata: { httpStatusCode: 412 } };
      assert.ok(Buffer.isBuffer(input.Body)); assert.ok(input.Body.length <= 1048576 + 36);
      stored.set(input.Key, Buffer.from(input.Body));
      if (withdraw && input.Key.includes('/source-manifest/')) await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{publication}','\"withdrawn\"') WHERE id=$1", [original.id]);
      return {};
    }
    assert.equal(command.constructor.name, 'GetObjectCommand'); const bytes = stored.get(input.Key); assert.ok(bytes);
    return { ContentLength: bytes.length, Body: Readable.from([bytes]) };
  };
  const service = new ShortsOriginalRestagingService(metadata, media, objects, staging);
  await t.test('corrupt bytes, absent pins, redirects and cancellation never create a job or private writes', async () => {
    for (mode of ['corrupt','unpinned','redirect']) await assert.rejects(service.restage(scope, original.id, 'bad-source'));
    mode = 'valid'; await assert.rejects(service.restage(scope, original.id, 'cancelled', AbortSignal.abort()));
    mode = 'stall'; const controller = new AbortController(), receiving = new Promise(resolve => { started = resolve; });
    const interrupted = service.restage(scope, original.id, 'interrupted', controller.signal);
    await receiving; controller.abort(); await assert.rejects(interrupted); mode = 'valid';
    const fetch = media.ipfsFetch, pinned = media.pinned; let handedOff = false;
    media.ipfsFetch = async () => new Response(source); media.pinned = async () => true;
    try { await assert.rejects(media.withPinnedOriginal({ ...original, cid: fixture.descriptor.cid }, async () => { handedOff = true; }), /CID mismatch/); }
    finally { media.ipfsFetch = fetch; media.pinned = pinned; }
    assert.equal(handedOff, false);
    assert.equal(writes, 0); assert.equal((await owner.query('SELECT count(*)::integer AS n FROM shorts_ingestion'))[0].n, 0);
    assert.equal(activeTransfers, 0); assert.deepEqual(await readdir(scratch.directory), []);
  });
  await t.test('partial writes remain referenced and a retry reuses the reserved encryption key after rotation', async () => {
    failAt = 2; await assert.rejects(service.restage(scope, original.id, 'restage-1'), { status: 503 });
    assert.equal(stored.size, 1); assert.equal((await staging.get(scope, 'restage-1')).state, 'failed');
    assert.equal(await repo.claim(scope), undefined); assert.equal((await owner.query("SELECT status FROM shorts_ingestion WHERE id='restage-1'"))[0].status, 'failed');
    const paused = await staging.get(scope, 'restage-1');
    await metadata.enqueue(scope, 'other-replacement', original.creator, paused.input, undefined, original.id);
    await assert.rejects(staging.reserve(scope, 'restage-1', original.id, paused.input, paused.manifest), { code: 'SH409' });
    assert.equal((await staging.get(scope, 'restage-1')).state, 'failed');
    const other = await repo.claim(scope); assert.equal(other.id, 'other-replacement'); await repo.fail(scope, other);
    config.activeKeyId = 'key2'; failAt = 0;
    assert.deepEqual(await service.restage(scope, original.id, 'restage-1'), { jobId: 'restage-1', shortId: original.id, ready: true });
    const accepted = await staging.get(scope, 'restage-1'); assert.equal(accepted.fence, '2'); assert.equal(accepted.input.manifest.keyId, 'key1');
    const output = join(directory, 'reconstructed');
    await new ShortsSourceReaderService(objects).readToFile(scope, { id: accepted.jobId, creator: accepted.creator, input: accepted.input }, output);
    assert.deepEqual(await readFile(output), source); assert.equal(activeTransfers, 0); assert.deepEqual(await readdir(scratch.directory), []);
    const before = requests; await service.restage(scope, original.id, 'restage-1'); assert.equal(requests, before);
    const job = await repo.claim(scope); assert.equal(job.id, 'restage-1'); assert.equal(job.input.details.description, original.description);
    await repo.fail(scope, job); assert.deepEqual((await metadata.get(scope, original.id)).record, original);
    await assert.rejects(owner.transaction(db => new Migration().down(db)), /Preserve original staging history/);
    await assert.rejects(worker.query('SELECT * FROM shorts_delivery_staging'), { code: '42501' });
  });
  const plan = id => {
    const parts = [];
    for (let offset=0,index=0; offset<source.length; offset+=1048576,index++) {
      const bytes = source.subarray(offset, offset+1048576);
      parts.push({ index, object: objects.plannedReference(scope, id, `restage-part/${index}`, { bytes: bytes.length, sha256: hash(bytes) }) });
    }
    const manifest = JSON.stringify({ version: 1, id, creator: original.creator, bytes: source.length, sha256: file.sha256, parts });
    const ref = objects.plannedReference(scope, id, 'source-manifest', { bytes: Buffer.byteLength(manifest), sha256: hash(manifest) });
    return { manifest, input: { objectKey: ref.key, manifest: ref, bytes: source.length, sha256: file.sha256, processingProfile: 'original-h264-v1', title: original.title, topic: original.topic, details: {} } };
  };
  await t.test('live and expired staging leases cannot release work using another attempt', async () => {
    const p = plan('expired'); const first = await staging.reserve(scope, 'expired', original.id, p.input, p.manifest);
    await assert.rejects(staging.reserve(scope, 'expired', original.id, p.input, p.manifest), { code: 'SH409' });
    assert.equal(await repo.claim(scope), undefined);
    // Simulate elapsed time in this disposable schema; normal writes cannot shorten the protected lease.
    await assert.rejects(owner.query("UPDATE shorts_delivery_staging SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id='expired'"), { code: 'SH409' });
    const expire = () => owner.transaction(async db => { await db.query('ALTER TABLE shorts_delivery_staging DISABLE TRIGGER shorts_delivery_staging_guard');
      await db.query("UPDATE shorts_delivery_staging SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id='expired'");
      await db.query('ALTER TABLE shorts_delivery_staging ENABLE TRIGGER shorts_delivery_staging_guard'); });
    await expire();
    const current = await staging.reserve(scope, 'expired', original.id, p.input, p.manifest); assert.equal(current.fence, '2');
    await assert.rejects(staging.finish(scope, first), { status: 409 }); await staging.fail(scope, first);
    assert.equal((await staging.get(scope, 'expired')).state, 'staging'); await staging.fail(scope, current);
    await staging.reserve(scope, 'expired', original.id, p.input, p.manifest); await expire();
    await assert.rejects(staging.reserve(scope, 'expired', original.id, p.input, p.manifest), /retry limit/);
    assert.equal((await staging.get(scope, 'expired')).state, 'failed');
    assert.equal((await owner.query("SELECT status FROM shorts_ingestion WHERE id='expired'"))[0].status, 'failed');
    assert.equal(await repo.claim(scope), undefined);
  });
  await t.test('withdrawal during the transfer cannot make the staged source claimable', async () => {
    withdraw = true; await assert.rejects(service.restage(scope, original.id, 'withdrawn'), { status: 409 });
    assert.equal((await staging.get(scope, 'withdrawn')).state, 'failed'); assert.equal(await repo.claim(scope), undefined);
    assert.deepEqual(await readdir(scratch.directory), []); assert.equal((await scratch.snapshot()).reservations, 0);
    for (const sql of ['DELETE FROM shorts_delivery_staging','TRUNCATE shorts_delivery_staging']) await assert.rejects(owner.query(sql), { code: 'SH409' });
  });
});

test('remote restaging authenticates a maximum-sized plan, its caption bytes and the exact leased destinations', async t => {
  const { ShortsMediaTransferClientService } = require('./shorts-media-transfer-client.service');
  const { restagingProof, restagingTargetHash } = require('./shorts-transfer-protocol');
  const { originalRecord } = require('./testing/original-record.cjs');
  const env = { ...process.env }, oldFetch = global.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'shorts-staging-control-'));
  t.after(async () => { process.env = env; global.fetch = oldFetch; await rm(dir, {recursive:true,force:true}); });
  delete process.env.SHORTS_MEDIA_TRANSFER_RESTAGING;
  assert.equal(new ShortsMediaTransferClientService().restagingEnabled, false);
  const key = randomBytes(32).toString('hex'), keyFile = join(dir, 'key');
  await writeFile(keyFile, key, {mode:0o600});
  Object.assign(process.env, {NODE_ENV:'test',SHORTS_MEDIA_TRANSFER_RESTAGING:'true',SHORTS_MEDIA_TRANSFER_URL:'http://127.0.0.1:3336',SHORTS_MEDIA_TRANSFER_KEY_FILE:keyFile});
  const client=new ShortsMediaTransferClientService(), short=originalRecord(), scope={network:'ae_uat',contract:'ct_test'};
  short.bytes=100000000;
  const caption=Buffer.alloc(8192,65); short.captions=true;
  short.files.push({name:'captions.vtt',bytes:caption.length,sha256:hash(caption)});
  const hashes=Array.from({length:96},(_,i)=>hash(String(i)));
  const plan={hashes,captions:caption.toString('base64')},job='replacement',source=hash('scope'),signal=new AbortController().signal;
  const refs=hashes.map((sha256,index)=>({key:'prefix/'+job+'/restage-part/'+index+'/key/'+sha256,keyId:'key',sha256,bytes:Math.min(1048576,short.bytes-index*1048576)}));
  const manifest=JSON.stringify({parts:refs.map((object,index)=>({index,object}))});
  const claim={jobId:job,shortId:short.id,creator:'ak_test',state:'staging',fence:'3',token:randomUUID(),expiresAt:Date.now()+80000,manifest,input:{manifest:{sha256:hash(manifest)}}};
  let handler, saved, count=0;
  global.fetch=async(url,init)=>{
    count++;
    const req=JSON.parse(init.body),phase=new URL(url).pathname.split('-').at(-1);
    assert.ok(Buffer.byteLength(init.body)<32768); assert.ok(!init.body.includes(claim.token));
    assert.equal(req.descriptor.cid,short.cid);assert.equal(req.sourceHash,source);
    const sign=result=>({version:1,result,proof:restagingProof(key,init.body,phase,result)});
    if(phase==='write'){assert.equal(req.expires,claim.expiresAt);assert.equal(req.grant.leaseHash,hash(claim.token));assert.equal(req.grant.fence,claim.fence);}
    return Response.json(handler(req,sign));
  };
  const planRequest=()=>client.planRestaging(scope,source,short,job,signal);
  const write=()=>client.writeRestaging(scope,source,short,claim,refs,signal);
  handler=(_,sign)=>saved=sign(plan);assert.deepEqual(await planRequest(),{hashes,captions:caption.toString()});
  handler=()=>saved;await assert.rejects(planRequest(),/acknowledgement mismatch/);
  handler=(_,sign)=>sign({...plan,captions:Buffer.alloc(8192,66).toString('base64')});await assert.rejects(planRequest(),/captions differ/);
  handler=(_,sign)=>sign({...plan,hashes:hashes.slice(1)});await assert.rejects(planRequest(),/Invalid original restaging plan/);
  const ack={targetHash:restagingTargetHash(refs),parts:96};
  handler=(_,sign)=>saved=sign(ack);await write();
  handler=()=>saved;await assert.rejects(write(),/acknowledgement mismatch/);
  handler=(_,sign)=>sign({...ack,targetHash:hash('other destination')});await assert.rejects(write(),/differ from reservation/);
  claim.expiresAt=Date.now()-50;const previous=count;await assert.rejects(write(),/expired/);assert.equal(count,previous);
});
