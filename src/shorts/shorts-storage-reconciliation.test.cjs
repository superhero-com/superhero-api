const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {DataSource}=require('typeorm');
const {S3Client,CreateBucketCommand,PutBucketVersioningCommand,PutObjectCommand,DeleteObjectCommand,ListObjectVersionsCommand,DeleteObjectsCommand,DeleteBucketCommand}=require('@aws-sdk/client-s3');
const {ShortsMetadata1791763200000}=require('../migrations/1791763200000-ShortsMetadata');
const {ShortsUploads1791763202000}=require('../migrations/1791763202000-ShortsUploads');
const {ShortsRetentionHolds1791763216000}=require('../migrations/1791763216000-ShortsRetentionHolds');
const {ShortsStorageInventory1791763217000}=require('../migrations/1791763217000-ShortsStorageInventory');
const {ShortsStorageReferences1791763218000}=require('../migrations/1791763218000-ShortsStorageReferences');
const {ShortsStorageListService}=require('./shorts-storage-list.service');
const {ShortsStorageInventoryService}=require('./shorts-storage-inventory.service');
const {ShortsStorageReconciliationService}=require('./shorts-storage-reconciliation.service');
const {ShortsRetentionService}=require('./shorts-retention.service');
const {ShortsPrivateObjectsService}=require('./shorts-private-objects.service');
const {ShortsSourceReaderService}=require('./shorts-source-reader.service');
const {ShortsDatabaseService}=require('./shorts-database.service');
const {storageReconciliationConfig}=require('./shorts-storage-reconciliation.config');
const scope={network:'ae_uat',contract:releaseFixture().release.contract},sourceHash='a'.repeat(64),prefix='shorts-private-v1';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopePrefix=`${prefix}/${digest(Object.values(scope))}/`;
const ref=(id,slot,bytes=10)=>{const sha256=digest([id,slot]);return {key:`${scopePrefix}${id}/${slot}/key1/${sha256}`,keyId:'key1',bytes,sha256};};

test('manifest-only expansion validates ownership and parts without fetching video bytes',async()=>{
  const part=ref('clip','part/0'),manifest=ref('clip','manifest',500),sha256='b'.repeat(64);
  const job={id:'clip',creator:'ak_creator',input:{objectKey:manifest.key,manifest,bytes:10,sha256}};
  let data={version:1,id:job.id,creator:job.creator,bytes:10,sha256,parts:[{index:0,object:part}]},reads=0;
  const validate=new ShortsPrivateObjectsService({endpoint:'http://127.0.0.1:9',region:'us-east-1',bucket:'test',prefix,forcePathStyle:true,credentials:{accessKeyId:'test',secretAccessKey:'test'},keys:{key1:Buffer.alloc(32)},activeKeyId:'key1'});
  const reader=new ShortsSourceReaderService({validateReference:(...args)=>validate.validateReference(...args),get:async(_s,r)=>{assert.equal(r.key,manifest.key);reads++;return Buffer.from(JSON.stringify(data));}});
  try {
    assert.deepEqual(await reader.manifestParts(scope,job),[part]);assert.equal(reads,1);
    const original=structuredClone(data);
    for(const change of [{id:'other'},{creator:'ak_other'},{bytes:11},{sha256:'c'.repeat(64)},{parts:[]},
      {parts:[{index:1,object:part}]},{parts:[{index:0,object:{...part,bytes:11}}]},
      {parts:[{index:0,object:{...part,key:'off-scope/key'}}]},
      {parts:[{index:0,object:{...part,key:part.key.replace('/key1/','/old/'),keyId:'old'}}]}]) {
      data={...original,...change};await assert.rejects(reader.manifestParts(scope,job));
    }
    data=original;const cancelled=new AbortController();cancelled.abort();const before=reads;
    await assert.rejects(reader.manifestParts(scope,job,cancelled.signal));assert.equal(reads,before);
    await assert.rejects(reader.manifestParts(scope,{...job,input:{...job.input,manifest:{...manifest,bytes:32769}}}));assert.equal(reads,before);
  } finally {validate.onModuleDestroy();}
});

test('reference reconciliation preserves encrypted legacy parts, shared references and holds across resumes',{
  skip:!process.env.SHORTS_TEST_PG_URL||!process.env.SHORTS_TEST_S3_ENDPOINT,timeout:120000,
},async t=>{
  const url=new URL(process.env.SHORTS_TEST_PG_URL),endpoint=new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.ok(['127.0.0.1','localhost'].includes(endpoint.hostname));
  const schema=`shorts_refs_${randomUUID().replaceAll('-','')}`,role=`shrefs_${randomUUID().replaceAll('-','')}`,password=randomUUID();
  const dir=await mkdtemp(join(tmpdir(),'shorts-refs-')),admin=new DataSource({type:'postgres',url:url.href});await admin.initialize();
  const storage={endpoint:endpoint.origin,region:'us-east-1',bucket:`shorts-refs-${randomUUID()}`,prefix,forcePathStyle:true,
    credentials:{accessKeyId:process.env.SHORTS_TEST_S3_ACCESS_KEY,secretAccessKey:process.env.SHORTS_TEST_S3_SECRET_KEY}};
  const config={scope,sourceHash,prefix,storage,objectPrefix:scopePrefix,storageId:digest([endpoint.origin,storage.region,storage.bucket,prefix,true]),
    objects:{...storage,activeKeyId:'key1',keys:{key1:Buffer.alloc(32,7)}}};
  let owner,db,roleCreated=false,bucketCreated=false;
  const raw=new S3Client(storage),objects=new ShortsPrivateObjectsService(config.objects),list=new ShortsStorageListService(config);
  t.after(async()=>{
    list.onModuleDestroy();objects.onModuleDestroy();if(db?.isInitialized)await db.onModuleDestroy();if(owner?.isInitialized)await owner.destroy();
    if(roleCreated)await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.destroy();
    if(bucketCreated){let next;do{const p=await raw.send(new ListObjectVersionsCommand({Bucket:storage.bucket,...next}));
      const rows=[...(p.Versions||[]),...(p.DeleteMarkers||[])].map(r=>({Key:r.Key,VersionId:r.VersionId}));
      if(rows.length)await raw.send(new DeleteObjectsCommand({Bucket:storage.bucket,Delete:{Objects:rows}}));
      next=p.IsTruncated?{KeyMarker:p.NextKeyMarker,VersionIdMarker:p.NextVersionIdMarker}:null;
    }while(next);await raw.send(new DeleteBucketCommand({Bucket:storage.bucket}));}
    raw.destroy();await rm(dir,{recursive:true,force:true});
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options={type:'postgres',url:url.href,schema,extra:{options:`-c search_path=${schema}`,max:2},
    migrations:[ShortsMetadata1791763200000,ShortsUploads1791763202000,ShortsRetentionHolds1791763216000,ShortsStorageInventory1791763217000,ShortsStorageReferences1791763218000]};
  owner=new DataSource(options);await owner.initialize();await owner.runMigrations({transaction:'all'});
  await owner.undoLastMigration({transaction:'all'});await owner.runMigrations({transaction:'all'});
  await owner.query(`INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)`,[scope.network,scope.contract,sourceHash]);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT ON ${['shorts_runtime','shorts_content','shorts_ingestion','shorts_upload_sessions','shorts_upload_parts','shorts_retention_holds','shorts_storage_inventory_runs','shorts_storage_inventory_objects'].map(x=>`${schema}.${x}`).join(',')} TO ${role};
    GRANT SELECT,INSERT,UPDATE ON ${schema}.shorts_storage_reconciliations TO ${role};
    GRANT SELECT,INSERT ON ${schema}.shorts_storage_reference_roots,${schema}.shorts_storage_references TO ${role}`);
  const login=new URL(url);login.username=role;login.password=password;
  db=new ShortsDatabaseService(new DataSource({...options,url:login.href,migrations:[]}));await db.onModuleInit();
  const records=new ShortsRetentionService(db,config),sources=new ShortsSourceReaderService(objects);
  const service=(database=db,reader=sources,retention=records)=>new ShortsStorageReconciliationService(database,config,retention,reader,objects);
  const s=service();await s.verify();
  const args=[scope.network,scope.contract];
  await raw.send(new CreateBucketCommand({Bucket:storage.bucket}));bucketCreated=true;
  await raw.send(new PutBucketVersioningCommand({Bucket:storage.bucket,VersioningConfiguration:{Status:'Enabled'}}));
  const part=await objects.put(scope,'a-legacy','part/0',Buffer.from('source bytes'));
  const manifest=await objects.put(scope,'a-legacy','source-manifest',Buffer.from(JSON.stringify({version:1,id:'a-legacy',creator:'ak_creator',bytes:part.bytes,sha256:part.sha256,parts:[{index:0,object:part}]})));
  const input={objectKey:manifest.key,manifest,sha256:part.sha256,bytes:part.bytes};
  const rendered=await objects.put(scope,'b-ready','attempt/1/video',Buffer.from('prepared'));
  const deleted=await objects.put(scope,'b-ready','attempt/1/deleted',Buffer.from('gone'));
  await raw.send(new DeleteObjectCommand({Bucket:storage.bucket,Key:deleted.key}));
  const mismatch=await objects.put(scope,'b-ready','attempt/1/mismatch',Buffer.from('bad length'));
  await raw.send(new PutObjectCommand({Bucket:storage.bucket,Key:mismatch.key,Body:'broken'}));
  const missing=ref('b-ready','attempt/1/missing');
  const heldOrphan=await objects.put(scope,'c-held','attempt/1/orphan',Buffer.from('orphan but held'));
  const orphan=await objects.put(scope,'d-orphan','attempt/1/orphan',Buffer.from('unknown ownership'));
  await owner.query(`INSERT INTO shorts_ingestion(network,contract,id,creator,input) VALUES($1,$2,'a-legacy','ak_creator',$3)`,[...args,JSON.stringify(input)]);
  await owner.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,'b-ready','ak_creator',0,$3)`,
    [...args,JSON.stringify({id:'b-ready',creator:'ak_creator',publication:'withdrawn',reports:1,privateMedia:{files:{shared:part,rendered,deleted,mismatch,missing}}})]);
  const holds=new ShortsRetentionService(owner,config);
  await holds.hold({id:randomUUID(),resourceId:'c-held',reason:'recovery',reference:'case-held'});
  const inventory=new ShortsStorageInventoryService(owner,config,list),inventoryId=randomUUID();await inventory.start(inventoryId);
  assert.equal((await inventory.step(inventoryId)).listingComplete,true);

  await t.test('source and history privileges reject writes, filtering and excessive column grants',async()=>{
    await assert.rejects(service(owner,sources,new ShortsRetentionService(owner,config)).verify(),/restricted retention login/);
    for(const [table,grant] of [['shorts_retention_holds','UPDATE'],['shorts_storage_inventory_objects','INSERT'],['shorts_storage_references','UPDATE(bytes)'],['shorts_storage_reference_roots','REFERENCES(resource_id)'],['shorts_storage_reconciliations','DELETE']]){
      await owner.query(`GRANT ${grant} ON ${table} TO ${role}`);await assert.rejects(s.verify());await owner.query(`REVOKE ${grant} ON ${table} FROM ${role}`);
    }
    await owner.query('ALTER TABLE shorts_storage_references ENABLE ROW LEVEL SECURITY');await assert.rejects(s.verify());await owner.query('ALTER TABLE shorts_storage_references DISABLE ROW LEVEL SECURITY');
    await assert.rejects(db.query('DELETE FROM shorts_storage_references'),{code:'42501'});await assert.rejects(db.query('UPDATE shorts_content SET revision=revision+1'),{code:'42501'});await s.verify();
  });
  const runId=randomUUID();
  await t.test('binds an exact completed inventory and resumes without downloading source or rendered video',async()=>{
    const unfinished=randomUUID();await inventory.start(unfinished);await assert.rejects(s.start(randomUUID(),unfinished),{status:409});
    await assert.rejects(new ShortsStorageReconciliationService(db,{...config,storageId:'f'.repeat(64)},records,sources,objects).start(randomUUID(),inventoryId),{status:409});
    await s.start(runId,inventoryId);assert.deepEqual(await s.start(runId,inventoryId),await s.status(runId));
    const original=objects.get.bind(objects),reads=[];objects.get=async(...p)=>{reads.push(p[1].key);return original(...p);};
    try {
      const first=await s.step(runId);assert.equal(first.roots,'1');assert.equal(first.references,'2');assert.equal(first.referenceTraversalComplete,false);
      assert.deepEqual(reads,[manifest.key]);await assert.rejects(s.references(runId),{status:409});
      assert.equal((await service().step(runId)).roots,'2');assert.equal((await service().step(runId)).referenceTraversalComplete,true);
      const previous=reads.length;await s.step(runId);assert.equal(reads.length,previous);
    }finally{objects.get=original;}
    const r=await s.status(runId);assert.equal(r.references,'7');assert.equal(r.roots,'3');assert.equal(r.deletionEnabled,false);assert.equal(r.consistentSnapshot,false);
    await assert.rejects(owner.undoLastMigration({transaction:'all'}),/Preserve storage reference history/);
  });
  await t.test('both directions report shared, held, absent, deleted and size-mismatched observations',async()=>{
    let page=await s.references(runId,'',2),all=[...page.items];
    while(page.next){page=await s.references(runId,page.next,2);all.push(...page.items);}
    assert.equal(all.length,7);assert.equal(all.filter(r=>r.key===part.key).length,2);
    for(const [r,state] of [[part,'observed'],[missing,'not-observed'],[deleted,'delete-marker'],[mismatch,'size-mismatch']])assert.equal(all.find(x=>x.key===r.key).availability,state);
    page=await s.objects(runId,'',2);const physical=[...page.items];while(page.next){page=await s.objects(runId,page.next,2);physical.push(...page.items);}
    assert.equal(physical.find(x=>x.key===part.key).references,'2');assert.equal(physical.find(x=>x.key===heldOrphan.key).classification,'held');
    assert.equal(physical.find(x=>x.key===orphan.key).classification,'unresolved');assert.ok(physical.every(x=>x.eligibleForDeletion===false));
    await assert.rejects(s.references(runId,'malformed'),{status:400});await assert.rejects(s.references(runId,'',101),{status:400});
    // Two latest observations are possible in a non-snapshot scan. Never claim this proves availability.
    const row=(await owner.query('SELECT * FROM shorts_storage_inventory_objects WHERE run_id=$1 AND object_key=$2',[inventoryId,part.key]))[0];
    await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
      VALUES($1,$2,$3,$4,$5,'changed',false,true,$6,$7)`,[...args,inventoryId,'f'.repeat(64),part.key,row.bytes,row.modified_at]);
    assert.equal((await s.references(runId)).items.find(r=>r.key===part.key).availability,'conflicting-latest-observations');
  });
  await t.test('atomic checkpoints reject concurrent stale scans without duplicate edges',async()=>{
    const id=randomUUID();await s.start(id,inventoryId);
    let arrive=0,release;const gate=new Promise(resolve=>release=resolve);
    const reader={manifestParts:async(...p)=>{if(++arrive===2)release();await gate;return sources.manifestParts(...p);}};
    const results=await Promise.allSettled([service(db,reader).step(id),service(db,reader).step(id)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
    assert.equal((await s.status(id)).roots,'1');assert.equal((await s.status(id)).references,'2');
  });
  await t.test('failed SQL and cancelled manifest IO leave the root available to resume',async()=>{
    const id=randomUUID();await s.start(id,inventoryId);
    const failed={query:(...p)=>db.query(...p),transaction:fn=>db.transaction(async tx=>{await fn(tx);throw new Error('rollback injected');})};
    await assert.rejects(service(failed).step(id),/rollback injected/);assert.equal((await s.status(id)).roots,'0');
    assert.equal((await db.query('SELECT count(*) AS n FROM shorts_storage_references WHERE run_id=$1',[id]))[0].n,'0');
    const abort=new AbortController(),reader={manifestParts:async(...p)=>{abort.abort();return sources.manifestParts(...p);}};
    await assert.rejects(service(db,reader).step(id,abort.signal));assert.equal((await s.status(id)).roots,'0');
    const uncertain={query:(...p)=>db.query(...p),transaction:async fn=>{await db.transaction(fn);throw new Error('acknowledgement lost');}};
    await assert.rejects(service(uncertain).step(id),/acknowledgement lost/);assert.equal((await s.status(id)).roots,'1');
    assert.equal((await s.step(id)).roots,'2');
  });
  await t.test('manifest failure, changed live holds and conflicting roots cannot silently advance',async()=>{
    const id=randomUUID();await s.start(id,inventoryId);
    await assert.rejects(service(db,{manifestParts:async()=>{throw new Error('missing manifest');}}).step(id),/missing manifest/);assert.equal((await s.status(id)).roots,'0');
    const reader={manifestParts:async(...p)=>{const result=await sources.manifestParts(...p);await holds.hold({id:randomUUID(),resourceId:'a-legacy',reason:'safety',reference:'case-new'});return result;}};
    await assert.rejects(service(db,reader).step(id),{status:409});assert.equal((await s.status(id)).roots,'0');await s.step(id);
    const previous=(await owner.query("SELECT body FROM shorts_content WHERE id='b-ready'"))[0].body;
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{privateMedia,files,shared,bytes}','13') WHERE id='b-ready'");
    await assert.rejects(s.step(id),{status:409});assert.equal((await s.status(id)).roots,'1');
    await owner.query("UPDATE shorts_content SET body=$1 WHERE id='b-ready'",[previous]);await s.step(id);
  });
  await t.test('compiled Nest command uses separate read environment and returns metadata only',async()=>{
    const manifestPath=join(dir,'deployment.json'),credentials=join(dir,'credentials.json'),keys=join(dir,'keys.json'),request=join(dir,'request.json');
    await writeFile(manifestPath,JSON.stringify(releaseFixture({...scope,sourceHash}).release));await writeFile(credentials,JSON.stringify(storage.credentials),{mode:0o600});
    await writeFile(keys,JSON.stringify({activeKeyId:'key1',keys:{key1:config.objects.keys.key1.toString('hex')}}),{mode:0o600});
    const env={PATH:process.env.PATH,NODE_ENV:'test',ENABLE_SHORTS:'true',AE_NETWORK_ID:'ae_uat',SHORTS_DEPLOYMENT_FILE:manifestPath,
      SHORTS_DB_CONCURRENCY:'1',DB_HOST:url.hostname,DB_PORT:url.port,DB_DATABASE:url.pathname.slice(1),DB_USER:role,DB_PASSWORD:password,PGOPTIONS:`-c search_path=${schema}`,
      SHORTS_PRIVATE_S3_ENDPOINT:endpoint.origin,SHORTS_PRIVATE_S3_REGION:storage.region,SHORTS_PRIVATE_S3_BUCKET:storage.bucket,
      SHORTS_PRIVATE_S3_PREFIX:prefix,SHORTS_PRIVATE_S3_CREDENTIALS_FILE:credentials,SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE:keys,SHORTS_PRIVATE_S3_ALLOW_LOOPBACK:'1'};
    assert.equal((await storageReconciliationConfig(env)).storageId,config.storageId);
    for(const change of [{SHORTS_OPERATOR_KEY_FILE:'/unneeded'},{AWS_ACCESS_KEY_ID:'ambient'},{SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE:undefined},{ENABLE_SHORTS:'false'},{AE_NETWORK_ID:'ae_mainnet'}])await assert.rejects(storageReconciliationConfig({...env,...change}));
    const run=async(action,input)=>{await writeFile(request,JSON.stringify(input));const r=await promisify(execFile)(process.execPath,['dist/shorts/storage-reconciliation-main.js',action,request],{env,timeout:15000});assert.equal(r.stderr,'');return JSON.parse(r.stdout);};
    const id=randomUUID();assert.equal((await run('start',{id,inventoryId})).roots,'0');assert.equal((await run('scan',{id,pages:1})).roots,'1');
    assert.equal((await run('scan',{id})).referenceTraversalComplete,true);assert.equal((await run('status',{id})).references,'7');
    assert.equal((await run('objects',{id,limit:1})).items.length,1);assert.equal((await run('references',{id,limit:1})).items.length,1);
    await assert.rejects(run('scan',{id,pages:101}));await assert.rejects(run('objects',{id,delete:true}));
  });
});
