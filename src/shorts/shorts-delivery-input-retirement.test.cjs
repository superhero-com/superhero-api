require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { ShortsDeliveryGenerationsService } = require('./shorts-delivery-generations.service');
const { ShortsDeliverySelectionService } = require('./shorts-delivery-selection.service');
const { ShortsDeliveryInputRetirementService } = require('./shorts-delivery-input-retirement.service');
const { ShortsDeliveryRetirementService } = require('./shorts-delivery-retirement.service');
const { ShortsWorkerRepositoryService } = require('./shorts-worker-repository.service');
const { ShortsDeliveryInputRetirement1793145608000: Migration } = require('../migrations/1793145608000-ShortsDeliveryInputRetirement');
const { ShortsInputReclamationReservations1793145609000: ReservationsMigration } = require('../migrations/1793145609000-ShortsInputReclamationReservations');
const { ShortsInputReclamationReservationsService } = require('./shorts-input-reclamation-reservations.service');
const { ShortsPinTransfersService } = require('./shorts-pin-transfers.service');
const { ShortsPinTransfers1793145610000: TransfersMigration } = require('../migrations/1793145610000-ShortsPinTransfers');
const { ShortsInputReclamationPermits1793145611000: PermitsMigration } = require('../migrations/1793145611000-ShortsInputReclamationPermits');
const { ShortsInputReclamationPermitsService } = require('./shorts-input-reclamation-permits.service');
const { ShortsStorageWriteEpochs1793145612000: EpochsMigration } = require('../migrations/1793145612000-ShortsStorageWriteEpochs');
const { workerRole } = require('./testing/worker-role.cjs');
const golden = structuredClone(require('./testing/hls-v3.json'));
const legacyInputCid='QmPVGjYFugq4XUyBfoTHG6c3qxfBS26jEdaFM1gdAVuMZ2';
golden.descriptor.derivatives.cid='bafybeiarceirceirceirceirceirceirceirceirceirceirceirceirce';
golden.sourceKey=require('./hls-protocol/hls-package').sourceKey(golden.descriptor);
const hash = value => createHash('sha256').update(value).digest('hex');

test('input retirement preserves original identity and delivery while enforcing durable policy', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_retire_' + randomUUID().replaceAll('-', ''), scope = { network: 'ae_uat', contract: 'ct_protocol' };
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 } };
  const owner = new DataSource(options); await owner.initialize(); let identity, workerDb;
  t.after(async () => { await workerDb?.destroy(); await owner.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await identity?.dispose(); await admin.destroy(); });
  await owner.transaction(async db => {
    for (const name of ['1791763200000-ShortsMetadata', '1791763202000-ShortsUploads', '1791763203000-ShortsWorkers',
      '1791763204000-ShortsWorkerAuthority', '1791763215000-ShortsProcessingCapacity', '1791763216000-ShortsRetentionHolds',
      '1791763219000-ShortsHlsInventory', '1791763220000-ShortsPinInventory', '1791763222000-ShortsWorkerBackpressure',
      '1791763224000-ShortsUploadBudget', '1793145600000-ShortsOriginalContent', '1793145601000-ShortsAdaptiveInventory',
      '1793145602000-ShortsDeliveryPackages', '1793145603000-ShortsDeliveryGenerations',
      '1793145605000-ShortsGenerationDeliveryPackages', '1793145606000-ShortsDeliveryStaging', '1793145607000-ShortsDeliverySelection'])
      await new (Object.values(require('../migrations/' + name))[0])().up(db);
    await new Migration().up(db);
  });
  await owner.transaction(db => new Migration().down(db)); await owner.transaction(db => new Migration().up(db));
  await owner.transaction(db=>new ReservationsMigration().up(db));
  await owner.transaction(db=>new TransfersMigration().up(db));
  await owner.transaction(db=>new PermitsMigration().up(db));
  await owner.transaction(db=>new EpochsMigration().up(db));
  await owner.transaction(db=>new EpochsMigration().down(db));
  await owner.transaction(db=>new PermitsMigration().down(db));
  await owner.transaction(db=>new TransfersMigration().down(db));
  await owner.transaction(db=>new ReservationsMigration().down(db));
  await owner.transaction(db=>new ReservationsMigration().up(db));
  await owner.transaction(db=>new TransfersMigration().up(db));
  await owner.transaction(db=>new PermitsMigration().up(db));
  await owner.transaction(db=>new EpochsMigration().up(db));
  const original = { ...structuredClone(golden.descriptor), creator: 'ak_creator', title: 'Original title', topic: 'Art', duration: 4,
    publication: 'published', moderation: 'approved', safety: { status: 'no_flags', sourceSha256: golden.descriptor.original.sha256 },
    createdAt: 1, reports: 0, views: ['existing-view'], likes: 42 };
  const args = [scope.network, scope.contract, original.id], sourceHash = 'a'.repeat(64);
  const metadata = new ShortsMetadataService(owner); await metadata.initialize(scope, sourceHash, 30, 30);
  await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [...args, original.creator, JSON.stringify(original)]);
  identity = await workerRole(admin, { url: url.href, schema, scope });
  workerDb = new DataSource({ ...options, url: identity.url }); await workerDb.initialize();
  const worker = new ShortsWorkerRepositoryService(workerDb, { scope, sourceHash }); await worker.verifyRuntime(scope,sourceHash);
  const generations = new ShortsDeliveryGenerationsService(owner,metadata), packages = new ShortsDeliveryPackagesService(owner);
  const selections = new ShortsDeliverySelectionService(owner), retirements = new ShortsDeliveryInputRetirementService(owner);
  const scopeHash = hash(JSON.stringify([scope.network,scope.contract]));
  const makeCandidate = async id => {
    const key = `shorts-private-v1/${scopeHash}/${id}/source-manifest/key1/${sourceHash}`;
    const input = { processingProfile: 'original-h264-v1', objectKey: key, manifest: { key,keyId:'key1',bytes:100,sha256:sourceHash },
      sha256:original.original.sha256,bytes:original.bytes,title:original.title,topic:original.topic,details:{} };
    await generations.enqueue(scope,id,original.id,input);
    const job = await worker.claim(scope); assert.equal(job.id,id);
    const record = { ...structuredClone(original),id,publication:undefined,moderation:'pending',derivatives:{ ...structuredClone(original.derivatives),
      fingerprint:hash(id),generation:{job:id,fence:job.fence} } };
    record.privateMedia={version:1,fence:job.fence,source:job.input,files:Object.fromEntries(record.files.map(file=>[file.name,
      {bytes:file.bytes,sha256:file.sha256,keyId:'key1',key:`shorts-private-v1/${scopeHash}/${id}/attempt/${job.fence}/${file.name.replaceAll('.','-')}/key1/${file.sha256}`}]))};
    await worker.complete(scope,job,record);
    const candidate=await generations.get(scope,id); await packages.acknowledge(candidate.descriptor,golden.package); return candidate;
  };
  await packages.acknowledge(golden.descriptor,golden.package);
  const candidate=await makeCandidate('replacement-inputs'), unused=await makeCandidate('unselected-inputs');
  const count=async()=> (await owner.query('SELECT count(*)::integer AS n FROM shorts_delivery_input_retirements'))[0].n;
  // Owner-only time travel in an isolated schema; no production API can alter these clocks.
  const age=async(table,trigger,column)=>owner.transaction(async db=>{
    await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await db.query(`UPDATE ${table} SET ${column}=clock_timestamp()-interval '2 hours'`);
    await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  });
  const patch=body=>owner.query('UPDATE shorts_content SET body=$4::jsonb WHERE network=$1 AND contract=$2 AND id=$3',[...args,JSON.stringify(body)]);
  const hold=async(resource,db=owner)=>{
    const id=randomUUID(); await db.query(`INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
      VALUES($1,$2,$3,$4,'recovery','owned-fixture')`,[...args.slice(0,2),id,resource]); return id;
  };
  const release=id=>owner.query('UPDATE shorts_retention_holds SET released_by=current_user,released_at=clock_timestamp() WHERE id=$1',[id]);

  await t.test('fresh acknowledgement, unknown identity and unselected candidate retain their inputs',async()=>{
    await assert.rejects(retirements.commit(scope,original.id,golden.sourceKey,randomUUID()),{code:'SH409'});
    await assert.rejects(retirements.commit(scope,original.id,'f'.repeat(64),randomUUID()),{status:409});
    await age('shorts_delivery_packages','shorts_delivery_package_guard','acknowledged_at');
    await assert.rejects(retirements.commit(scope,original.id,unused.sourceKey,randomUUID()),{code:'SH409'});
    await assert.rejects(owner.query(`INSERT INTO shorts_delivery_input_retirements
      (network,contract,short_id,source_key,operation_id,input_cid,generation_job_id) VALUES($1,$2,$3,$4,$5,$6,$3)`,
      [...args,golden.sourceKey,randomUUID(),original.cid]),{code:'SH409'});
    assert.equal(await count(),0);
  });
  await t.test('holds, reports, appeal and withdrawn or rejected content prevent retirement',async()=>{
    const h=await hold(original.id);
    await assert.rejects(retirements.commit(scope,original.id,golden.sourceKey,randomUUID()),{code:'SH409'}); await release(h);
    for(const change of [{reports:1},{reportDetails:[{reason:'test'}]},{appeal:{status:'pending'}},
      {publication:'withdrawn'},{moderation:'rejected'},{safety:{status:'error'}}]){
      await patch({...original,...change});
      await assert.rejects(retirements.commit(scope,original.id,golden.sourceKey,randomUUID()),{code:'SH409'});
      await patch(original);
    }
    assert.equal(await count(),0);
  });
  await t.test('selection restarts the input retention window for both old and new delivery',async()=>{
    await selections.commit(scope,original.id,{sourceKey:golden.sourceKey,revision:'0'},candidate.sourceKey,randomUUID(),'activate');
    for(const key of [golden.sourceKey,candidate.sourceKey])
      await assert.rejects(retirements.commit(scope,original.id,key,randomUUID()),{code:'SH409'});
    await age('shorts_delivery_selections','shorts_delivery_selection_guard','selected_at');
    const h=await hold(candidate.record.id);
    await assert.rejects(retirements.commit(scope,original.id,candidate.sourceKey,randomUUID()),{code:'SH409'}); await release(h);
    await patch({...original,title:'Changed after selection'});
    await assert.rejects(retirements.commit(scope,original.id,candidate.sourceKey,randomUUID()),{code:'SH409'});await patch(original);
  });
  let receipt;
  await t.test('concurrent receipt retry retires exactly one logical input reference and changes no content',async()=>{
    const operation=randomUUID();
    const results=await Promise.all([retirements.commit(scope,original.id,golden.sourceKey,operation),retirements.commit(scope,original.id,golden.sourceKey,operation)]);
    assert.deepEqual(results[0],results[1]); receipt=results[0];
    assert.equal(receipt.inputCid,original.derivatives.cid); assert.equal(receipt.generationJobId,original.id);
    assert.equal(await count(),1); assert.deepEqual(await retirements.operation(scope,original.id,operation),receipt);
    await assert.rejects(retirements.commit(scope,original.id,candidate.sourceKey,operation),{status:409});
    await assert.rejects(retirements.commit(scope,original.id,golden.sourceKey,randomUUID()),{status:409});
    assert.equal(await retirements.get({...scope,network:'ae_mainnet'},original.id,golden.sourceKey),undefined);
    assert.deepEqual((await owner.query('SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',args))[0].body,original);
    assert.equal((await selections.current(scope,original)).sourceKey,candidate.sourceKey);
    assert.equal((await packages.get(golden.descriptor)).cid,golden.package.cid);
    assert.equal(await retirements.get(scope,original.id,candidate.sourceKey),undefined,'shared CID alone must not retire another generation');
  });
  await t.test('verified coordinator retires the other generation without restoring inputs and retries without I/O',async()=>{
    const saved=process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED; process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED='true';
    let checks=0, fail=false, withdrawn=false;
    const shorts={chain:{release:scope,state:{contract:scope.contract}},ensurePlayable:async()=>{
      if(withdrawn)throw new Error('withdrawn'); return original;
    }};
    const media={verifyDurableDelivery:async(record,descriptor,prepared,signal)=>{
      signal.throwIfAborted(); checks++; assert.equal(descriptor.id,original.id); assert.equal(record.id,candidate.record.id);
      assert.equal(prepared.cid,golden.package.cid); if(fail)throw new Error('corrupt retained bytes');
    }};
    const coordinator=new ShortsDeliveryRetirementService(shorts,media,selections,retirements);
    if(saved===undefined)delete process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED;else process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED=saved;
    t.after(()=>coordinator.onModuleDestroy());
    fail=true; await assert.rejects(coordinator.retireInputs(original.id,candidate.sourceKey,randomUUID()),/corrupt retained bytes/);
    assert.equal(await count(),1); fail=false;
    const op=randomUUID(), result=await coordinator.retireInputs(original.id,candidate.sourceKey,op); assert.equal(result.generationJobId,candidate.record.id);
    assert.equal(await count(),2); const before=checks;
    assert.deepEqual(await coordinator.retireInputs(original.id,candidate.sourceKey,op),result); assert.equal(checks,before);
    const flag=process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED;process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED='false';
    const disabled=new ShortsDeliveryRetirementService(shorts,media,selections,retirements);
    if(flag===undefined)delete process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED;else process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED=flag;
    assert.deepEqual(await disabled.retireInputs(original.id,candidate.sourceKey,op),result);assert.equal(checks,before);await disabled.onModuleDestroy();
    withdrawn=true; await assert.rejects(coordinator.retireInputs(original.id,candidate.sourceKey,op),/withdrawn/);
    const signal=AbortSignal.abort(); await assert.rejects(coordinator.retireInputs(original.id,candidate.sourceKey,op,signal),{name:'AbortError'});
  });
  await t.test('workers cannot read/write retirement authority and history cannot be removed or rolled back',async()=>{
    await assert.rejects(workerDb.query('SELECT * FROM shorts_delivery_input_retirements'),{code:'42501'});
    await assert.rejects(workerDb.query(`INSERT INTO shorts_delivery_input_retirements
      (network,contract,short_id,source_key,operation_id,input_cid,generation_job_id) VALUES($1,$2,$3,$4,$5,$6,$3)`,
      [...args,golden.sourceKey,randomUUID(),original.derivatives.cid]),{code:'42501'});
    for(const sql of ["UPDATE shorts_delivery_input_retirements SET retired_at=clock_timestamp()",'DELETE FROM shorts_delivery_input_retirements','TRUNCATE shorts_delivery_input_retirements'])
      await assert.rejects(owner.query(sql),{code:'SH409'});
    await assert.rejects(owner.transaction(db=>new Migration().down(db)),/Preserve input retirement history/);
    assert.deepEqual(await retirements.get(scope,original.id,golden.sourceKey),receipt);
  });
  const reservations=new ShortsInputReclamationReservationsService(owner),cid=original.derivatives.cid;
  let reservation;
  await t.test('reclamation requires every shared reference and rejects permanent or legacy references globally',async()=>{
    assert.equal((await owner.query('SELECT shorts_cid_pin_identity($1) AS cid',[legacyInputCid]))[0].cid,cid);
    await assert.rejects(reservations.reserve(cid,randomUUID()),{code:'SH409'}); // unselected third generation shares this CID
    for(const permanent of [original.cid,original.derivatives.assetsCid,golden.package.cid])
      await assert.rejects(reservations.reserve(permanent,randomUUID()),{code:'SH409'});
    await selections.commit(scope,original.id,{sourceKey:candidate.sourceKey,revision:'1'},unused.sourceKey,randomUUID(),'activate');
    await age('shorts_delivery_selections','shorts_delivery_selection_guard','selected_at');
    await retirements.commit(scope,original.id,unused.sourceKey,randomUUID());
    const other={network:'ae_mainnet',contract:'ct_other'};await metadata.initialize(other,sourceHash,30,30);
    const legacy={id:'legacy-holder',creator:'ak_other',cid:legacyInputCid,bytes:1,files:[],moderation:'approved'};
    await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
      [other.network,other.contract,legacy.id,legacy.creator,JSON.stringify(legacy)]);
    await assert.rejects(reservations.reserve(cid,randomUUID()),{code:'SH409'});
    await owner.query('DELETE FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',[other.network,other.contract,legacy.id]);
    const op=randomUUID();const [a,b]=await Promise.all([reservations.reserve(cid,op),reservations.reserve(cid,op)]);
    assert.deepEqual(a,b);reservation=a;assert.equal(a.state,'reserved');assert.equal(a.roots.length,3);
    assert.deepEqual(a.roots.map(x=>x.jobId).sort(),[original.id,candidate.record.id,unused.record.id].sort());
    await assert.rejects(reservations.reserve(cid,randomUUID()),{status:409});
    await assert.rejects(reservations.reserve(original.cid,op),{status:409});
    assert.deepEqual(await reservations.verify(op),reservation);
  });
  await t.test('active reservations survive service restart and block new references and switches without blocking engagement',async()=>{
    const fresh=new ShortsInputReclamationReservationsService(owner);assert.deepEqual(await fresh.get(reservation.operationId),reservation);
    const other={network:'ae_mainnet',contract:'ct_other'},legacy={id:'blocked-reference',creator:'ak_other',cid:legacyInputCid,bytes:1,files:[]};
    await assert.rejects(owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
      [other.network,other.contract,legacy.id,legacy.creator,JSON.stringify(legacy)]),{code:'SH409'});
    await assert.rejects(selections.commit(scope,original.id,{sourceKey:unused.sourceKey,revision:'2'},candidate.sourceKey,randomUUID(),'rollback'),{code:'SH409'});
    await assert.rejects(packages.acknowledge(golden.descriptor,golden.package),{code:'SH409'});
    await patch({...original,likes:43,views:['another-view']});assert.equal((await fresh.verify(reservation.operationId)).state,'reserved');
    await patch(original);
  });
  await t.test('holds and policy changes invalidate persistently while keeping the reference barrier closed',async()=>{
    const id=await hold(candidate.record.id);
    assert.equal((await reservations.get(reservation.operationId)).state,'invalidated');
    await assert.rejects(reservations.verify(reservation.operationId),{status:409});
    await assert.rejects(reservations.reserve(cid,randomUUID()),{status:409});
    const closed=await reservations.cancel(reservation.operationId);assert.equal(closed.state,'released');assert.ok(closed.invalidatedAt);
    assert.deepEqual(await reservations.cancel(reservation.operationId),closed);
    assert.deepEqual(await reservations.reserve(cid,reservation.operationId),closed,'an old operation cannot reopen a barrier');
    await assert.rejects(reservations.reserve(cid,randomUUID()),{code:'SH409'});await release(id);
    for(const change of [{reports:1},{appeal:{status:'pending'}},{publication:'withdrawn'},{title:'Changed metadata'}]){
      const next=await reservations.reserve(cid,randomUUID());await patch({...original,...change});
      assert.equal((await reservations.get(next.operationId)).state,'invalidated');await assert.rejects(reservations.verify(next.operationId),{status:409});
      await reservations.cancel(next.operationId);await assert.rejects(reservations.reserve(cid,randomUUID()),{code:'SH409'});await patch(original);
    }
  });
  await t.test('CID lock serializes new references and reservations in either order',async()=>{
    const runner=owner.createQueryRunner();await runner.connect();const other={network:'ae_mainnet',contract:'ct_other'};
    const add=(db,id)=>db.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
      [other.network,other.contract,id,'ak_other',JSON.stringify({id,creator:'ak_other',cid,bytes:1,files:[]})]);
    try{
      await runner.startTransaction();await add(runner,'uncommitted-reference');
      const blocked=reservations.reserve(cid,randomUUID());let ended=false;blocked.finally(()=>{ended=true;}).catch(()=>{});
      await new Promise(r=>setTimeout(r,40));assert.equal(ended,false);await runner.commitTransaction();
      await assert.rejects(blocked,{code:'SH409'});
      await owner.query('DELETE FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',[other.network,other.contract,'uncommitted-reference']);
      await runner.startTransaction();const operation=randomUUID();
      await runner.query(`INSERT INTO shorts_input_reclamation_reservations(operation_id,input_cid,roots) VALUES($1,$2,'[]')`,[operation,cid]);
      const write=add(owner,'late-reference');ended=false;write.finally(()=>{ended=true;}).catch(()=>{});
      await new Promise(r=>setTimeout(r,40));assert.equal(ended,false);await runner.commitTransaction();await assert.rejects(write,{code:'SH409'});
      await reservations.cancel(operation);
    }finally{if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();}
  });
  await t.test('a racing hold either prevents reservation or invalidates it after admission',async()=>{
    const runner=owner.createQueryRunner();await runner.connect();
    try{
      await runner.startTransaction();const id=randomUUID();
      await runner.query(`INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
        VALUES($1,$2,$3,$4,'recovery','racing-hold')`,[...args.slice(0,2),id,original.id]);
      const reserve=reservations.reserve(cid,randomUUID());let ended=false;reserve.finally(()=>{ended=true;}).catch(()=>{});
      await new Promise(r=>setTimeout(r,40));assert.equal(ended,false);await runner.commitTransaction();
      await assert.rejects(reserve,{code:'SH409'});await release(id);
      await runner.startTransaction();const operation=randomUUID();
      await runner.query(`INSERT INTO shorts_input_reclamation_reservations(operation_id,input_cid,roots) VALUES($1,$2,'[]')`,[operation,cid]);
      const holdPromise=hold(original.id);ended=false;holdPromise.finally(()=>{ended=true;}).catch(()=>{});
      await new Promise(r=>setTimeout(r,40));assert.equal(ended,false);await runner.commitTransaction();
      const held=await holdPromise;assert.equal((await reservations.get(operation)).state,'invalidated');
      await reservations.cancel(operation);await release(held);
      await assert.rejects(owner.transaction('REPEATABLE READ',db=>db.query('SELECT shorts_input_reclamation_roots($1)',[cid])),{code:'SH400'});
    }finally{if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();}
  });
  const storage={peerId:'a'.repeat(52),epoch:'e'.repeat(64)};
  const permits=new ShortsInputReclamationPermitsService(owner);
  const agePermits=(db,operation)=>db.transaction(async sql=>{
    await sql.query('ALTER TABLE shorts_input_reclamation_permits DISABLE TRIGGER shorts_input_reclamation_permit_guard');
    await sql.query("UPDATE shorts_input_reclamation_permits SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',quiet_until=quiet_until-interval '1 hour' WHERE operation_id=$1",[operation]);
    await sql.query('ALTER TABLE shorts_input_reclamation_permits ENABLE TRIGGER shorts_input_reclamation_permit_guard');
  });
  await t.test('durable unpin permits cannot renew or release their barrier before a known outcome and full quiet period',async()=>{
    for(const state of ['removed','not-pinned','rejected']){
      const reservation=await reservations.reserve(cid,randomUUID()),operation=randomUUID();
      const [a,b]=await Promise.all([permits.issue(reservation.operationId,operation),permits.issue(reservation.operationId,operation)]);
      assert.deepEqual(a,b);assert.equal(a.inputCid,cid);assert.equal(a.expires-Date.parse(a.issuedAt),20000);
      assert.equal(Date.parse(a.quietUntil)-a.expires,30000);
      await assert.rejects(permits.issue(reservation.operationId),{status:409});
      await assert.rejects(reservations.cancel(reservation.operationId),/still holds/);
      const bound=await permits.bind(operation,storage);
      assert.equal(bound.storage.epoch,storage.epoch);assert.ok(Date.parse(bound.storage.boundAt)>=Date.parse(a.issuedAt));
      assert.deepEqual(await new ShortsInputReclamationPermitsService(owner).bind(operation,storage),bound);
      await assert.rejects(permits.bind(operation,{...storage,epoch:'f'.repeat(64)}),{status:409});
      await assert.rejects(owner.query('UPDATE shorts_input_reclamation_permits SET node_epoch=$2 WHERE operation_id=$1',[operation,'f'.repeat(64)]),{code:'SH409'});
      const finished=await permits.finish(operation,state);assert.equal(finished.state,state);
      assert.deepEqual(await permits.finish(operation,state),finished);
      await assert.rejects(reservations.cancel(reservation.operationId),/still holds/);
      await agePermits(owner,operation);await reservations.cancel(reservation.operationId);
      const historical=await permits.get(operation);assert.deepEqual(await permits.issue(reservation.operationId,operation),historical);
    }
    for(const sql of ['DELETE FROM shorts_input_reclamation_permits','TRUNCATE shorts_input_reclamation_permits',
      "UPDATE shorts_input_reclamation_permits SET expires_at=clock_timestamp()"])
      await assert.rejects(owner.query(sql),{code:'SH409'});
    for(const sql of ['SELECT * FROM shorts_input_reclamation_permits',"UPDATE shorts_input_reclamation_permits SET state='removed'"])
      await assert.rejects(workerDb.query(sql),{code:'42501'});
    await assert.rejects(owner.transaction(db=>new PermitsMigration().down(db)),/Preserve reclamation permit history/);
  });
  await t.test('expired and uncertain unpin permits retain their barrier indefinitely',async()=>{
    await assert.rejects(owner.transaction(async db=>{
      const barrier=new ShortsInputReclamationReservationsService(db),ledger=new ShortsInputReclamationPermitsService(db);
      const reservation=await barrier.reserve(cid,randomUUID()),permit=await ledger.issue(reservation.operationId);
      await agePermits(db,permit.operationId);
      await assert.rejects(ledger.bind(permit.operationId,storage),{code:'SH409'});
      await assert.rejects(barrier.cancel(reservation.operationId),/still holds/);
      await ledger.finish(permit.operationId,'uncertain');
      const restarted=new ShortsInputReclamationPermitsService(db);
      assert.equal((await restarted.get(permit.operationId)).state,'uncertain');
      await assert.rejects(restarted.finish(permit.operationId,'removed'),{status:409});
      await assert.rejects(barrier.cancel(reservation.operationId),/still holds/);
      // Keep the rest of this fixture independent; no committed history is erased.
      throw new Error('rollback isolated uncertain permit');
    }),/rollback isolated uncertain permit/);
  });
  await t.test('policy invalidation rejects new permits and cannot cancel an already issued request',async()=>{
    const before=await reservations.reserve(cid,randomUUID());
    await assert.rejects(owner.transaction('REPEATABLE READ',db=>hold(original.id,db)),{code:'SH400'});
    const held=await hold(original.id);
    await assert.rejects(permits.issue(before.operationId),{code:'SH409'});
    await reservations.cancel(before.operationId);await release(held);
    const after=await reservations.reserve(cid,randomUUID()),permit=await permits.issue(after.operationId),nextHold=await hold(original.id);
    assert.equal((await reservations.get(after.operationId)).state,'invalidated');
    await assert.rejects(reservations.cancel(after.operationId),/still holds/);
    await assert.rejects(permits.bind(permit.operationId,storage),{code:'SH409'});
    await permits.finish(permit.operationId,'rejected');await agePermits(owner,permit.operationId);
    await reservations.cancel(after.operationId);await release(nextHold);
  });
  await t.test('permit issuance and barrier release serialize in either transaction order',async()=>{
    const runner=owner.createQueryRunner();await runner.connect();
    try{
      const first=await reservations.reserve(cid,randomUUID());await runner.startTransaction();
      await runner.query("SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",[cid]);
      const operation=randomUUID(),pending=permits.issue(first.operationId,operation);let ended=false;
      pending.finally(()=>{ended=true;}).catch(()=>{});await new Promise(r=>setTimeout(r,40));assert.equal(ended,false);
      await runner.query("UPDATE shorts_input_reclamation_reservations SET state='released' WHERE operation_id=$1",[first.operationId]);
      await runner.commitTransaction();await assert.rejects(pending,{code:'SH409'});assert.equal(await permits.get(operation),undefined);
      const second=await reservations.reserve(cid,randomUUID()),other=randomUUID();await runner.startTransaction();
      await runner.query('INSERT INTO shorts_input_reclamation_permits(operation_id,reservation_id,input_cid) VALUES($1,$2,$3)',[other,second.operationId,cid]);
      const cancelled=reservations.cancel(second.operationId);ended=false;cancelled.finally(()=>{ended=true;}).catch(()=>{});
      await new Promise(r=>setTimeout(r,40));assert.equal(ended,false);await runner.commitTransaction();
      await assert.rejects(cancelled,/still holds/);await permits.finish(other,'rejected');await agePermits(owner,other);await reservations.cancel(second.operationId);
    }finally{if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();}
  });
  const transfers=new ShortsPinTransfersService(owner), binding={cid,jobId:original.id,purpose:'inputs'};
  const ageTransfers=()=>owner.transaction(async db=>{
    await db.query('ALTER TABLE shorts_pin_transfers DISABLE TRIGGER shorts_pin_transfer_guard');
    await db.query("UPDATE shorts_pin_transfers SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',quiet_until=quiet_until-interval '1 hour'");
    await db.query('ALTER TABLE shorts_pin_transfers ENABLE TRIGGER shorts_pin_transfer_guard');
  });
  await t.test('pin intents survive restart and hold reclamation through the entire replay window',async()=>{
    const operation=randomUUID();
    const [a,b]=await Promise.all([transfers.begin(scope,binding,operation),transfers.begin(scope,binding,operation)]);
    assert.deepEqual(a,b); assert.equal(a.state,'issued');
    assert.equal(a.expires-Date.parse(a.issuedAt),180000);
    assert.equal(Date.parse(a.quietUntil)-a.expires,30000);
    assert.deepEqual(await new ShortsPinTransfersService(owner).get(operation),a);
    await assert.rejects(transfers.begin(scope,{...binding,cid:original.cid},operation),{status:409});
    await assert.rejects(reservations.reserve(cid,randomUUID()),/outstanding pin transfers/);
    const finished=await transfers.finish(operation,'pinned');
    assert.deepEqual(await transfers.finish(operation,'pinned'),finished);
    await assert.rejects(transfers.finish(operation,'rejected'),{status:409});
    await assert.rejects(reservations.reserve(cid,randomUUID()),/outstanding pin transfers/);
    await ageTransfers();
    const reserved=await reservations.reserve(cid,randomUUID());
    assert.equal((await transfers.begin(scope,binding,operation)).state,'pinned','receipt retry does not reissue authority');
    await assert.rejects(transfers.begin(scope,binding),{code:'SH409'});
    await reservations.cancel(reserved.operationId);
  });
  await t.test('storage epochs bind once, survive restart, and cannot be renewed or reassigned by a racing caller',async()=>{
    const pin=await transfers.begin(scope,binding);
    const results=await Promise.allSettled([transfers.bind(pin.operationId,storage),transfers.bind(pin.operationId,{...storage,epoch:'f'.repeat(64)})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
    const bound=results.find(r=>r.status==='fulfilled').value;
    assert.deepEqual(await new ShortsPinTransfersService(owner).get(pin.operationId),bound);
    assert.ok(Date.parse(bound.storage.boundAt)>=Date.parse(pin.issuedAt));assert.ok(Date.parse(bound.storage.boundAt)<pin.expires);
    for(const assignment of ["node_epoch='"+'0'.repeat(64)+"'","node_peer_id='"+'b'.repeat(52)+"'",
      'node_epoch=NULL,node_peer_id=NULL,storage_bound_at=NULL','storage_bound_at=clock_timestamp()'])
      await assert.rejects(owner.query('UPDATE shorts_pin_transfers SET '+assignment+' WHERE operation_id=$1',[pin.operationId]),{code:'SH409'});
    await assert.rejects(owner.transaction('REPEATABLE READ',db=>db.query('UPDATE shorts_pin_transfers SET node_epoch=node_epoch WHERE operation_id=$1',[pin.operationId])),{code:'SH409'});
    await assert.rejects(owner.query(`INSERT INTO shorts_pin_transfers(operation_id,cid,network,contract,job_id,purpose,node_peer_id,node_epoch)
      VALUES($1,$2,$3,$4,$5,'inputs',$6,$7)`,[randomUUID(),cid,scope.network,scope.contract,original.id,storage.peerId,storage.epoch]),{code:'SH409'});
    await assert.rejects(owner.transaction(db=>new EpochsMigration().down(db)),/Preserve storage epoch history/);
    const finished=await transfers.finish(pin.operationId,'pinned');assert.deepEqual(finished.storage,bound.storage);
    await ageTransfers();
  });
  await t.test('pin intent and reclamation serialize in both admission orders',async()=>{
    const runner=owner.createQueryRunner();await runner.connect();
    try{
      await runner.startTransaction();const operation=randomUUID();
      await runner.query("INSERT INTO shorts_pin_transfers(operation_id,cid,network,contract,job_id,purpose) VALUES($1,$2,$3,$4,$5,'inputs')",
        [operation,cid,scope.network,scope.contract,original.id]);
      const pending=reservations.reserve(cid,randomUUID());let done=false;pending.finally(()=>{done=true;}).catch(()=>{});
      await new Promise(r=>setTimeout(r,40));assert.equal(done,false);await runner.commitTransaction();
      await assert.rejects(pending,/outstanding pin transfers/);await transfers.finish(operation,'rejected');await ageTransfers();
      await runner.startTransaction();const cleanup=randomUUID();
      await runner.query("INSERT INTO shorts_input_reclamation_reservations(operation_id,input_cid,roots) VALUES($1,$2,'[]')",[cleanup,cid]);
      const pin=transfers.begin(scope,binding);done=false;pin.finally(()=>{done=true;}).catch(()=>{});
      await new Promise(r=>setTimeout(r,40));assert.equal(done,false);await runner.commitTransaction();
      await assert.rejects(pin,{code:'SH409'});await reservations.cancel(cleanup);
      await assert.rejects(owner.transaction('REPEATABLE READ',db=>db.query(
        "INSERT INTO shorts_pin_transfers(operation_id,cid,network,contract,job_id,purpose) VALUES($1,$2,$3,$4,$5,'inputs')",
        [randomUUID(),cid,scope.network,scope.contract,original.id])),{code:'SH409'});
    }finally{if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();}
  });
  await t.test('new preparation invalidates the barrier and cannot install generation references until released',async()=>{
    const reservation=await reservations.reserve(cid,randomUUID());
    const id='after-reservation',key=`shorts-private-v1/${scopeHash}/${id}/source-manifest/key1/${sourceHash}`;
    const input={processingProfile:'original-h264-v1',objectKey:key,manifest:{key,keyId:'key1',bytes:100,sha256:sourceHash},
      sha256:original.original.sha256,bytes:original.bytes,title:original.title,topic:original.topic,details:{}};
    await generations.enqueue(scope,id,original.id,input);
    assert.equal((await reservations.get(reservation.operationId)).state,'invalidated');
    await assert.rejects(owner.query(`INSERT INTO shorts_delivery_generations(network,contract,short_id,job_id,fence,body)
      VALUES($1,$2,$3,$4,1,$5)`,[...args,id,JSON.stringify({...candidate.record,id})]),{code:'SH409'});
    await reservations.cancel(reservation.operationId);
    await assert.rejects(reservations.reserve(cid,randomUUID()),{code:'SH409'});
  });
  await t.test('barrier history and worker authority remain protected and released CIDs can be reused',async()=>{
    await assert.rejects(workerDb.query('SELECT * FROM shorts_input_reclamation_reservations'),{code:'42501'});
    await assert.rejects(workerDb.query('SELECT shorts_input_reclamation_roots($1)',[cid]),{code:'42501'});
    for(const sql of ["UPDATE shorts_input_reclamation_reservations SET input_cid='bafyother'",'DELETE FROM shorts_input_reclamation_reservations',
      'TRUNCATE shorts_input_reclamation_reservations','TRUNCATE shorts_input_reclamation_reservations CASCADE'])
      await assert.rejects(owner.query(sql),error=>error.code==='SH409'||(sql==='TRUNCATE shorts_input_reclamation_reservations'&&error.code==='0A000'));
    await assert.rejects(owner.transaction(db=>new ReservationsMigration().down(db)),/Preserve input reclamation history/);
    const other={network:'ae_mainnet',contract:'ct_other'},id='reused-cid';
    await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
      [other.network,other.contract,id,'ak_other',JSON.stringify({id,creator:'ak_other',cid,bytes:1,files:[]})]);
    await assert.rejects(reservations.reserve(cid,randomUUID()),{code:'SH409'});
  });
  await t.test('expired and uncertain transfers never become cleanup authority and cannot be rewritten by workers',async()=>{
    const pin=await transfers.begin(scope,binding);await ageTransfers();
    await assert.rejects(transfers.bind(pin.operationId,storage),{code:'SH409'});
    await assert.rejects(transfers.finish(pin.operationId,'pinned'),{code:'SH409'});
    await assert.rejects(reservations.reserve(cid,randomUUID()),/outstanding pin transfers/);
    await transfers.finish(pin.operationId,'uncertain');await ageTransfers();
    await assert.rejects(reservations.reserve(cid,randomUUID()),/outstanding pin transfers/);
    await assert.rejects(transfers.finish(pin.operationId,'pinned'),{status:409});
    for(const sql of ['SELECT * FROM shorts_pin_transfers',"UPDATE shorts_pin_transfers SET state='rejected'"])
      await assert.rejects(workerDb.query(sql),{code:'42501'});
    for(const sql of ['DELETE FROM shorts_pin_transfers','TRUNCATE shorts_pin_transfers',
      "UPDATE shorts_pin_transfers SET quiet_until=clock_timestamp()", "UPDATE shorts_pin_transfers SET cid='bafyother'"])
      await assert.rejects(owner.query(sql),{code:'SH409'});
    await assert.rejects(owner.transaction(db=>new TransfersMigration().down(db)),/Preserve pin transfer history/);
  });
});

test('retirement coordinator defaults off and bounds shutdown/concurrency',async t=>{
  const before=process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED; delete process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED;
  t.after(()=>{if(before===undefined)delete process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED;else process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED=before;});
  const scope={network:'ae_uat',contract:'ct_protocol'}, shorts={chain:{release:scope,state:{contract:scope.contract}},ensurePlayable:async()=>({})};
  const ledger={operation:async()=>undefined};
  const disabled=new ShortsDeliveryRetirementService(shorts,{}, {},ledger);
  await assert.rejects(disabled.retireInputs('post',golden.sourceKey,randomUUID()),{status:503}); await disabled.onModuleDestroy();
  process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED='invalid'; assert.throws(()=>new ShortsDeliveryRetirementService(shorts,{}, {},ledger),/Invalid input retirement flag/);
  process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED='true';
  let started=0, enter;const entered=new Promise(resolve=>{enter=resolve;});
  const media={verifyDurableDelivery:async(_r,_d,_p,signal)=>{started++;if(started===2)enter();await new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});signal.throwIfAborted();
  });}};
  const enabled=new ShortsDeliveryRetirementService(shorts,media,{acknowledged:async()=>({})},ledger);
  const tasks=[1,2].map(()=>assert.rejects(enabled.retireInputs('post',golden.sourceKey,randomUUID()),{name:'AbortError'}));
  await entered; await assert.rejects(enabled.retireInputs('post',golden.sourceKey,randomUUID()),{status:503});
  await enabled.onModuleDestroy(); await Promise.all(tasks);
});
