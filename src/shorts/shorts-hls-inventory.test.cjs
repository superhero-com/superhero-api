const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {Redis}=require('ioredis');
const {DataSource}=require('typeorm');
const {ShortsMetadata1791763200000}=require('../migrations/1791763200000-ShortsMetadata');
const {ShortsUploads1791763202000}=require('../migrations/1791763202000-ShortsUploads');
const {ShortsRetentionHolds1791763216000}=require('../migrations/1791763216000-ShortsRetentionHolds');
const {ShortsHlsInventory1791763219000}=require('../migrations/1791763219000-ShortsHlsInventory');
const {ShortsDatabaseService}=require('./shorts-database.service');
const {ShortsRetentionService}=require('./shorts-retention.service');
const {ShortsHlsInventoryService}=require('./shorts-hls-inventory.service');
const {ShortsHlsIndexReaderService}=require('./shorts-hls-index-reader.service');
const {hlsInventoryConfig}=require('./shorts-hls-inventory.config');
const {hlsSourceKey,hlsObservation}=require('./shorts-hls-inventory-data');
const hash=s=>createHash('sha256').update(s).digest('hex');
const scope={network:'ae_uat',contract: releaseFixture().release.contract},sourceHash='a'.repeat(64);
const playlist='#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\nsegment-000.m4s\n#EXT-X-ENDLIST\n';
const pkg={cid:'b'+'a'.repeat(58),playlist,files:[{name:'index.m3u8',bytes:Buffer.byteLength(playlist),sha256:hash(playlist)},
  ...['init.mp4','segment-000.m4s'].map(name=>({name,bytes:8,sha256:'b'.repeat(64)}))]};
const bytes=pkg.files.reduce((n,f)=>n+f.bytes,0);
const source=id=>({id,cid:'Qm'+'1'.repeat(44),file:{name:'video.mp4',bytes:64,sha256:'a'.repeat(64)}});

test('HLS inventory rejects malformed indexes instead of treating them as garbage',()=>{
  const key=hlsSourceKey(source('clip')),raw=JSON.stringify(pkg);
  assert.equal(hlsObservation(key,raw).bytes,bytes);
  assert.equal(key,hash(`hls-v2\nclip\n${source('clip').cid}\n${'a'.repeat(64)}\n64`));
  for(const bad of [{...pkg,cid:'invalid'},{...pkg,files:[]},{...pkg,files:[...pkg.files,pkg.files[0]]},
    {...pkg,files:pkg.files.map(f=>({...f,bytes:0}))},{...pkg,playlist:playlist.replace('segment-000.m4s','https://remote/video')},
    {...pkg,playlist:playlist.replace('#EXT-X-ENDLIST','')},{...pkg,playlist:playlist.replace('2.000000','200.000000')},
    {...pkg,files:pkg.files.map(f=>({...f,sha256:'0'.repeat(64)}))}])assert.throws(()=>hlsObservation(key,JSON.stringify(bad)));
  assert.throws(()=>hlsObservation(key,'x'.repeat(32769)));assert.throws(()=>hlsSourceKey({...source('clip'),file:null}));
});

test('read-only Redis HLS inventory checkpoints metadata and preserves shared/held packages',{
  skip:!process.env.SHORTS_TEST_PG_URL||!process.env.SHORTS_TEST_REDIS_URL,timeout:120000,
},async t=>{
  const pg=new URL(process.env.SHORTS_TEST_PG_URL),redisUrl=new URL(process.env.SHORTS_TEST_REDIS_URL);
  assert.ok(['localhost','127.0.0.1'].includes(pg.hostname));assert.ok(['localhost','127.0.0.1'].includes(redisUrl.hostname));
  const namespace=`inventory-${randomUUID()}`,user=`hls_${randomUUID().replaceAll('-','')}`,password=randomUUID();
  const schema=`hls_${randomUUID().replaceAll('-','')}`,role=`hlsdb_${randomUUID().replaceAll('-','')}`,dbPassword=randomUUID();
  const dir=await mkdtemp(join(tmpdir(),'hls-inventory-')),admin=new DataSource({type:'postgres',url:pg.href});await admin.initialize();
  const control=new Redis(redisUrl.href);await control.ping();
  let owner,db,roleCreated=false,aclCreated=false;const readers=[];
  const credentials=join(dir,'redis-password'),manifest=join(dir,'deployment.json');
  await writeFile(credentials,password,{mode:0o600});await writeFile(manifest,JSON.stringify(releaseFixture({...scope,sourceHash}).release));
  const readUrl=new URL(redisUrl);readUrl.username=user;
  const env={PATH:process.env.PATH,NODE_ENV:'test',ENABLE_SHORTS:'true',AE_NETWORK_ID:'ae_uat',SHORTS_DEPLOYMENT_FILE:manifest,
    SHORTS_HLS_REDIS_URL:readUrl.href,SHORTS_HLS_REDIS_PASSWORD_FILE:credentials,SHORTS_HLS_NAMESPACE:namespace,SHORTS_HLS_ALLOW_LOOPBACK:'1',
    SHORTS_DB_CONCURRENCY:'1',DB_HOST:pg.hostname,DB_PORT:pg.port,DB_DATABASE:pg.pathname.slice(1),DB_USER:role,DB_PASSWORD:dbPassword,PGOPTIONS:`-c search_path=${schema}`};
  const config=await hlsInventoryConfig(env),key=k=>`${namespace}:prepared:${k}`;
  const reader=()=>{const r=new ShortsHlsIndexReaderService(config);readers.push(r);return r;};
  t.after(async()=>{
    for(const r of readers)r.onModuleDestroy();if(db?.isInitialized)await db.onModuleDestroy();if(owner?.isInitialized)await owner.destroy();
    if(roleCreated)await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.destroy();
    const keys=await control.keys(`${namespace}:*`);if(keys.length)await control.del(...keys);await control.del(`${namespace}-outside:prepared:${'f'.repeat(64)}`);
    if(aclCreated)await control.acl('DELUSER',user);control.disconnect();await rm(dir,{recursive:true,force:true});
  });
  await control.acl('SETUSER',user,'reset','on',`>${password}`,`~${namespace}:prepared:*`,'-@all','+ping','+select','+eval_ro','+scan','+strlen','+pttl','+get','+info');aclCreated=true;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options={type:'postgres',url:pg.href,schema,extra:{options:`-c search_path=${schema}`,max:2},
    migrations:[ShortsMetadata1791763200000,ShortsUploads1791763202000,ShortsRetentionHolds1791763216000,ShortsHlsInventory1791763219000]};
  owner=new DataSource(options);await owner.initialize();await owner.runMigrations({transaction:'all'});await owner.undoLastMigration({transaction:'all'});await owner.runMigrations({transaction:'all'});
  const args=[scope.network,scope.contract];await owner.query(`INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)`,[...args,sourceHash]);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${dbPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON ${['shorts_runtime','shorts_content','shorts_ingestion','shorts_upload_sessions','shorts_upload_parts','shorts_retention_holds'].map(x=>`${schema}.${x}`).join(',')} TO ${role};
    GRANT SELECT,INSERT,UPDATE ON ${schema}.shorts_hls_inventory_runs TO ${role};
    GRANT SELECT,INSERT ON ${schema}.shorts_hls_inventory_roots,${schema}.shorts_hls_inventory_entries,${schema}.shorts_hls_inventory_pages TO ${role}`);
  const login=new URL(pg);login.username=role;login.password=dbPassword;
  db=new ShortsDatabaseService(new DataSource({...options,url:login.href,migrations:[]}));await db.onModuleInit();
  const records=new ShortsRetentionService(db,config),read=reader(),service=(index=read,database=db,settings=config)=>new ShortsHlsInventoryService(database,settings,records,index),s=service();await s.verify();
  const content=async id=>{const input=source(id);await owner.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,'ak_creator',0,$4)`,
    [...args,id,JSON.stringify({id,creator:'ak_creator',cid:input.cid,files:[input.file],publication:'withdrawn'})]);};
  for(const id of ['a-video','b-video','c-missing'])await content(id);
  const holds=new ShortsRetentionService(owner,config);await holds.hold({id:randomUUID(),resourceId:'a-video',reason:'safety',reference:'case-a'});
  for(let i=0;i<30;i++)await holds.hold({id:randomUUID(),resourceId:`hold-${String(i).padStart(2,'0')}`,reason:'recovery',reference:'case-unrecorded'});
  for(const id of ['a-video','b-video'])await control.set(key(hlsSourceKey(source(id))),JSON.stringify(pkg));
  for(let i=0;i<105;i++)await control.set(key(hash(`unknown-${i}`)),JSON.stringify({...pkg,cid:'b'+'b'.repeat(58)}));
  await control.set(`${namespace}-outside:prepared:${'f'.repeat(64)}`,JSON.stringify(pkg));
  const indexPhase=async id=>{await s.start(id);let status;do{status=await s.step(id);}while(status.phase==='references');return status;};

  await t.test('Redis and SQL credentials cannot modify source data or erase inventory evidence',async()=>{
    const r=reader();await r.page('0');
    await assert.rejects(r.client.set(key('e'.repeat(64)),'bad'),/NOPERM/);await assert.rejects(r.client.del(key('e'.repeat(64))),/NOPERM/);
    await assert.rejects(r.client.get(`${namespace}-outside:prepared:${'f'.repeat(64)}`),/NOPERM/);
    for(const [table,grant] of [['shorts_retention_holds','UPDATE'],['shorts_hls_inventory_entries','UPDATE(bytes)'],['shorts_hls_inventory_roots','REFERENCES(resource_id)'],['shorts_hls_inventory_runs','DELETE']]){
      await owner.query(`GRANT ${grant} ON ${table} TO ${role}`);await assert.rejects(s.verify());await owner.query(`REVOKE ${grant} ON ${table} FROM ${role}`);
    }
    await owner.query('ALTER TABLE shorts_hls_inventory_roots ENABLE ROW LEVEL SECURITY');await assert.rejects(s.verify());await owner.query('ALTER TABLE shorts_hls_inventory_roots DISABLE ROW LEVEL SECURITY');await s.verify();
  });
  const runId=randomUUID();
  await t.test('multiple reference and Redis pages survive restarts and retain exact counters',async()=>{
    await s.start(runId);assert.equal((await s.step(runId)).roots,'25');assert.equal((await service(reader()).step(runId)).phase,'index');
    let status=await service(reader()).step(runId);assert.equal(status.indexTraversalComplete,false);
    while(!status.indexTraversalComplete)status=await service(reader()).step(runId);
    assert.equal(status.roots,'33');assert.equal(status.entries,'107');assert.equal(status.indexedMediaBytes,String(107*bytes));assert.match(status.redisEpoch,/^[a-f0-9]{40}$/);
    assert.equal(status.physicalPinInventoryComplete,false);assert.equal(status.consistentSnapshot,false);assert.equal(status.deletionEnabled,false);
    const forbidden={page:()=>{throw new Error('must not read again');}};assert.equal((await service(forbidden).step(runId)).indexTraversalComplete,true);
    await assert.rejects(service(read,db,{...config,storageId:'f'.repeat(64)}).status(runId),{status:409});
    await assert.rejects(owner.undoLastMigration({transaction:'all'}),/Preserve HLS inventory history/);
  });
  await t.test('shared package inherits a hold and missing index roots remain visible',async()=>{
    let page=await s.entries(runId,'',25),all=[...page.items];while(page.next){page=await s.entries(runId,page.next,25);all.push(...page.items);}
    assert.equal(all.length,107);const shared=all.filter(x=>x.cid===pkg.cid);assert.equal(shared.length,2);assert.ok(shared.every(x=>x.held&&x.classification==='held'&&x.packageReferences==='2'));
    assert.ok(all.filter(x=>x.cid!==pkg.cid).every(x=>x.classification==='unresolved'&&x.eligibleForDeletion===false));
    const roots=(await s.roots(runId)).items;assert.equal(roots.find(x=>x.id==='c-missing').indexObserved,false);assert.equal(roots.find(x=>x.id==='hold-00').activeHolds,1);
    await assert.rejects(s.entries(runId,'bad'),{status:400});await assert.rejects(s.roots(runId,'',101),{status:400});
  });
  const observation=hlsObservation(hlsSourceKey(source('a-video')),JSON.stringify(pkg)),epoch='a'.repeat(40);
  await t.test('duplicate observations are not counted twice; changed values and cursor loops cannot advance',async()=>{
    const id=randomUUID();await indexPhase(id);const fake=page=>service({page:async()=>page});
    await fake({epoch,next:'1',items:[observation]}).step(id);await fake({epoch,next:'2',items:[observation]}).step(id);assert.equal((await s.status(id)).entries,'1');
    await assert.rejects(fake({epoch,next:'1',items:[]}).step(id),{status:409});
    await assert.rejects(fake({epoch,next:'3',items:[{...observation,hash:'f'.repeat(64)}]}).step(id),{status:409});
    await assert.rejects(fake({epoch:'b'.repeat(40),next:'0',items:[]}).step(id),{status:409});assert.equal((await s.status(id)).cursor,'2');
  });
  await t.test('rollback, lost acknowledgement, cancellation and racing scans preserve one checkpoint',async()=>{
    const id=randomUUID();await indexPhase(id);const index={page:async()=>({epoch,next:'1',items:[observation]})};
    const rollback={query:(...p)=>db.query(...p),transaction:fn=>db.transaction(async tx=>{await fn(tx);throw new Error('rollback');})};
    await assert.rejects(service(index,rollback).step(id),/rollback/);assert.equal((await s.status(id)).entries,'0');
    const cancelled=new AbortController();const aborting={page:async()=>{cancelled.abort();return {epoch,next:'1',items:[observation]};}};
    await assert.rejects(service(aborting).step(id,cancelled.signal));assert.equal((await s.status(id)).pages,'0');
    let count=0,release;const gate=new Promise(resolve=>release=resolve);const racing={page:async()=>{if(++count===2)release();await gate;return index.page();}};
    const attempts=await Promise.allSettled([service(racing).step(id),service(racing).step(id)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.find(x=>x.status==='rejected').reason.status,409);
    const lost={query:(...p)=>db.query(...p),transaction:async fn=>{await db.transaction(fn);throw new Error('lost ack');}};
    await assert.rejects(service({page:async()=>({epoch,next:'0',items:[observation]})},lost).step(id),/lost ack/);assert.equal((await s.status(id)).indexTraversalComplete,true);assert.equal((await s.status(id)).entries,'1');
  });
  await t.test('oversized, expiring and malformed indexes stop reading; cancelled readers do not reconnect',async()=>{
    const badKey=key('e'.repeat(64));
    for(const [value,ttl] of [['x'.repeat(32769),false],['{}',false],[JSON.stringify(pkg),true]]){
      await control.set(badKey,value);if(ttl)await control.pexpire(badKey,60000);const r=reader();let cursor='0',failed=false;
      do{try{const p=await r.page(cursor);cursor=p.next;}catch(error){assert.equal(error.status,503);failed=true;break;}}while(cursor!=='0');
      assert.equal(failed,true);await assert.rejects(r.page('0'),{status:503});await control.del(badKey);
    }
    const r=reader(),abort=new AbortController();abort.abort();await assert.rejects(r.page('0',abort.signal));r.onModuleDestroy();await assert.rejects(r.page('0'),{status:503});
    await assert.rejects(reader().page('18446744073709551616'),/Invalid HLS inventory cursor/);
  });
  await t.test('aggregate response budget and cancellation bound a stalled Redis read',async()=>{
    const keys=await control.keys(`${namespace}:prepared:*`),originals=await control.mget(...keys);
    try {
      const oversizedPage=JSON.stringify({...pkg,padding:'x'.repeat(30000)});
      for(const k of keys)await control.set(k,oversizedPage);
      const r=reader();let cursor='0',failed=false;
      do{try{const p=await r.page(cursor);cursor=p.next;}catch(error){assert.equal(error.status,503);failed=true;break;}}while(cursor!=='0');
      assert.equal(failed,true,'the script must bound the total response, not just each value');
    } finally {for(let i=0;i<keys.length;i++)await control.set(keys[i],originals[i]);}
    const r=reader();await r.page('0');await control.call('CLIENT','PAUSE',3000,'ALL');
    const abort=new AbortController(),started=Date.now(),timer=setTimeout(()=>abort.abort(),100);
    try{await assert.rejects(r.page('0',abort.signal),{status:503});assert.ok(Date.now()-started<1500);await assert.rejects(r.page('0'),{status:503});}
    finally{clearTimeout(timer);await control.ping();}
  });
  await t.test('compiled Nest CLI resumes with scoped credentials and rejects unsupported environments',async()=>{
    for(const change of [{AE_NETWORK_ID:'ae_mainnet'},{ENABLE_SHORTS:'false'},{NODE_ENV:'production'},{SHORTS_OPERATOR_KEY_FILE:'/secret'},
      {SHORTS_PRIVATE_S3_CREDENTIALS_FILE:'/secret'},{SHORTS_HLS_REDIS_URL:redisUrl.href},{SHORTS_HLS_NAMESPACE:'bad:*'}])await assert.rejects(hlsInventoryConfig({...env,...change}));
    const path=join(dir,'request.json');const cli=async(action,input)=>{await writeFile(path,JSON.stringify(input));const r=await promisify(execFile)(process.execPath,['dist/shorts/hls-inventory-main.js',action,path],{env,timeout:15000});assert.equal(r.stderr,'');return JSON.parse(r.stdout);};
    const id=randomUUID();assert.equal((await cli('start',{id})).roots,'0');assert.equal((await cli('scan',{id,pages:1})).roots,'25');
    let result;do{result=await cli('scan',{id});}while(!result.indexTraversalComplete);
    assert.equal((await cli('status',{id})).entries,'107');assert.equal((await cli('entries',{id,limit:1})).items.length,1);assert.equal((await cli('roots',{id,limit:1})).items.length,1);
    await assert.rejects(cli('scan',{id,pages:101}));await assert.rejects(cli('entries',{id,delete:true}));
  });
});
