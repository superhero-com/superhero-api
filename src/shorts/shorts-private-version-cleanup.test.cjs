const { ShortsPrivateVersionCleanup: Migration } = require('./testing/historical-migrations.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { fixture, scope, candidate, current } = require('./testing/private-version-http.cjs');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { ShortsSourceReaderService } = require('./shorts-source-reader.service');
const { ShortsStorageReconciliationService } = require('./shorts-storage-reconciliation.service');
const { ShortsPrivateVersionCleanupService } = require('./shorts-private-version-cleanup.service');
const { ShortsPrivateVersionStorageService } = require('./shorts-private-version-storage.service');
const { migratePrivateVersionTables } = require('./testing/private-version-database.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

test('private version cleanup coordinates actual PostgreSQL authority and S3 HTTP requests', { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000 }, async t => {
  const f = await fixture(t), url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_version_' + randomUUID().replaceAll('-', ''), role = 'shversion_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  let owner, db, roleCreated = false, coordinator, storage;
  t.after(async () => { await coordinator?.onModuleDestroy(); storage?.onModuleDestroy();
    if (db?.isInitialized) await db.destroy(); if (owner?.isInitialized) await owner.destroy();
    if (roleCreated) await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.destroy(); });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 3 } };
  owner = new DataSource(options); await owner.initialize();
  await owner.transaction(migratePrivateVersionTables);
  await owner.transaction(runner => new Migration().down(runner)); await owner.transaction(runner => new Migration().up(runner));
  const args = [scope.network, scope.contract], config = { scope, prefix: f.config.prefix, sourceHash: hash('source'), storageId: hash('storage'),
    objectPrefix: f.ref.key.split('/').slice(0,2).join('/')+'/', storage: f.config, objects: f.config };
  await owner.query('INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)', [...args,config.sourceHash]);
  const record = { id:'job', creator:'ak_creator', createdAt:1, bytes:f.ref.bytes, publication:'published', privateMedia:{ files:{video:f.ref} } };
  await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)', [...args,record.id,record.creator,record]);
  const inventoryId = randomUUID(), identity = hash('old-version');
  await owner.query(`INSERT INTO shorts_storage_inventory_runs(network,contract,id,source_hash,storage_id,object_prefix,complete) VALUES($1,$2,$3,$4,$5,$6,true)`, [...args,inventoryId,config.sourceHash,config.storageId,config.objectPrefix]);
  await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
    VALUES($1,$2,$3,$4,$5,$6,false,false,$7,clock_timestamp())`, [...args,inventoryId,identity,f.ref.key,candidate,f.ref.bytes+36]);
  const retention = new ShortsRetentionService(owner, config), inspector = new ShortsStorageReconciliationService(owner,config,retention,new ShortsSourceReaderService(f.service),f.service);
  const scan = async () => { const id=randomUUID(); await inspector.start(id,inventoryId); while(!(await inspector.step(id)).referenceTraversalComplete) {} return id; };
  const readTables=['shorts_runtime','shorts_content','shorts_ingestion','shorts_upload_sessions','shorts_upload_parts','shorts_delivery_packages','shorts_delivery_generations','shorts_delivery_staging','shorts_retention_holds',
    'shorts_storage_inventory_runs','shorts_storage_inventory_objects','shorts_storage_reconciliations','shorts_storage_reference_roots','shorts_storage_references','shorts_private_storage_epochs'];
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ${readTables.map(name=>schema+'.'+name).join(',')} TO ${role};
    GRANT SELECT,INSERT ON ${schema}.shorts_private_version_cleanup,${schema}.shorts_private_version_events TO ${role}`);
  const login=new URL(url);login.username=role;login.password=password;db=new DataSource({...options,url:login.href});await db.initialize();
  const scopedRetention=new ShortsRetentionService(db,config), scopedInspection=new ShortsStorageReconciliationService(db,config,scopedRetention,new ShortsSourceReaderService(f.service),f.service);
  storage=new ShortsPrivateVersionStorageService(config);
  const create = (enabled=true) => { const old=process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED;process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED=String(enabled);
    try{return new ShortsPrivateVersionCleanupService(db,config,f.service,storage,scopedInspection,scopedRetention);}finally{if(old===undefined)delete process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED;else process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED=old;} };
  coordinator=create();await coordinator.verify();
  await t.test('read-only inventory and append-only cleanup role reject broader authority',async()=>{
    await assert.rejects(db.query('DELETE FROM shorts_private_version_events'),{code:'42501'});
    await assert.rejects(db.query('UPDATE shorts_private_storage_epochs SET revision=0'),{code:'42501'});
    await owner.query(`GRANT UPDATE ON shorts_storage_reconciliations TO ${role}`);await assert.rejects(coordinator.verify());await owner.query(`REVOKE UPDATE ON shorts_storage_reconciliations FROM ${role}`);
    await coordinator.verify();const disabled=create(false);await assert.rejects(disabled.reclaim(randomUUID(),await scan(),identity),/disabled/);await disabled.onModuleDestroy();
  });
  await t.test('holds, changed references and active work cannot dispatch deletion',async()=>{
    let id=await scan();const hold=randomUUID();await retention.hold({id:hold,resourceId:'job',reason:'appeal',reference:'case1'});
    await assert.rejects(coordinator.reclaim(randomUUID(),id,identity),{code:'SH409'});
    await assert.rejects(coordinator.reclaim(randomUUID(),await scan(),identity),{code:'SH409'});
    await retention.release(hold);id=await scan();
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{reports}','1')");
    await assert.rejects(coordinator.reclaim(randomUUID(),id,identity),{code:'SH409'});
    await assert.rejects(coordinator.reclaim(randomUUID(),await scan(),identity),{code:'SH409'});
    await owner.query('UPDATE shorts_content SET body=$1',[record]);
    assert.equal(f.state.deletes,undefined);
  });
  const extraCandidate = async label => {
    const version='old-'+label, objectIdentity=hash(label);
    f.state.versions.set(version,Buffer.from(f.state.versions.get(current)));
    await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
      VALUES($1,$2,$3,$4,$5,$6,false,false,$7,clock_timestamp())`, [...args,inventoryId,objectIdentity,f.ref.key,version,f.ref.bytes+36]);
    return {version,identity:objectIdentity};
  };
  await t.test('view counters do not invalidate references but an upload writer does',async()=>{
    const revision=async()=>String((await owner.query('SELECT revision FROM shorts_private_storage_epochs WHERE network=$1 AND contract=$2',args))[0].revision);
    const before=await revision();await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{views}','1')");assert.equal(await revision(),before);
    await owner.query('UPDATE shorts_content SET body=$1',[record]);assert.equal(await revision(),before);
    await owner.query(`INSERT INTO shorts_upload_sessions(network,contract,id,creator,input) VALUES($1,$2,'upload-writer','ak_creator',$3)`,[...args,{bytes:16,sha256:'a'.repeat(64)}]);
    assert.notEqual(await revision(),before);await owner.query("DELETE FROM shorts_upload_sessions WHERE id='upload-writer'");
    await assert.rejects(owner.query('TRUNCATE shorts_content CASCADE'),{code:'SH400'});
  });
  await t.test('same-key reservations serialize and a hold during verification prevents issue',async()=>{
    const one=await extraCandidate('race1'),two=await extraCandidate('race2'),scanId=await scan(),id=randomUUID();
    const verify=f.service.verifyVersionCopies.bind(f.service);let entered,release;
    const arrived=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    f.service.verifyVersionCopies=async(...args)=>{const result=await verify(...args);entered();await gate;return result;};
    const work=coordinator.reclaim(id,scanId,one.identity);const failure=assert.rejects(work,{code:'SH409'});await arrived;
    const contender=create();await assert.rejects(contender.reclaim(randomUUID(),scanId,two.identity),{code:'SH409'});await contender.onModuleDestroy();
    const hold=randomUUID();await retention.hold({id:hold,resourceId:'job',reason:'legal',reference:'race'});release();await failure;
    f.service.verifyVersionCopies=verify;
    assert.equal((await coordinator.status(id)).events.length,0);assert.equal((await coordinator.cancel(id)).operation.state,'cancelled');
    assert.equal((await coordinator.cancel(id)).operation.state,'cancelled');await retention.release(hold);
    assert.equal(f.state.deletes,undefined);
  });
  await t.test('a policy change after issue blocks sending, and a fresh scan can retry with immutable history',async()=>{
    const item=await extraCandidate('retry'),id=randomUUID(),scanId=await scan(),hold=randomUUID();
    const ready=storage.ready.bind(storage);let calls=0;
    storage.ready=async(...args)=>{await ready(...args);if(++calls===2)await retention.hold({id:hold,resourceId:'job',reason:'recovery',reference:'before-send'});};
    await assert.rejects(coordinator.reclaim(id,scanId,item.identity),/policy changed/);storage.ready=ready;
    assert.equal(f.state.deletes,undefined);assert.deepEqual((await coordinator.status(id)).events.map(e=>e.kind),['issued','uncertain']);
    await assert.rejects(coordinator.cancel(id),{code:'SH409'});assert.equal((await coordinator.recover(id)).operation.state,'pending');
    await retention.release(hold);const fresh=await scan();
    await assert.rejects(coordinator.reclaim(id,fresh,item.identity),{code:'SH409'});
    // Real clock passage exercises the cross-process dispatch quiet interval.
    await new Promise(resolve=>setTimeout(resolve,30500));
    const result=await coordinator.reclaim(id,fresh,item.identity);assert.equal(result.operation.state,'removed');
    assert.deepEqual(result.events.map(e=>e.kind),['issued','uncertain','issued','removed']);
    assert.equal(f.state.versions.has(item.version),false);assert.equal(f.state.versions.has(current),true);assert.equal(f.state.deletes,1);
    f.state.deletes=0;
  });
  await t.test('an interrupted deletion retains intent and a fresh process recovers its exact version',async()=>{
    const id=randomUUID(), scanId=await scan();f.state.loseDelete=true;
    await assert.rejects(coordinator.reclaim(id,scanId,identity));
    const pending=await coordinator.status(id);assert.equal(pending.operation.state,'pending');assert.deepEqual(pending.events.map(e=>e.kind),['issued','uncertain']);
    assert.equal(f.state.deletes,1);assert.equal(f.state.versions.has(candidate),false);assert.equal(f.state.versions.has(current),true);
    await coordinator.onModuleDestroy();coordinator=create();await coordinator.verify();
    const restored=await coordinator.recover(id);assert.equal(restored.operation.state,'removed');assert.deepEqual(restored.events.map(e=>e.kind),['issued','uncertain','removed']);
    assert.equal(f.state.deletes,1);assert.equal((await coordinator.reclaim(id,scanId,identity)).operation.state,'removed');assert.equal(f.state.deletes,1);
    await assert.rejects(owner.query("UPDATE shorts_private_version_events SET kind='cancelled'"),{code:'SH409'});
    await assert.rejects(owner.query('TRUNCATE shorts_private_version_events'),{code:'SH409'});
    await assert.rejects(owner.transaction(runner=>new Migration().down(runner)),/Preserve private cleanup history/);
    f.state.loseDelete=false;
  });
});

test('storage mutation rejects unsafe configuration, stale grants and retained-current changes', async t => {
  const f=await fixture(t),config={storage:f.config,objectPrefix:f.ref.key.split('/').slice(0,2).join('/')+'/'};
  const storage=new ShortsPrivateVersionStorageService(config);t.after(()=>storage.onModuleDestroy());const signal=new AbortController().signal;
  f.state.hideAbsence=true;await assert.rejects(storage.preflight(f.ref.key,current,f.ref.bytes,signal));f.state.hideAbsence=false;
  f.state.versioning='Suspended';await assert.rejects(storage.ready(signal),/versioning/);f.state.versioning='Enabled';
  f.state.lifecycleEnabled=true;await assert.rejects(storage.ready(signal),/lifecycle/);f.state.lifecycleEnabled=false;
  for(const age of [6000,-6000,NaN])await assert.rejects(storage.remove(f.ref.key,candidate,current,f.ref.bytes,new Date(Date.now()-age),signal,async()=>{}),/clock/);
  await assert.rejects(storage.remove(f.ref.key,current,current,f.ref.bytes,new Date(),signal,async()=>{}),/retained/);
  f.state.current='changed';await assert.rejects(storage.remove(f.ref.key,candidate,current,f.ref.bytes,new Date(),signal,async()=>{}),/current/);f.state.current=current;
  assert.equal(f.state.deletes,undefined);
  f.state.denyDelete=true;await assert.rejects(storage.remove(f.ref.key,candidate,current,f.ref.bytes,new Date(),signal,async()=>{}),/uncertain/);
  assert.equal(f.state.deletes,1);assert.equal(f.state.versions.has(candidate),true);assert.equal(f.state.versions.has(current),true);
});
