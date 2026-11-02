require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const { mkdtemp, rm, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DataSource } = require('typeorm');
const { shortsDeliverySource } = require('./shorts-delivery-source');
const { assertOriginalDeliveryEligible } = require('./shorts-delivery-eligibility');
const { assertDeliveryEligible } = require('./shorts-delivery-eligibility');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { ShortsDeliverySelectionService } = require('./shorts-delivery-selection.service');
const { ShortsDeliveryActivationService } = require('./shorts-delivery-activation.service');
const { ShortsService } = require('./shorts.service');
const { ShortsController } = require('./shorts.controller');
const { ShortsPlaybackEvidenceService } = require('./shorts-playback-evidence.service');
const { LocalShortsAnalyticsService } = require('./shorts-analytics.service');
const { DatabaseSync } = require('node:sqlite');
const { playbackProof } = require('./testing/playback-proof.cjs');
const { shortsPlaybackDescriptor } = require('./shorts-playback-descriptor');
const { packageForDescriptor } = require('./testing/hls-v3-fixture.cjs');
const { sourceKey } = require('./hls-protocol/hls-package');
const { ShortsBackfillService } = require('./shorts-backfill.service');
const { ShortsBackfillBatchesService } = require('./shorts-backfill-batches.service');
const { backfillRequest, backfillCost } = require('./shorts-backfill-plan');
const { ShortsBackfillBatches1793232006000: BatchMigration } = require('../migrations/1793232006000-ShortsBackfillBatches');
const { ShortsLegacyDeliverySelection1793232005000: SelectionMigration } = require('../migrations/1793232005000-ShortsLegacyDeliverySelection');
const { ShortsLegacyDeliverySources1793232003000: Migration } = require('../migrations/1793232003000-ShortsLegacyDeliverySources');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsDeliveryGenerationsService } = require('./shorts-delivery-generations.service');
const { ShortsDeliveryStagingService } = require('./shorts-delivery-staging.service');
const { ShortsOriginalRestagingService } = require('./shorts-original-restaging.service');
const { ShortsPrivateMediaService } = require('./shorts-private-media.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsSourceReaderService } = require('./shorts-source-reader.service');
const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { ShortsRenditionEncodingService } = require('./shorts-rendition-encoding.service');
const { ShortsMediaWorkerService } = require('./shorts-media-worker.service');
const { ShortsWorkerRepositoryService } = require('./shorts-worker-repository.service');
const { workerRole } = require('./testing/worker-role.cjs');
const { hashMediaFile } = require('./shorts-media-file');
const hash = data => createHash('sha256').update(data).digest('hex');

test('backfill cohorts and conservative cost allocations are bounded', () => {
  const budget={replicas:2,maxAdditionalLogicalBytes:20e9,maxEncodingSeconds:18000};
  assert.deepEqual(backfillRequest(['b','a'],budget).ids,['a','b']);
  for(const ids of [[],['a','a'],Array.from({length:11},(_,i)=>`p${i}`),['../bad'],[1]]) assert.throws(()=>backfillRequest(ids,budget));
  for(const change of [{replicas:0},{replicas:9},{maxEncodingSeconds:Infinity},{maxAdditionalLogicalBytes:1.5}])
    assert.throws(()=>backfillRequest(['a'],{...budget,...change}));
  const cost=backfillCost([{sourceBytes:40*1048576}],2);
  assert.equal(cost.encodingSeconds,1800);
  assert.equal(cost.additionalLogicalBytes,2*(cost.privateLogicalBytes+cost.publicLogicalBytes));
  assert(cost.privateLogicalBytes>3*192*1048576+40*1048576);
});

test('legacy source identity uses the retained upload and rejects ambiguous or unverified originals', () => {
  const manifest = { key: `quarantine/source/key1/${hash('manifest')}`, keyId: 'key1', bytes: 100, sha256: hash('manifest') };
  const record = { cid: 'legacy-directory', bytes: 10, safety: { sourceSha256: hash('source') }, privateMedia: { version: 1, fence: '1',
    source: { bytes: 1000, sha256: hash('source'), objectKey: manifest.key, manifest } } };
  assert.deepEqual(shortsDeliverySource(record), { kind: 'retained-upload', bytes: 1000, sha256: hash('source') });
  for (const mutate of [r => delete r.privateMedia, r => delete r.privateMedia.source.manifest,
    r => { r.privateMedia.source.sha256 = hash('different'); }, r => { r.privateMedia.source.acceptedMaxBytes = 999; },
    r => { r.privateMedia.source.processingProfile = 'unknown'; }, r => { r.privateMedia.fence = '9223372036854775808'; },
    r => { r.privateMedia.source.bytes = 41943041; }, r => { r.privateMedia.source.manifest.bytes = 98305; },
    r => { r.original = {}; }, r => { r.privateMedia.source.manifest.key += '/wrong'; }]) {
    const changed = structuredClone(record); mutate(changed); assert.throws(() => shortsDeliverySource(changed));
  }
});

test('retained legacy source is authenticated, restaged and encoded privately without changing published identity', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const directory = await mkdtemp(join(tmpdir(), 'shorts-legacy-backfill-'));
  const schema = 'shorts_legacy_' + randomUUID().replaceAll('-', '');
  const scope = { network: 'ae_uat', contract: 'ct_protocol' }, args = [scope.network, scope.contract], sourceHash = hash('runtime');
  const previousFlag = process.env.SHORTS_LEGACY_BACKFILL_ENABLED;
  const admin = new DataSource({ type: 'postgres', url: url.href });
  let owner, worker, identity, objects, scratch, mediaWorker;
  t.after(async () => {
    if (previousFlag === undefined) delete process.env.SHORTS_LEGACY_BACKFILL_ENABLED; else process.env.SHORTS_LEGACY_BACKFILL_ENABLED = previousFlag;
    await mediaWorker?.onModuleDestroy(); objects?.onModuleDestroy(); scratch?.onModuleDestroy();
    if (worker?.isInitialized) await worker.destroy(); if (owner?.isInitialized) await owner.destroy();
    if (identity) await identity.dispose();
    if (admin.isInitialized) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.destroy(); }
    await rm(directory, { recursive: true, force: true });
  });
  await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 4 } };
  owner = new DataSource(options); await owner.initialize();
  await owner.transaction(async db => {
    for (const name of ['1791763200000-ShortsMetadata','1791763202000-ShortsUploads','1791763203000-ShortsWorkers',
      '1791763204000-ShortsWorkerAuthority','1791763215000-ShortsProcessingCapacity','1791763216000-ShortsRetentionHolds',
      '1791763219000-ShortsHlsInventory','1791763220000-ShortsPinInventory',
      '1791763222000-ShortsWorkerBackpressure','1791763224000-ShortsUploadBudget','1792022400000-ShortsDirectUploads',
      '1793145600000-ShortsOriginalContent','1793145601000-ShortsAdaptiveInventory',
      '1793145602000-ShortsDeliveryPackages','1793145603000-ShortsDeliveryGenerations',
      '1793145605000-ShortsGenerationDeliveryPackages','1793145606000-ShortsDeliveryStaging',
      '1793145607000-ShortsDeliverySelection','1793145608000-ShortsDeliveryInputRetirement',
      '1793145609000-ShortsInputReclamationReservations','1793145610000-ShortsPinTransfers',
      '1793145611000-ShortsInputReclamationPermits','1793145612000-ShortsStorageWriteEpochs',
      '1793232000000-ShortsOriginalUploads','1793232001000-ShortsReclamationRelease','1793232002000-ShortsStorageRecovery'])
      await new (Object.values(require('../migrations/' + name))[0])().up(db);
    await new Migration().up(db);
  });
  await owner.transaction(db => new Migration().down(db)); await owner.transaction(db => new Migration().up(db));
  await owner.transaction(async db => {
    await new (require('../migrations/1793232004000-ShortsLegacyDeliveryPackages').ShortsLegacyDeliveryPackages1793232004000)().up(db);
    await new SelectionMigration().up(db);
  });
  await owner.transaction(db => new SelectionMigration().down(db)); await owner.transaction(db => new SelectionMigration().up(db));
  await owner.transaction(db => new BatchMigration().up(db));
  await owner.transaction(db => new BatchMigration().down(db));
  await owner.transaction(db => new BatchMigration().up(db));
  const metadata = new ShortsMetadataService(owner); await metadata.initialize(scope, sourceHash, 30, 30);
  objects = new ShortsPrivateObjectsService({ endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'unused', prefix: 'quarantine',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, activeKeyId: 'key1', keys: { key1: randomBytes(32) } });
  const stored = new Map(); let writes = 0;
  objects.client.send = async (command, options) => {
    options?.abortSignal?.throwIfAborted(); const input = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      if (stored.has(input.Key)) throw { $metadata: { httpStatusCode: 412 } };
      const chunks = []; for await (const chunk of (Buffer.isBuffer(input.Body) ? [input.Body] : input.Body)) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); assert.equal(bytes.length, input.ContentLength); stored.set(input.Key, bytes); writes++; return {};
    }
    assert.equal(command.constructor.name, 'GetObjectCommand');
    const bytes = stored.get(input.Key); if (!bytes) throw new Error('missing retained object');
    return { Body: Readable.from([bytes]), ContentLength: bytes.length };
  };
  scratch = new ShortsScratchService({ directory: join(directory, 'scratch'), minFreeBytes: 64*1048576, minFreeInodes: 128,
    maxUsedPercent: Number(process.env.SHORTS_TEST_SCRATCH_MAX_USED_PERCENT || 85) }, new ShortsScratchProbeService()); await scratch.onModuleInit();
  const path = join(directory, 'source.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x576:rate=60',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-crf','18','-c:a','aac','-movflags','+faststart',path]);
  const file = await hashMediaFile(path), bytes = await readFile(path), parts = [];
  for(let offset=0,index=0;offset<bytes.length;offset+=1048576,index++)
    parts.push({ index, object: await objects.put(scope, 'legacy', `part/${index}`, bytes.subarray(offset,offset+1048576)) });
  const manifest = await objects.put(scope, 'legacy', 'source-manifest', Buffer.from(JSON.stringify({ version: 1, id: 'legacy', creator: 'ak_creator',
    bytes: file.bytes, sha256: file.sha256, parts })));
  const input = { bytes: file.bytes, sha256: file.sha256, objectKey: manifest.key, manifest, title: 'Original post', topic: 'Art', details: {} };
  const original = { id: 'legacy', creator: 'ak_creator', title: 'Original post', topic: 'Art', duration: 2, createdAt: 1,
    cid: 'Qm'+'a'.repeat(44), bytes: 10, publication: 'published', moderation: 'approved', safety: { status: 'no_flags', sourceSha256: file.sha256 },
    files: [{ name: 'video.mp4', bytes: 10, sha256: hash('old-encode') }], likes: 42, views: ['retained'], reports: 2,
    privateMedia: { version: 1, fence: '1', source: input, files: {} } };
  await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)', [...args, original.id, original.creator, original]);
  identity = await workerRole(admin, { url: url.href, schema, scope });
  worker = new DataSource({ ...options, url: identity.url }); await worker.initialize();
  const repo = new ShortsWorkerRepositoryService(worker, { scope, sourceHash }); await repo.verifyRuntime(scope, sourceHash);
  const staging = new ShortsDeliveryStagingService(owner, metadata), sources = new ShortsSourceReaderService(objects);
  const privateMedia = new ShortsPrivateMediaService(objects, sources, scratch);
  const service = new ShortsOriginalRestagingService(metadata, { withPinnedOriginal: () => assert.fail('legacy directory is not the source file') }, objects, staging, privateMedia);
  const generations = new ShortsDeliveryGenerationsService(owner, metadata);
  await t.test('preparation is disabled by default and corrupt encrypted sources create no jobs or outputs', async () => {
    delete process.env.SHORTS_LEGACY_BACKFILL_ENABLED;
    await assert.rejects(service.restage(scope, 'legacy', 'replacement'), { status: 503 });
    process.env.SHORTS_LEGACY_BACKFILL_ENABLED = 'true';
    const ref = parts[0].object, good = stored.get(ref.key), bad = Buffer.from(good); bad[bad.length-1] ^= 1; stored.set(ref.key, bad);
    const before = writes; await assert.rejects(service.restage(scope, 'legacy', 'corrupt'));
    assert.equal(writes, before); assert.equal((await owner.query('SELECT * FROM shorts_ingestion')).length, 0);
    stored.set(ref.key, good); assert.deepEqual(await readdir(scratch.directory), []); assert.equal((await scratch.snapshot()).reservations, 0);
  });
  await t.test('SQL independently rejects replacement inputs that use compressed metadata or a different source hash', async () => {
    for (const change of [{ bytes: original.bytes }, { sha256: hash('unrelated') }])
      await assert.rejects(metadata.enqueue(scope, 'forged', original.creator, { ...input, processingProfile: 'original-h264-v1', ...change }, undefined, original.id));
    await assert.rejects(worker.query('SELECT shorts_delivery_source($1::jsonb)', [original]), { code: '42501' });
  });
  await t.test('restaging verifies the exact upload, resumes idempotently and enters the low priority queue', async () => {
    assert.equal((await service.restage(scope, 'legacy', 'replacement')).ready, true);
    const before = writes; assert.equal((await service.restage(scope, 'legacy', 'replacement')).ready, true); assert.equal(writes, before);
    const staged = await staging.get(scope, 'replacement'); assert.equal(staged.input.sha256, file.sha256); assert.equal(staged.input.bytes, file.bytes);
    await metadata.enqueue(scope, 'foreground', original.creator, { ...staged.input, title: 'foreground' });
    const upload = await repo.claim(scope); assert.equal(upload.id, 'foreground'); await repo.fail(scope, upload);
    await assert.rejects(owner.transaction(db => new Migration().down(db)), /Preserve legacy delivery preparation history/);
  });
  await t.test('real encoding creates a separate original CID and generation while canonical data remains byte-for-byte unchanged', async () => {
    const job = await repo.claim(scope); assert.equal(job.id, 'replacement'); assert.equal(job.deliveryShortId, 'legacy');
    const packages = new ShortsPackageService();
    const complete = repo.complete.bind(repo);
    repo.complete = async (scope, claim, record) => {
      for (const mutate of [r => { r.original.sha256 = hash('unrelated'); }, r => { r.bytes = original.bytes; }]) {
        const changed = structuredClone(record); mutate(changed); await assert.rejects(complete(scope, claim, changed));
      }
      return complete(scope, claim, record);
    };
    mediaWorker = new ShortsMediaWorkerService({ scope, leaseMs: 120000 }, repo, sources, objects,
      { encode: () => assert.fail('legacy compressed output must not feed another encode') }, packages,
      { scan: async source => { assert.equal(source.sha256, file.sha256); return { status: 'no_flags', sourceSha256: source.sha256 }; } },
      { classify: async () => undefined }, scratch, new ShortsRenditionEncodingService(scratch, packages));
    await mediaWorker.prepare(job, performance.now());
    const generation = await generations.get(scope, job.id); assert.ok(generation);
    assert.equal(generation.shortId, original.id); assert.equal(generation.descriptor.id, original.id);
    assert.equal(generation.record.cid, await packages.originalCid(file)); assert.notEqual(generation.record.cid, original.cid);
    assert.equal(generation.record.original.sha256, file.sha256); assert.equal(generation.record.bytes, file.bytes);
    assert.equal(generation.record.moderation, 'pending'); assert.equal(generation.record.publication, undefined);
    assert.equal(generation.record.derivatives.videos[0].frameRate, '60/1');
    assert.throws(() => assertOriginalDeliveryEligible(original, generation.record), { status: 404 });
    assert.doesNotThrow(() => assertDeliveryEligible(original, generation.record));
    assert.deepEqual(generation.descriptor.canonical,{version:1,cid:original.cid,bytes:original.bytes});
    assert.deepEqual((await owner.query('SELECT body FROM shorts_content'))[0].body, original);
    assert.equal((await owner.query('SELECT count(*) FROM shorts_content'))[0].count, '1');
    assert.equal((await owner.query('SELECT count(*) FROM shorts_delivery_packages'))[0].count, '0');
    assert.equal((await owner.query('SELECT count(*) FROM shorts_delivery_selections'))[0].count, '0');
    await assert.rejects(metadata.getJob(scope, original.creator, job.id), { status: 404 });
    assert.deepEqual((await owner.query('SELECT status,result_id FROM shorts_ingestion WHERE id=$1', [job.id]))[0], { status: 'ready', result_id: original.id });
    assert.deepEqual(await readdir(scratch.directory), []); assert.equal((await scratch.snapshot()).reservations, 0);
  });
  await t.test('source-bound legacy activation retains the old version and rolls back with flags off without changing the post', async () => {
    const env={...process.env}, packages=new ShortsDeliveryPackagesService(owner), selections=new ShortsDeliverySelectionService(owner);
    const candidate=await generations.get(scope,'replacement'), initial=shortsPlaybackDescriptor(original,scope);
    const before={sourceKey:sourceKey(initial),revision:'0'};
    let withdrawn=false, damaged, verified=[];
    const chain={release:scope,state:{contract:scope.contract},read:async()=>({cid:original.cid,creator:original.creator,size:BigInt(original.bytes),withdrawn})};
    const shorts=new ShortsService(chain);
    shorts.records={find:async()=> (await owner.query('SELECT body FROM shorts_content WHERE id=$1',[original.id]))[0].body};
    shorts.deliveryGenerations=generations;shorts.deliverySelection=selections;shorts.deliveryPackages=packages;
    const analyticsDb=new DatabaseSync(':memory:');shorts.analytics=new LocalShortsAnalyticsService({db:analyticsDb});
    const verifier=new ShortsPlaybackEvidenceService(chain), secret=randomBytes(32), session=randomUUID();verifier.key=secret;
    const controller=new ShortsController(shorts,{}, {},undefined,undefined,verifier);
    const watched=descriptor=>{
      const base=JSON.parse(Buffer.from(playbackProof(secret,original,session,scope.contract).split('.')[1],'base64url').toString());
      const payload=Buffer.from(JSON.stringify({...base,v:2,cid:descriptor.cid,sourceKey:sourceKey(descriptor)})).toString('base64url');
      const proof=`m2.${payload}.${createHmac('sha256',secret).update(`shorts-measurement:v2\0${payload}`).digest('base64url')}`;
      return controller.playback(original.id,{id:randomUUID(),session,seconds:10,source:'for-you',proof});
    };
    const media={verifyDurableDelivery:async record=>{verified.push(record.id);if(record.id===damaged)throw new Error('damaged delivery');}};
    let coordinator;
    try {
      assert.deepEqual((await shorts.authorizedGeneration(original.id,'replacement')).descriptor,candidate.descriptor);
      await packages.acknowledge(candidate.descriptor,packageForDescriptor(candidate.descriptor));
      await assert.rejects(owner.transaction(db=>new SelectionMigration().down(db)),/Preserve acknowledged legacy upgrade/);
      assert.deepEqual(await shorts.playbackDescriptor(original.id),initial);
      await assert.rejects(shorts.playbackVersion(original.id,candidate.sourceKey),{status:404});
      process.env.SHORTS_DELIVERY_SELECTION_ENABLED='true';delete process.env.SHORTS_LEGACY_PLAYBACK_ENABLED;
      coordinator=new ShortsDeliveryActivationService(shorts,media,selections);
      await assert.rejects(coordinator.select(original.id,candidate.sourceKey,before,randomUUID()),{status:503});
      assert.deepEqual(verified,[]);await coordinator.onModuleDestroy();
      process.env.SHORTS_LEGACY_PLAYBACK_ENABLED='true';coordinator=new ShortsDeliveryActivationService(shorts,media,selections);
      await assert.rejects(coordinator.select(original.id,candidate.sourceKey,before,randomUUID()),{status:404});
      await packages.acknowledge(initial,require('./testing/hls-v2.json').package);
      for(const patch of [{title:'unreviewed title'},{safety:{status:'no_flags',sourceSha256:hash('changed source')}}]) {
        await assert.rejects(owner.transaction(async db=>{
          await db.query('UPDATE shorts_content SET body=body||$2::jsonb WHERE id=$1',[original.id,patch]);
          await db.query(`INSERT INTO shorts_delivery_selections(network,contract,short_id,revision,operation_id,from_source_key,source_key,kind)
            VALUES($1,$2,$3,1,$4,$5,$6,'activate')`,[...args,original.id,randomUUID(),before.sourceKey,candidate.sourceKey]);
        }));
      }
      damaged=original.id;await assert.rejects(coordinator.select(original.id,candidate.sourceKey,before,randomUUID()),/damaged/);
      damaged=undefined;verified=[];
      const operation=randomUUID(), active=await coordinator.select(original.id,candidate.sourceKey,before,operation);
      assert.deepEqual(verified,['replacement',original.id]);assert.equal(active.revision,'1');
      assert.deepEqual(await coordinator.select(original.id,candidate.sourceKey,before,operation),active);
      assert.deepEqual(await shorts.playbackDescriptor(original.id),candidate.descriptor);
      assert.equal((await watched(candidate.descriptor)).views,1);
      assert.deepEqual(await shorts.playbackVersion(original.id,before.sourceKey),initial);
      assert.equal((await shorts.playbackPackage(original.id,before.sourceKey)).prepared.version,undefined);
      await assert.rejects(selections.commit(scope,original.id,before,candidate.sourceKey,randomUUID(),'activate'),{code:'SH409'});
      await coordinator.onModuleDestroy();delete process.env.SHORTS_DELIVERY_SELECTION_ENABLED;delete process.env.SHORTS_LEGACY_PLAYBACK_ENABLED;
      coordinator=new ShortsDeliveryActivationService(shorts,media,selections);damaged='replacement';verified=[];
      const rollback=await coordinator.select(original.id,before.sourceKey,active,randomUUID(),'rollback');assert.equal(rollback.revision,'2');
      assert.deepEqual(verified,[original.id]);assert.deepEqual(await shorts.playbackDescriptor(original.id),initial);
      assert.equal((await watched(initial)).views,1,'one viewer/post/day survives changing delivery CID and rolling back');
      assert.equal(analyticsDb.prepare('SELECT short_id FROM shorts_plays').get().short_id,original.id);
      assert.deepEqual(await shorts.playbackVersion(original.id,candidate.sourceKey),candidate.descriptor);
      withdrawn=true;await assert.rejects(shorts.playbackVersion(original.id,candidate.sourceKey),{status:404});
      await assert.rejects(shorts.authorizedGeneration(original.id,'replacement'),{status:404});withdrawn=false;
      assert.deepEqual((await owner.query('SELECT body FROM shorts_content'))[0].body,original);
    } finally {await coordinator?.onModuleDestroy();analyticsDb.close();process.env=env;}
  });
  await t.test('bounded batches resume, yield to uploads, preserve policy and cancel activation at the SQL boundary', async () => {
    const env={...process.env}, budget={replicas:2,maxAdditionalLogicalBytes:20e9,maxEncodingSeconds:18000};
    const batches=new ShortsBackfillBatchesService(owner), selections=new ShortsDeliverySelectionService(owner), packages=new ShortsDeliveryPackagesService(owner);
    let withdrawn=false, waitVerification;
    const chain={release:scope,state:{contract:scope.contract},read:async()=>({cid:original.cid,creator:original.creator,size:BigInt(original.bytes),withdrawn})};
    const shorts=new ShortsService(chain);
    shorts.records={find:async id=>(await owner.query('SELECT body FROM shorts_content WHERE id=$1',[id]))[0]?.body};
    shorts.deliveryGenerations=generations;shorts.deliverySelection=selections;shorts.deliveryPackages=packages;
    const media={verifyDurableDelivery:async()=>{if(waitVerification)await waitVerification();}};
    let activation, coordinator;
    try {
      process.env.SHORTS_LEGACY_BACKFILL_ENABLED='true';process.env.SHORTS_LEGACY_PLAYBACK_ENABLED='true';process.env.SHORTS_DELIVERY_SELECTION_ENABLED='true';
      activation=new ShortsDeliveryActivationService(shorts,media,selections);
      let acknowledgements=0, loseReply=true;
      const prepare={prepare:async(id,job,signal,authorize)=>{
        await authorize();signal.throwIfAborted();const generation=await shorts.authorizedGeneration(id,job);
        await packages.acknowledge(generation.descriptor,packageForDescriptor(generation.descriptor));acknowledgements++;
        return {status:'ready',sourceKey:generation.sourceKey};
      }};
      const activate={select:async(...args)=>{const saved=await activation.select(...args);if(loseReply){loseReply=false;throw Error('lost activation reply');}return saved;}};
      delete process.env.SHORTS_BACKFILL_ENABLED;
      coordinator=new ShortsBackfillService(shorts,batches,selections,service,prepare,activate);
      const plan=await coordinator.dryRun(['legacy','missing'],budget);
      assert.equal(plan.items.length,1);assert.deepEqual(plan.skipped,[{id:'missing',reason:'not_available'}]);
      assert.equal(plan.cost.retainedSourceBytes,file.bytes);
      await assert.rejects(coordinator.start(randomUUID(),['legacy','missing'],budget,plan.hash),{status:503});
      await coordinator.onModuleDestroy();process.env.SHORTS_BACKFILL_ENABLED='true';
      coordinator=new ShortsBackfillService(shorts,batches,selections,service,prepare,activate);
      const tiny={...budget,maxAdditionalLogicalBytes:1}, expensive=await coordinator.dryRun(['legacy'],tiny);
      await assert.rejects(coordinator.start(randomUUID(),['legacy'],tiny,expensive.hash),/accepted budget/);
      const id=randomUUID(), batch=await coordinator.start(id,['legacy','missing'],budget,plan.hash);
      assert.deepEqual(await coordinator.start(id,['missing','legacy'],budget,plan.hash),batch);
      await assert.rejects(coordinator.start(id,['legacy'],budget,plan.hash),/already used/);
      await assert.rejects(coordinator.start(randomUUID(),['legacy','missing'],budget,plan.hash),/already running/);
      await assert.rejects(worker.query('SELECT * FROM shorts_backfill_batches'),{code:'42501'});
      await assert.rejects(owner.transaction(db=>new BatchMigration().down(db)),/Preserve backfill history/);
      await assert.rejects(owner.query('UPDATE shorts_backfill_items SET plan=$1',[{}]),/immutable/);
      // One distributed lease at a time; an expired coordinator cannot advance a successor.
      const old=await batches.claim(scope,id);assert(old);assert.equal(await batches.claim(scope,id),undefined);
      await owner.query("UPDATE shorts_backfill_batches SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
      const fresh=await batches.claim(scope,id);assert(fresh&&fresh!==old);
      await assert.rejects(batches.finish(scope,id,old),/claim changed/);await batches.finish(scope,id,fresh);
      const input=(await staging.get(scope,'replacement')).input;
      await metadata.enqueue(scope,'batch-foreground',original.creator,input);
      assert.equal((await coordinator.advance(id)).items[0].phase,'planned');
      assert.equal(await batches.job(scope,batch.items[0].job_id),undefined);
      await metadata.cancel(scope,original.creator,'batch-foreground');
      withdrawn=true;assert.equal((await coordinator.advance(id)).items[0].failures,1);withdrawn=false;
      assert.equal(await batches.job(scope,batch.items[0].job_id),undefined);
      assert.equal((await coordinator.advance(id)).items[0].phase,'preparing');
      // Restart the coordinator while the separately fenced worker is queued.
      await coordinator.onModuleDestroy();coordinator=new ShortsBackfillService(shorts,batches,selections,service,prepare,activate);
      assert.equal((await coordinator.advance(id)).items[0].phase,'preparing');
      const encode=async expected=>{const job=await repo.claim(scope);assert.equal(job.id,expected);await mediaWorker.prepare(job,performance.now());};
      await encode(batch.items[0].job_id);
      assert.equal((await coordinator.advance(id)).items[0].phase,'ready');assert.equal(acknowledgements,1);
      const completed=await coordinator.advance(id);assert.equal(completed.status,'completed');assert.equal(completed.items[0].phase,'activated');
      assert.equal((await owner.query('SELECT count(*) FROM shorts_delivery_selections WHERE operation_id=$1',[batch.items[0].operation_id]))[0].count,'1');
      assert.equal((await coordinator.advance(id)).status,'completed');
      assert.deepEqual((await owner.query('SELECT body FROM shorts_content WHERE id=$1',['legacy']))[0].body,original);
      const initialKey=sourceKey(shortsPlaybackDescriptor(original,scope));
      await activation.select('legacy',initialKey,await selections.state(scope,original),randomUUID(),'rollback');
      const nextPlan=await coordinator.dryRun(['legacy'],budget), nextId=randomUUID();
      const next=await coordinator.start(nextId,['legacy'],budget,nextPlan.hash);
      await coordinator.advance(nextId);await encode(next.items[0].job_id);await coordinator.advance(nextId);
      let enter, release;const entered=new Promise(resolve=>enter=resolve), gate=new Promise(resolve=>release=resolve);
      waitVerification=async()=>{enter();await gate;};
      const running=coordinator.advance(nextId);await entered;
      const cancelled=await coordinator.cancel(nextId);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.items[0].phase,'cancelled');
      release();await running;waitVerification=undefined;
      assert.equal((await selections.state(scope,original)).sourceKey,initialKey);
      assert.equal(await selections.operation(scope,'legacy',next.items[0].operation_id),undefined);
      assert.deepEqual(await coordinator.cancel(nextId),cancelled);
      const queuedPlan=await coordinator.dryRun(['legacy'],budget), queuedId=randomUUID();
      const queued=await coordinator.start(queuedId,['legacy'],budget,queuedPlan.hash);
      await coordinator.advance(queuedId);
      assert.equal((await batches.job(scope,queued.items[0].job_id)).status,'queued');
      await coordinator.cancel(queuedId);
      assert.equal((await batches.job(scope,queued.items[0].job_id)).status,'cancelled');
      assert.equal(await repo.claim(scope),undefined);
      const processingPlan=await coordinator.dryRun(['legacy'],budget), processingId=randomUUID();
      const processing=await coordinator.start(processingId,['legacy'],budget,processingPlan.hash);
      await coordinator.advance(processingId);
      const claimed=await repo.claim(scope);assert.equal(claimed.id,processing.items[0].job_id);
      await coordinator.cancel(processingId);
      assert.equal(await repo.heartbeat(scope,claimed),false);
      assert.equal((await batches.job(scope,claimed.id)).status,'cancelled');
      // Retained holds are visible in dry runs; cancelled queued jobs cannot be claimed.
      await owner.query("INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference) VALUES($1,$2,$3,'legacy','recovery','fixture')",[...args,randomUUID()]);
      const held=await coordinator.dryRun(['legacy'],budget);assert.equal(held.items.length,0);assert.equal(held.skipped[0].reason,'retention_hold');
      assert.deepEqual((await owner.query('SELECT body FROM shorts_content WHERE id=$1',['legacy']))[0].body,original);
    } finally {await coordinator?.onModuleDestroy();await activation?.onModuleDestroy();process.env=env;}
  });
});
