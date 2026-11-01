const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {createServer}=require('node:http');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {DataSource}=require('typeorm');
const {S3Client,CreateBucketCommand,PutBucketVersioningCommand,PutObjectCommand,DeleteObjectCommand,ListObjectVersionsCommand,DeleteObjectsCommand,DeleteBucketCommand}=require('@aws-sdk/client-s3');
const {ShortsMetadata1791763200000}=require('../migrations/1791763200000-ShortsMetadata');
const {ShortsStorageInventory1791763217000}=require('../migrations/1791763217000-ShortsStorageInventory');
const {ShortsStorageListService}=require('./shorts-storage-list.service');
const {ShortsStorageInventoryService}=require('./shorts-storage-inventory.service');
const {ShortsDatabaseService}=require('./shorts-database.service');
const {storageInventoryConfig}=require('./shorts-storage-inventory.config');
const scope={network:'ae_uat',contract: releaseFixture().release.contract}, sourceHash='a'.repeat(64);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const makeConfig=endpoint=>{
  const storage={endpoint,region:'us-east-1',bucket:'private-inventory',prefix:'shorts-private-v1',forcePathStyle:true,
    credentials:{accessKeyId:'test',secretAccessKey:'test'}};
  return {scope,sourceHash,prefix:storage.prefix,storage,objectPrefix:`${storage.prefix}/${digest(Object.values(scope))}/`,
    storageId:digest([endpoint,storage.region,storage.bucket,storage.prefix,true])};
};
const xmlEscape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const listing=(c,{key=c.objectPrefix+'video',truncated=false,nextKey,nextVersion,version='null',size=4}={})=>
  `<ListVersionsResult><Name>${c.storage.bucket}</Name><Prefix>${c.objectPrefix}</Prefix><IsTruncated>${truncated}</IsTruncated>
  <Version><Key>${xmlEscape(key)}</Key><VersionId>${version}</VersionId><IsLatest>true</IsLatest><Size>${size}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Version>
  ${nextKey?`<NextKeyMarker>${xmlEscape(nextKey)}</NextKeyMarker>`:''}${nextVersion?`<NextVersionIdMarker>${nextVersion}</NextVersionIdMarker>`:''}</ListVersionsResult>`;

async function httpFixture(t,handler) {
  const server=createServer(handler); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config=makeConfig(`http://127.0.0.1:${server.address().port}`),reader=new ShortsStorageListService(config);
  t.after(async()=>{reader.onModuleDestroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {config,reader};
}
test('storage listing scopes requests and preserves opaque version cursors',async t=>{
  let response;
  const f=await httpFixture(t,(req,res)=>{
    const u=new URL(req.url,'http://local'); assert.equal(req.method,'GET'); assert.ok(u.searchParams.has('versions'));
    assert.equal(u.searchParams.get('prefix'),f.config.objectPrefix); assert.equal(u.searchParams.get('max-keys'),'100');
    res.end(response);
  });
  response=listing(f.config,{truncated:true,nextKey:f.config.objectPrefix+'video',nextVersion:'v/2+=',version:'v/3+='});
  const first=await f.reader.page(null); assert.equal(first.entries.length,1); assert.equal(first.entries[0].bytes,4);
  assert.deepEqual(first.next,{key:f.config.objectPrefix+'video',version:'v/2+='});
  response=listing(f.config,{version:'v/2+='}); assert.equal((await f.reader.page(first.next)).next,null);
});
test('malformed, off-scope, repeated and oversized S3 responses fail closed',async t=>{
  let response;
  const f=await httpFixture(t,(_req,res)=>res.end(response));
  const cursor={key:f.config.objectPrefix+'video',version:'null'};
  for (const result of [
    listing(f.config,{key:'different/deployment'}), listing(f.config,{size:-1}), listing(f.config,{size:9007199254740992}),
    listing(f.config,{truncated:true,nextKey:cursor.key}), listing(f.config,{truncated:true,nextKey:cursor.key,nextVersion:'null'}),
    listing(f.config).replace('<IsTruncated>false</IsTruncated>',''), 'not XML', 'x'.repeat(1048577),
  ]) { response=result; await assert.rejects(f.reader.page(cursor),{status:503}); }
  response=listing(f.config); await assert.rejects(f.reader.page({key:'other',version:'x'}),{status:503});
});
test('stalled listing body is cancelled and shutdown prevents another request',async t=>{
  let started; const seen=new Promise(resolve=>started=resolve); let calls=0;
  const f=await httpFixture(t,(_req,res)=>{calls++;res.write('<ListVersionsResult>');started();});
  const stop=new AbortController(); const result=f.reader.page(null,stop.signal);
  const rejected=assert.rejects(result,{status:503}); await seen; stop.abort(); await rejected;
  f.reader.onModuleDestroy(); await assert.rejects(f.reader.page(null),{status:503}); assert.equal(calls,1);
});
test('redirects and storage errors never leak provider content or credentials',async t=>{
  let forwarded=0;
  const target=createServer((_req,res)=>{forwarded++;res.end('unexpected');}); await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{target.closeAllConnections();await new Promise(resolve=>target.close(resolve));});
  const f=await httpFixture(t,(_req,res)=>{res.writeHead(307,{location:`http://127.0.0.1:${target.address().port}`});res.end('private-provider-secret');});
  await assert.rejects(f.reader.page(null),error=>error.status===503&&!error.message.includes('private-provider-secret'));assert.equal(forwarded,0);
});

test('durable inventory checkpoints, restricted roles and actual versioned S3 listing',{
  skip:!process.env.SHORTS_TEST_PG_URL||!process.env.SHORTS_TEST_S3_ENDPOINT,timeout:90000,
},async t=>{
  const url=new URL(process.env.SHORTS_TEST_PG_URL), endpoint=new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname)); assert.ok(['localhost','127.0.0.1'].includes(endpoint.hostname));
  const schema=`shorts_storage_inventory_${randomUUID().replaceAll('-','')}`,role=`shinventory_${randomUUID().replaceAll('-','')}`,password=randomUUID();
  const admin=new DataSource({type:'postgres',url:url.href});await admin.initialize();
  let owner,db,reader,raw,bucketCreated=false,roleCreated=false;
  const dir=await mkdtemp(join(tmpdir(),'shorts-storage-inventory-'));
  const c=makeConfig(endpoint.origin);c.storage.bucket=`shorts-inventory-${randomUUID()}`;
  c.storage.credentials={accessKeyId:process.env.SHORTS_TEST_S3_ACCESS_KEY,secretAccessKey:process.env.SHORTS_TEST_S3_SECRET_KEY};
  c.storageId=digest([endpoint.origin,c.storage.region,c.storage.bucket,c.prefix,true]);
  t.after(async()=>{
    reader?.onModuleDestroy(); if(db?.isInitialized)await db.onModuleDestroy();if(owner?.isInitialized)await owner.destroy();
    if(roleCreated)await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.destroy();
    if(bucketCreated){
      let next;
      do{const page=await raw.send(new ListObjectVersionsCommand({Bucket:c.storage.bucket,...next}));
        const objects=[...(page.Versions||[]),...(page.DeleteMarkers||[])].map(row=>({Key:row.Key,VersionId:row.VersionId}));
        if(objects.length)await raw.send(new DeleteObjectsCommand({Bucket:c.storage.bucket,Delete:{Objects:objects}}));
        next=page.IsTruncated?{KeyMarker:page.NextKeyMarker,VersionIdMarker:page.NextVersionIdMarker}:null;
      }while(next);
      await raw.send(new DeleteBucketCommand({Bucket:c.storage.bucket}));
    } raw?.destroy();await rm(dir,{recursive:true,force:true});
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options={type:'postgres',url:url.href,schema,extra:{options:`-c search_path=${schema}`,max:2},migrations:[ShortsMetadata1791763200000,ShortsStorageInventory1791763217000]};
  owner=new DataSource(options);await owner.initialize();await owner.runMigrations({transaction:'all'});await owner.undoLastMigration({transaction:'all'});await owner.runMigrations({transaction:'all'});
  await owner.query(`INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)`,[scope.network,scope.contract,sourceHash]);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON ${schema}.shorts_runtime TO ${role};
    GRANT SELECT,INSERT,UPDATE ON ${schema}.shorts_storage_inventory_runs TO ${role};
    GRANT SELECT,INSERT ON ${schema}.shorts_storage_inventory_pages,${schema}.shorts_storage_inventory_objects TO ${role}`);
  const login=new URL(url);login.username=role;login.password=password;
  db=new ShortsDatabaseService(new DataSource({...options,url:login.href,migrations:[]}));await db.onModuleInit();
  const entry=n=>({key:c.objectPrefix+`root-${n}`,version:'null',deleted:false,latest:true,bytes:4,modifiedAt:'2026-01-01T00:00:00.000Z'});
  const cursor=n=>({key:c.objectPrefix+`root-${n}`,version:'null'});
  const service=storage=>new ShortsStorageInventoryService(db,c,storage);

  await t.test('role checks reject source writes and mutable object evidence',async()=>{
    const s=service({});await s.verify();await assert.rejects(new ShortsStorageInventoryService(owner,c,{}).verify(),/restricted/);
    await owner.query(`GRANT UPDATE(source_hash) ON shorts_runtime TO ${role}`);await assert.rejects(s.verify(),/read-only/);await owner.query(`REVOKE UPDATE(source_hash) ON shorts_runtime FROM ${role}`);
    await owner.query(`GRANT UPDATE ON shorts_storage_inventory_objects TO ${role}`);await assert.rejects(s.verify(),/database grants/);await owner.query(`REVOKE UPDATE ON shorts_storage_inventory_objects FROM ${role}`);
    await owner.query(`GRANT UPDATE(bytes) ON shorts_storage_inventory_objects TO ${role}`);await assert.rejects(s.verify(),/database grants/);await owner.query(`REVOKE UPDATE(bytes) ON shorts_storage_inventory_objects FROM ${role}`);
    await assert.rejects(db.query('DELETE FROM shorts_storage_inventory_objects'),{code:'42501'});
    await assert.rejects(db.query('SELECT * FROM shorts_content'),{code:'42501'});await s.verify();
  });
  await t.test('new process resumes a partial run without repeating saved pages',async()=>{
    const id=randomUUID();let calls=0;const storage={page:async cur=>{calls++;return cur?{entries:[entry(2)],next:null}:{entries:[entry(1)],next:cursor(1)};}};
    const a=service(storage);await a.start(id);await a.start(id);const first=await a.step(id);assert.equal(first.pages,'1');assert.equal(first.entries,'1');assert.equal(first.listingComplete,false);
    const b=service(storage);const final=await b.step(id);assert.equal(final.listingComplete,true);assert.equal(final.entries,'2');assert.equal(final.storedBytes,'8');
    assert.deepEqual(await b.step(id),final);assert.equal(calls,2);
    const page=await b.objects(id,'',1),last=await b.objects(id,page.next,1);assert.equal(page.items.length,1);assert.equal(last.items.length,1);assert.equal(last.next,null);
    await assert.rejects(owner.undoLastMigration({transaction:'all'}),/Preserve storage inventory history/);
    await assert.rejects(new ShortsStorageInventoryService(db,{...c,storageId:'b'.repeat(64)},storage).status(id),{status:409});
    await assert.rejects(b.objects(id,'invalid'),{status:400});await assert.rejects(b.start('invalid'),{status:400});
  });
  await t.test('concurrent page attempts persist one result and stale writer is rejected',async()=>{
    const id=randomUUID();let calls=0,release;const gate=new Promise(resolve=>release=resolve);
    const s=service({page:async()=>{if(++calls===2)release();await gate;return{entries:[entry(1)],next:null};}});await s.start(id);
    const results=await Promise.allSettled([s.step(id),s.step(id)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.find(x=>x.status==='rejected').reason.status,409);assert.equal((await s.status(id)).entries,'1');
  });
  await t.test('failed SQL page rolls back rows and cursor; lost acknowledgement remains recoverable',async()=>{
    const id=randomUUID(),storage={page:async()=>({entries:[entry(1)],next:null})},s=service(storage);await s.start(id);
    const failing={query:db.query.bind(db),transaction:(...args)=>db.transaction(async tx=>{
      const work=args.at(-1);return work({query:async(sql,values)=>{const result=await tx.query(sql,values);if(sql.startsWith('UPDATE shorts_storage_inventory_runs'))throw new Error('injected failure');return result;}});
    })};
    await assert.rejects(new ShortsStorageInventoryService(failing,c,storage).step(id),/injected/);assert.equal((await s.status(id)).entries,'0');assert.equal((await s.status(id)).pages,'0');
    const uncertain={query:db.query.bind(db),transaction:async(...args)=>{await db.transaction(...args);throw new Error('lost acknowledgement');}};
    await assert.rejects(new ShortsStorageInventoryService(uncertain,c,storage).step(id),/lost acknowledgement/);
    assert.equal((await s.status(id)).listingComplete,true);assert.equal((await s.step(id)).entries,'1');
  });
  await t.test('cursor loops and changed version metadata cannot silently advance',async()=>{
    const id=randomUUID();let n=0;const s=service({page:async()=>({entries:[entry(++n)],next:cursor(n===3?1:n)})});await s.start(id);
    await s.step(id);await s.step(id);await assert.rejects(s.step(id),/repeated/);assert.equal((await s.status(id)).pages,'2');
    const other=randomUUID();let count=0;const changed=service({page:async()=>({entries:[{...entry(1),bytes:++count===1?4:5}],next:cursor(count)})});await changed.start(other);await changed.step(other);
    await assert.rejects(changed.step(other),{status:409});assert.equal((await changed.status(other)).storedBytes,'4');
  });
  await t.test('cancelled storage work leaves its page available to resume',async()=>{
    const id=randomUUID(),stop=new AbortController();const s=service({page:async()=>{stop.abort();return{entries:[entry(1)],next:null};}});await s.start(id);
    await assert.rejects(s.step(id,stop.signal));assert.equal((await s.status(id)).entries,'0');assert.equal((await s.status(id)).pages,'0');
  });

  raw=new S3Client({endpoint:endpoint.origin,region:c.storage.region,credentials:c.storage.credentials,forcePathStyle:true});
  await raw.send(new CreateBucketCommand({Bucket:c.storage.bucket}));bucketCreated=true;
  await raw.send(new PutObjectCommand({Bucket:c.storage.bucket,Key:c.objectPrefix+'unversioned',Body:'plain'}));
  await raw.send(new PutBucketVersioningCommand({Bucket:c.storage.bucket,VersioningConfiguration:{Status:'Enabled'}}));
  for(let i=0;i<101;i++)await raw.send(new PutObjectCommand({Bucket:c.storage.bucket,Key:c.objectPrefix+`orphan-${String(i).padStart(3,'0')}`,Body:'four'}));
  for(const body of ['first','second'])await raw.send(new PutObjectCommand({Bucket:c.storage.bucket,Key:c.objectPrefix+'versioned',Body:body}));
  await raw.send(new DeleteObjectCommand({Bucket:c.storage.bucket,Key:c.objectPrefix+'versioned'}));
  await raw.send(new PutObjectCommand({Bucket:c.storage.bucket,Key:'another-deployment/private',Body:'excluded'}));
  reader=new ShortsStorageListService(c);
  await t.test('actual S3 pages include unrecorded objects, older versions and delete markers',async()=>{
    const s=service(reader),id=randomUUID();await s.start(id);let status=await s.step(id);assert.equal(status.listingComplete,false);assert.equal(status.entries,'100');
    status=await service(reader).step(id);assert.equal(status.listingComplete,true);assert.equal(status.entries,'105');assert.equal(status.deleteMarkers,'1');
    assert.equal(status.storedBytes,'420');assert.equal(status.currentBytes,'409');assert.equal(status.referenceReconciliationComplete,false);assert.equal(status.deletionEnabled,false);
    const first=await s.objects(id),last=await s.objects(id,first.next);assert.equal(first.items.length+last.items.length,105);
  });
  await t.test('compiled Nest inventory runs with explicit storage credentials and no encryption/signing keys',async()=>{
    const manifest=join(dir,'deployment.json'),credentials=join(dir,'credentials.json'),request=join(dir,'request.json');
    await writeFile(manifest,JSON.stringify(releaseFixture({...scope,sourceHash}).release));await writeFile(credentials,JSON.stringify(c.storage.credentials),{mode:0o600});
    const env={PATH:process.env.PATH,NODE_ENV:'test',ENABLE_SHORTS:'true',AE_NETWORK_ID:'ae_uat',SHORTS_DEPLOYMENT_FILE:manifest,
      SHORTS_DB_CONCURRENCY:'1',DB_HOST:url.hostname,DB_PORT:url.port,DB_DATABASE:url.pathname.slice(1),DB_USER:role,DB_PASSWORD:password,PGOPTIONS:`-c search_path=${schema}`,
      SHORTS_PRIVATE_S3_ENDPOINT:endpoint.origin,SHORTS_PRIVATE_S3_REGION:c.storage.region,SHORTS_PRIVATE_S3_BUCKET:c.storage.bucket,
      SHORTS_PRIVATE_S3_PREFIX:c.prefix,SHORTS_PRIVATE_S3_CREDENTIALS_FILE:credentials,SHORTS_PRIVATE_S3_ALLOW_LOOPBACK:'1'};
    assert.equal((await storageInventoryConfig(env)).storageId,c.storageId);
    await assert.rejects(storageInventoryConfig({...env,SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE:'/unneeded'}));
    await assert.rejects(storageInventoryConfig({...env,SHORTS_OPERATOR_KEY_FILE:'/unneeded'}));
    await assert.rejects(storageInventoryConfig({...env,AWS_ACCESS_KEY_ID:'ambient'}));
    const run=async(action,input)=>{await writeFile(request,JSON.stringify(input));const r=await promisify(execFile)(process.execPath,['dist/shorts/storage-inventory-main.js',action,request],{env,timeout:15000});assert.equal(r.stderr,'');return JSON.parse(r.stdout);};
    const id=randomUUID();assert.equal((await run('start',{id})).pages,'0');assert.equal((await run('scan',{id,pages:1})).pages,'1');
    assert.equal((await run('scan',{id})).listingComplete,true);assert.equal((await run('status',{id})).entries,'105');
    assert.equal((await run('objects',{id,limit:1})).items.length,1);
    await assert.rejects(run('scan',{id,pages:101}));await assert.rejects(run('objects',{id,delete:true}));
  });
  await t.test('actual S3 continuation splits multiple versions of the same key across pages',async()=>{
    const prefix=c.objectPrefix+'same-key-pages/';
    for(let i=0;i<105;i++)await raw.send(new PutObjectCommand({Bucket:c.storage.bucket,Key:prefix+'video',Body:'four'}));
    const versions=new ShortsStorageListService({...c,objectPrefix:prefix});
    try {
      const first=await versions.page(null);assert.equal(first.entries.length,100);assert.ok(first.next.key.startsWith(prefix));assert.ok(first.next.version);
      const second=await versions.page(first.next);assert.equal(second.entries.length,5);assert.equal(second.next,null);
      assert.equal(new Set([...first.entries,...second.entries].map(entry=>entry.version)).size,105);
      assert.equal([...first.entries,...second.entries].filter(entry=>entry.latest).length,1);
      assert.ok([...first.entries,...second.entries].every(entry=>entry.key===prefix+'video'));
    } finally {versions.onModuleDestroy();}
  });
});
