const schemaMigrations = require('./testing/historical-migrations.cjs');
const {
  ShortsLegacyDeliveryPackages: Migration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { DataSource } = require('typeorm');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { ShortsDeliveryAcknowledgementService } = require('./shorts-delivery-acknowledgement.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { ShortsPinTransfersService } = require('./shorts-pin-transfers.service');
const { deliverySourceIdentity } = require('./hls-protocol/playback-descriptor');
const { sourceKey, validateSourcePackage } = require('./hls-protocol/hls-package');
const { workerRole } = require('./testing/worker-role.cjs');
const golden = require('./testing/hls-v2.json');
const adaptive = require('./testing/hls-v3.json');

test('legacy acknowledgement preserves the v2 key, binds scope and all source files, and rejects format confusion', () => {
  assert.equal(sourceKey(golden.descriptor), golden.sourceKey);
  assert.equal(deliverySourceIdentity(golden.descriptor), golden.sourceIdentity);
  const value = structuredClone(golden.package); value.private = 'omitted'; value.files[0].private = 'omitted';
  assert.doesNotMatch(JSON.stringify(validateSourcePackage(golden.descriptor, value)), /private|omitted/);
  const reordered = { ...golden.descriptor, files: [...golden.descriptor.files].reverse() };
  assert.equal(deliverySourceIdentity(reordered), golden.sourceIdentity);
  for (const change of [{ cid: golden.descriptor.cid }, { version: 3 }, { playlists: {} }, { extra: 'x'.repeat(131072) }])
    assert.throws(() => validateSourcePackage(golden.descriptor, { ...golden.package, ...change }));
  for (const change of [{ network: undefined }, { contract: undefined }, { original: {} }, { derivatives: {} },
    { files: golden.descriptor.files.filter(f => f.name !== 'video.mp4') }])
    assert.throws(() => deliverySourceIdentity({ ...golden.descriptor, ...change }));
  assert.throws(() => validateSourcePackage(adaptive.descriptor, golden.package));
  assert.throws(() => validateSourcePackage(golden.descriptor, adaptive.package));
});

test('PostgreSQL retains a physically verified legacy package without changing canonical identity or enabling selection', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const env = { ...process.env }, schema = 'shorts_legacy_delivery_' + randomUUID().replaceAll('-', '');
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 4 } };
  let db = new DataSource(options), worker, identity, media, server; await db.initialize();
  t.after(async () => {
    await media?.onModuleDestroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (worker?.isInitialized) await worker.destroy(); if (identity) await identity.dispose();
    if (db.isInitialized) await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); process.env = env;
  });
  await db.transaction(async runner => {
    for (const name of ['ShortsMetadata','ShortsUploads','ShortsWorkers',
      'ShortsWorkerAuthority','ShortsProcessingCapacity','ShortsRetentionHolds',
      'ShortsHlsInventory','ShortsPinInventory','ShortsWorkerBackpressure',
      'ShortsUploadBudget','ShortsDirectUploads','ShortsOriginalContent',
      'ShortsAdaptiveInventory','ShortsDeliveryPackages','ShortsDeliveryGenerations',
      'ShortsGenerationDeliveryPackages','ShortsDeliveryStaging','ShortsDeliverySelection',
      'ShortsDeliveryInputRetirement','ShortsInputReclamationReservations','ShortsPinTransfers',
      'ShortsInputReclamationPermits','ShortsStorageWriteEpochs','ShortsOriginalUploads',
      'ShortsReclamationRelease','ShortsStorageRecovery','ShortsLegacyDeliverySources'])
      await new schemaMigrations[name]().up(runner);
    await new Migration().up(runner);
  });
  await db.transaction(r => new Migration().down(r)); await db.transaction(r => new Migration().up(r));
  const descriptor = structuredClone(golden.descriptor), scope = { network: descriptor.network, contract: descriptor.contract };
  await db.query('INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,4)',
    [scope.network,scope.contract,'a'.repeat(64)]);
  const record = { ...descriptor, bytes: 200, creator: 'ak_creator', createdAt: 1, publication: 'published', moderation: 'approved',
    safety: { status: 'no_flags' }, views: ['existing'], likes: 42, reports: 2 };
  const insert = r => db.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [r.network,r.contract,r.id,r.creator,r]);
  await insert(record);
  await insert({ ...adaptive.descriptor, creator: record.creator, createdAt: 1, publication: 'published' });
  let packages = new ShortsDeliveryPackagesService(db);
  const args = [scope.network,scope.contract,record.id,golden.sourceKey,golden.sourceIdentity,JSON.stringify(golden.package)];
  const rawInsert = values => db.query('INSERT INTO shorts_delivery_packages(network,contract,short_id,source_key,source_identity,prepared) VALUES($1,$2,$3,$4,$5,$6)',values);
  await t.test('SQL rejects altered source identity, unknown versions, format substitution and package/source aliasing', async () => {
    for (const change of [{ cid: adaptive.descriptor.cid }, { files: descriptor.files.map(f => ({ ...f, sha256: '0'.repeat(64) })) }]) {
      const changed = { ...descriptor, ...change };
      await assert.rejects(packages.acknowledge(changed,golden.package), { code: 'SH409' });
    }
    await assert.rejects(rawInsert(args.map((v,i) => i===3 ? '0'.repeat(64) : v)), { code: 'SH409' });
    await assert.rejects(rawInsert(args.map((v,i) => i===5 ? JSON.stringify({ ...golden.package, cid: record.cid }) : v)), { code: 'SH409' });
    await assert.rejects(rawInsert(args.map((v,i) => i===5 ? JSON.stringify({ ...golden.package, version: 2 }) : v)), { code: 'SH409' });
    await assert.rejects(rawInsert([adaptive.descriptor.network,adaptive.descriptor.contract,adaptive.descriptor.id,adaptive.sourceKey,
      deliverySourceIdentity(adaptive.descriptor),JSON.stringify(golden.package)]), { code: 'SH409' });
    await packages.acknowledge(adaptive.descriptor,adaptive.package);
  });
  const data = new Map(Object.entries({ 'video.mp4':'legacy video','poster.jpg':'legacy poster','captions.vtt':'WEBVTT\n',
    'index.m3u8':golden.package.playlist,'init.mp4':'legacy init','segment-000.m4s':'legacy segment' }).map(([k,v]) => [k,Buffer.from(v)]));
  const pins = new Set([record.cid,golden.package.cid]); let corrupt, unpinAfterRead, reads=0, active=0;
  server = createServer((req,res) => {
    const url = new URL(req.url,'http://fixture'), arg=url.searchParams.get('arg');
    if (url.pathname==='/api/v0/pin/ls') {
      if (pins.has(arg)) return res.end(JSON.stringify({ Keys: { [arg]: { Type:'recursive' } } }));
      res.writeHead(500); return res.end(JSON.stringify({ Code:0,Message:`path '${arg}' is not pinned` }));
    }
    assert.equal(url.pathname,'/api/v0/cat'); assert.equal(req.method,'POST');
    const [cid,name]=arg.split('/'); assert.ok(pins.has(cid)); reads++;
    const bytes=Buffer.from(data.get(name)); if(name===corrupt)bytes[0]^=1;
    if(unpinAfterRead)pins.delete(unpinAfterRead); res.write(bytes.subarray(0,2));res.end(bytes.subarray(2));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  Object.assign(process.env,{ NODE_ENV:'test',SHORTS_IPFS_API:`http://127.0.0.1:${server.address().port}/api/v0` });
  delete process.env.SHORTS_IPFS_TOKEN_FILE; delete process.env.SHORTS_IPFS_EXPIRING_WRITES;
  media=new ShortsMediaService({},undefined,{shared:true},undefined,{ acquire:async()=>{active++;return{signal:new AbortController().signal,release:async()=>{active--;}};} });
  let authority=true;
  const recheck=async()=>{if(!authority)throw new Error('withdrawn');};
  let acknowledgements=new ShortsDeliveryAcknowledgementService(media,packages);
  const acknowledge=()=>acknowledgements.acknowledge(record,descriptor,golden.package,recheck,new AbortController().signal);
  await t.test('canonical file and segment corruption cannot become a durable rollback target',async()=>{
    for(const name of ['video.mp4','poster.jpg','segment-000.m4s']) {
      corrupt=name;await assert.rejects(acknowledge(),/integrity/);assert.equal(await packages.get(descriptor),undefined);assert.equal(active,0);
    }
    corrupt=undefined;unpinAfterRead=golden.package.cid;
    await assert.rejects(acknowledge(),/not recursively pinned/);assert.equal(active,0);
    unpinAfterRead=undefined;pins.add(golden.package.cid);
    const wrong=structuredClone(descriptor);wrong.files.find(f=>f.name==='poster.jpg').sha256='0'.repeat(64);
    const before=reads;await assert.rejects(media.verifyDurableDelivery(record,wrong,golden.package),/source mismatch/);assert.equal(reads,before);
    authority=false;await assert.rejects(acknowledge(),/withdrawn/);assert.equal(reads,before);authority=true;
  });
  await t.test('verified retries converge, canonical bytes and engagement stay unchanged, and reconnect recovers the index',async()=>{
    await acknowledge();await acknowledge();assert.equal(active,0);
    const expected=validateSourcePackage(descriptor,golden.package);
    assert.deepEqual(await packages.get(descriptor),expected);
    await Promise.all(Array.from({length:6},()=>packages.acknowledge(descriptor,golden.package)));
    const [row]=await db.query('SELECT body FROM shorts_content WHERE id=$1',[record.id]);assert.deepEqual(row.body,record);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM shorts_delivery_selections'))[0].n,0);
    assert.equal((await db.query('SELECT generation_job_id FROM shorts_delivery_packages WHERE short_id=$1',[record.id]))[0].generation_job_id,record.id);
    await db.destroy();db=new DataSource(options);await db.initialize();packages=new ShortsDeliveryPackagesService(db);
    acknowledgements=new ShortsDeliveryAcknowledgementService(media,packages);
    assert.deepEqual(await packages.get(descriptor),expected);
    await assert.rejects(packages.acknowledge(descriptor,{...golden.package,cid:'bafy'+'g'.repeat(50)}),{status:409});
    const inventory=await new ShortsRetentionService(db,{scope,sourceHash:'a'.repeat(64)}).inventory();
    const retained=inventory.items.find(i=>i.id===record.id);assert.equal(retained.pins.find(p=>p.kind==='hls').cid,golden.package.cid);
  });
  await t.test('fresh expiring authority is settled atomically and stale adoption cannot acknowledge legacy HLS',async()=>{
    process.env.SHORTS_IPFS_EXPIRING_WRITES='true';
    try {
      const other={...record,id:'guarded-legacy'}, source={...descriptor,id:other.id};await insert(other);
      const transfers=new ShortsPinTransfersService(db), issued=[], begin=transfers.begin.bind(transfers);
      transfers.begin=async(...args)=>{const receipt=await begin(...args);issued.push(receipt);return receipt;};
      const guarded=new ShortsDeliveryAcknowledgementService(media,packages,transfers);
      let checks=0;
      await assert.rejects(guarded.acknowledge(other,source,golden.package,async()=>{
        if(++checks===2)await transfers.finish(issued.at(-1).operationId,'rejected');
      },new AbortController().signal),{status:409});
      assert.equal(await packages.get(source),undefined);assert.equal((await transfers.get(issued[0].operationId)).state,'rejected');
      await guarded.acknowledge(other,source,golden.package,recheck,new AbortController().signal);
      assert.equal((await transfers.get(issued[1].operationId)).state,'pinned');assert.ok(await packages.get(source));
      assert.equal(issued[1].sourceKey,sourceKey(source));assert.equal(issued[1].jobId,other.id);
      await guarded.acknowledge(other,source,golden.package,recheck,new AbortController().signal);assert.equal(issued.length,2);
    } finally {delete process.env.SHORTS_IPFS_EXPIRING_WRITES;}
  });
  await t.test('legacy acknowledgement remains immutable and inaccessible to media workers',async()=>{
    identity=await workerRole(admin,{url:url.href,schema,scope});worker=new DataSource({...options,url:identity.url});await worker.initialize();
    await assert.rejects(worker.query('SELECT * FROM shorts_delivery_packages'),{code:'42501'});
    for(const sql of ['UPDATE shorts_delivery_packages SET acknowledged_at=clock_timestamp()','DELETE FROM shorts_delivery_packages','TRUNCATE shorts_delivery_packages CASCADE'])
      await assert.rejects(db.query(sql),{code:'SH409'});
    await assert.rejects(db.query('TRUNCATE shorts_delivery_packages'),{code:'0A000'});
    await assert.rejects(db.transaction(r=>new Migration().down(r)),/Preserve acknowledged legacy/);
  });
});
