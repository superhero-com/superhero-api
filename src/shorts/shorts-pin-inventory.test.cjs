const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createServer}=require('node:http');
const {mkdtemp,writeFile,chmod,symlink,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {DataSource}=require('typeorm');
const {ShortsMetadata1791763200000}=require('../migrations/1791763200000-ShortsMetadata');
const {ShortsUploads1791763202000}=require('../migrations/1791763202000-ShortsUploads');
const {ShortsRetentionHolds1791763216000}=require('../migrations/1791763216000-ShortsRetentionHolds');
const {ShortsHlsInventory1791763219000}=require('../migrations/1791763219000-ShortsHlsInventory');
const {ShortsPinInventory1791763220000}=require('../migrations/1791763220000-ShortsPinInventory');
const {ShortsDatabaseService}=require('./shorts-database.service');
const {ShortsRetentionService}=require('./shorts-retention.service');
const {ShortsPinInventoryService}=require('./shorts-pin-inventory.service');
const {ShortsPinReaderService}=require('./shorts-pin-reader.service');
const {pinInventoryConfig}=require('./shorts-pin-inventory.config');
const scope={network:'ae_uat',contract: releaseFixture().release.contract},sourceHash='a'.repeat(64),peerId='12D3KooW'+'a'.repeat(44),cid='b'+'a'.repeat(58);
const collect=async reader=>{const rows=[];for await(const page of reader.pins('recursive'))rows.push(...page);return rows;};

test('pin reader rejects corrupt, oversized, redirected and interrupted metadata without retries',async t=>{
  let mode='valid',requests=0,closed=0;const sockets=new Set();
  const line=JSON.stringify({Cid:cid,Type:'recursive'})+'\n';
  const server=createServer((req,res)=>{
    requests++;assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer '+'b'.repeat(64));
    if(mode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/secret'});res.end();return;}
    if(mode==='status'){res.writeHead(500);res.end('unavailable');return;}
    res.setHeader('Content-Type','application/json');
    if(mode==='stall'){req.on('close',()=>closed++);res.flushHeaders();return;}
    if(req.url.includes('/id')){res.end(JSON.stringify({ID:mode==='peer'?'wrong':peerId}));return;}
    if(req.url.includes('/repo/stat')){res.end(JSON.stringify({RepoSize:mode==='unsafe'?Number.MAX_SAFE_INTEGER+1:10,StorageMax:100}));return;}
    if(mode==='trailer'){res.setHeader('Trailer','X-Stream-Error');res.write(line);res.addTrailers({'X-Stream-Error':'incomplete'});res.end();return;}
    if(mode==='disconnect'){res.writeHead(200,{'Content-Length':99999});res.write(line);setImmediate(()=>res.destroy());return;}
    if(mode==='malformed'){res.end('{"Message":"failed","Code":0}\n');return;}
    if(mode==='large'){res.end('x'.repeat(513));return;}
    if(mode==='truncated'){res.end(line.trimEnd());return;}
    if(mode==='wrongtype'){res.end(JSON.stringify({Cid:cid,Type:'indirect'})+'\n');return;}
    if(mode==='count'){res.end(line.repeat(100001));return;}
    if(mode==='split'){res.write(line.slice(0,5));setImmediate(()=>res.end(line.slice(5)+line));return;}
    res.end(line.repeat(105));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const config={api:`http://127.0.0.1:${server.address().port}/api/v0`,token:'b'.repeat(64),peerId};
  const reader=()=>new ShortsPinReaderService(config);
  await t.test('valid framing, backpressure pages and exact capacity',async()=>{
    const sizes=[];for await(const page of reader().pins('recursive'))sizes.push(page.length);assert.deepEqual(sizes,[50,50,5]);
    assert.deepEqual(await reader().capacity(),{repoBytes:'10',storageMaxBytes:'100'});await reader().identity();
    mode='split';assert.equal((await collect(reader())).length,2);
  });
  await t.test('bad stream data never counts as a completed traversal',async()=>{
    for(mode of ['redirect','status','malformed','large','truncated','wrongtype','trailer','disconnect','count']){
      const before=requests;await assert.rejects(collect(reader()));assert.equal(requests,before+1,mode);
    }
    mode='unsafe';await assert.rejects(reader().capacity());mode='peer';await assert.rejects(reader().identity());
  });
  await t.test('cancellation and shutdown close stalled upstream connections',async()=>{
    mode='stall';let r=reader();const abort=new AbortController();let began=Date.now();const pending=r.identity(abort.signal);setTimeout(()=>abort.abort(),50);await assert.rejects(pending);assert.ok(Date.now()-began<1500);
    r=reader();began=Date.now();const running=collect(r);setTimeout(()=>r.onModuleDestroy(),50);await assert.rejects(running);assert.ok(Date.now()-began<1500);await assert.rejects(r.identity());
    await new Promise(resolve=>setTimeout(resolve,40));assert.ok(closed>=2);
  });
});

test('configuration requires isolated testnet, TLS, explicit node and owner-only non-symlink credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pin-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'key'),manifest=join(dir,'manifest');await writeFile(path,'b'.repeat(64),{mode:0o600});await writeFile(manifest,JSON.stringify(releaseFixture({...scope,sourceHash}).release));
  const env={ENABLE_SHORTS:'true',AE_NETWORK_ID:'ae_uat',SHORTS_DEPLOYMENT_FILE:manifest,SHORTS_PIN_API:'https://ipfs.internal/api/v0',SHORTS_PIN_TOKEN_FILE:path,SHORTS_PIN_PEER_ID:peerId};
  const good=await pinInventoryConfig(env);assert.equal(good.token,'b'.repeat(64));
  for(const patch of [{ENABLE_SHORTS:'false'},{AE_NETWORK_ID:'ae_mainnet'},{SHORTS_PIN_API:'http://ipfs.internal/api/v0'},
    {SHORTS_PIN_API:'https://user:secret@ipfs.internal/api/v0'},{SHORTS_PIN_API:'https://ipfs.internal/api/v0?x=1'},{SHORTS_PIN_PEER_ID:''},
    {SHORTS_IPFS_TOKEN_FILE:path},{SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE:path},{SHORTS_OPERATOR_KEY_FILE:path}])await assert.rejects(pinInventoryConfig({...env,...patch}));
  await chmod(path,0o644);await assert.rejects(pinInventoryConfig(env));await chmod(path,0o600);
  const link=join(dir,'link');await symlink(path,link);await assert.rejects(pinInventoryConfig({...env,SHORTS_PIN_TOKEN_FILE:link}));
  assert.equal((await pinInventoryConfig({...env,SHORTS_PIN_ALLOW_LOOPBACK:'1',SHORTS_PIN_API:'http://127.0.0.1:1/api/v0'})).api,'http://127.0.0.1:1/api/v0');
  await assert.rejects(pinInventoryConfig({...env,NODE_ENV:'production',SHORTS_PIN_ALLOW_LOOPBACK:'1',SHORTS_PIN_API:'http://127.0.0.1:1/api/v0'}));
});

test('real Kubo and restricted PostgreSQL retain partial scans and reconcile original/HLS pins',{
 skip:!process.env.SHORTS_TEST_PG_URL||!process.env.SHORTS_TEST_KUBO_API,timeout:120000,
},async t=>{
  const pg=new URL(process.env.SHORTS_TEST_PG_URL),api=new URL(process.env.SHORTS_TEST_KUBO_API);assert.equal(pg.hostname,'127.0.0.1');assert.equal(api.hostname,'127.0.0.1');
  const rpc=async(path,body)=>{const response=await fetch(api.href+'/'+path,{method:'POST',body,signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);return response.text();};
  const peer=JSON.parse(await rpc('id')).ID,created=[];
  const add=async(recursive=true)=>{const body=new FormData();body.append('file',new Blob([randomUUID()]),'clip.txt');const item=JSON.parse((await rpc('add?pin='+recursive+'&cid-version=1',body)).trim());created.push(item.Hash);return item.Hash;};
  const sourceCid=await add(),hlsCid=await add(),directCid=await add(false),unknownCid=await add();
  await rpc('pin/add?recursive=false&arg='+directCid);
  for(let i=0;i<102;i++)await add();
  const schema='pins_'+randomUUID().replaceAll('-',''),role='pinrole_'+randomUUID().replaceAll('-',''),password=randomUUID(),hlsRun=randomUUID();
  const dir=await mkdtemp(join(tmpdir(),'pin-inventory-')),manifest=join(dir,'manifest'),key=join(dir,'key');await writeFile(manifest,JSON.stringify(releaseFixture({...scope,sourceHash}).release));await writeFile(key,'b'.repeat(64),{mode:0o600});
  const env={PATH:process.env.PATH,NODE_ENV:'test',ENABLE_SHORTS:'true',AE_NETWORK_ID:'ae_uat',SHORTS_DEPLOYMENT_FILE:manifest,
    SHORTS_PIN_API:api.href,SHORTS_PIN_TOKEN_FILE:key,SHORTS_PIN_PEER_ID:peer,SHORTS_PIN_ALLOW_LOOPBACK:'1',SHORTS_DB_CONCURRENCY:'1',
    DB_HOST:pg.hostname,DB_PORT:pg.port,DB_DATABASE:pg.pathname.slice(1),DB_USER:role,DB_PASSWORD:password,PGOPTIONS:`-c search_path=${schema}`};
  const config=await pinInventoryConfig(env),admin=new DataSource({type:'postgres',url:pg.href});await admin.initialize();let owner,db,roleCreated=false;
  t.after(async()=>{if(db?.isInitialized)await db.onModuleDestroy();if(owner?.isInitialized)await owner.destroy();if(roleCreated)await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.destroy();for(const pin of created)await rpc('pin/rm?arg='+pin);await rm(dir,{recursive:true,force:true});});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options={type:'postgres',url:pg.href,schema,extra:{options:`-c search_path=${schema}`,max:2},migrations:[ShortsMetadata1791763200000,ShortsUploads1791763202000,ShortsRetentionHolds1791763216000,ShortsHlsInventory1791763219000,ShortsPinInventory1791763220000]};
  owner=new DataSource(options);await owner.initialize();await owner.runMigrations({transaction:'all'});await owner.undoLastMigration({transaction:'all'});await owner.runMigrations({transaction:'all'});
  const args=[scope.network,scope.contract];await owner.query(`INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)`,[...args,sourceHash]);
  await owner.query(`INSERT INTO shorts_hls_inventory_runs(network,contract,id,source_hash,storage_id,namespace,phase) VALUES($1,$2,$3,$4,$4,'test','complete')`,[...args,hlsRun,sourceHash]);
  for(const [resource,cid,sourceKey,holds] of [['video-1',sourceCid,'b'.repeat(64),1],['video-2',directCid,'c'.repeat(64),0],['missing','b'+'c'.repeat(58),'d'.repeat(64),0]]){
    await owner.query(`INSERT INTO shorts_hls_inventory_roots(network,contract,run_id,resource_id,source_cid,source_key,active_holds,reasons) VALUES($1,$2,$3,$4,$5,$6,$7,'[]')`,[...args,hlsRun,resource,cid,sourceKey,holds]);
  }
  for(const key of ['b'.repeat(64),'c'.repeat(64)])await owner.query(`INSERT INTO shorts_hls_inventory_entries(network,contract,run_id,source_key,cid,metadata_hash,bytes,files) VALUES($1,$2,$3,$4,$5,$4,100,'[{},{},{}]')`,[...args,hlsRun,key,hlsCid]);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON ${['shorts_runtime','shorts_content','shorts_ingestion','shorts_upload_sessions','shorts_upload_parts','shorts_retention_holds','shorts_hls_inventory_runs','shorts_hls_inventory_roots','shorts_hls_inventory_entries'].map(x=>`${schema}.${x}`).join(',')} TO ${role};
    GRANT SELECT,INSERT,UPDATE ON ${schema}.shorts_pin_inventory_runs TO ${role};GRANT SELECT,INSERT ON ${schema}.shorts_pin_inventory_entries TO ${role}`);
  const login=new URL(pg);login.username=role;login.password=password;db=new ShortsDatabaseService(new DataSource({...options,url:login.href,migrations:[]}));await db.onModuleInit();
  const records=new ShortsRetentionService(db,config),reader=new ShortsPinReaderService(config);
  const service=(r=reader,database=db,settings=config)=>new ShortsPinInventoryService(database,settings,records,r),s=service();await s.verify();
  const inert={identity:async()=>peer,capacity:async()=>({repoBytes:'10',storageMaxBytes:'100'}),async *pins(type){if(type==='recursive')yield [{cid:sourceCid,type}];}};
  await t.test('read-only grants reject destructive, filtered and column-level permissions',async()=>{
    for(const [table,grant] of [['shorts_pin_inventory_entries','UPDATE(cid)'],['shorts_hls_inventory_runs','UPDATE(phase)'],['shorts_pin_inventory_runs','DELETE'],['shorts_retention_holds','UPDATE']]){await owner.query(`GRANT ${grant} ON ${table} TO ${role}`);await assert.rejects(s.verify());await owner.query(`REVOKE ${grant} ON ${table} FROM ${role}`);}
    await owner.query('ALTER TABLE shorts_pin_inventory_entries ENABLE ROW LEVEL SECURITY');await assert.rejects(s.verify());await owner.query('ALTER TABLE shorts_pin_inventory_entries DISABLE ROW LEVEL SECURITY');await s.verify();
    await assert.rejects(db.query('DELETE FROM shorts_pin_inventory_entries'));
  });
  const run=randomUUID();
  await t.test('real stream completion, capacity, shared holds and missing recursive roots',async()=>{
    const result=await s.scan(run,hlsRun);assert.equal(result.pinTraversalComplete,true);assert.ok(Number(result.pins)>=106);assert.ok(Number(result.batches)>=4);assert.ok(BigInt(result.capacityAfter.repoBytes)>0n);
    assert.equal(result.consistentSnapshot,false);assert.equal(result.deletionEnabled,false);assert.equal(result.blocksVerified,false);
    const rows=[];let page;do{page=await s.entries(run,page?.next||'',25);rows.push(...page.items);}while(page.next);
    assert.equal(rows.find(x=>x.cid===sourceCid).classification,'held');assert.equal(rows.find(x=>x.cid===hlsCid).classification,'held');assert.equal(rows.find(x=>x.cid===hlsCid).packageReferences,'2');
    assert.equal(rows.find(x=>x.cid===unknownCid).classification,'unresolved');assert.ok(rows.every(x=>x.eligibleForDeletion===false));
    const missing=(await s.missing(run)).items;assert.equal(missing.length,2);assert.equal(missing.find(x=>x.cid===directCid).directOnly,true);
    assert.equal((await service({identity(){throw Error('must not read');}}).scan(run,hlsRun)).pinTraversalComplete,true);
    await assert.rejects(service(inert,db,{...config,storageId:'f'.repeat(64)}).status(run),{status:409});
    await assert.rejects(s.entries(run,'bad'),{status:400});await assert.rejects(s.entries(run,'',101),{status:400});await assert.rejects(s.scan(randomUUID(),randomUUID()),{status:409});
    await assert.rejects(owner.undoLastMigration({transaction:'all'}),/Preserve IPFS inventory history/);
    await rpc('pin/rm?arg='+directCid);
    let directPins=0;for await(const page of reader.pins('direct'))directPins+=page.length;
    assert.equal(directPins,0);await rpc('pin/add?recursive=false&arg='+directCid);
  });
  await t.test('mid-stream failure preserves partial evidence and cannot resume or claim completeness',async()=>{
    const id=randomUUID(),bad={...inert,async *pins(type){if(type==='recursive'){yield [{cid:sourceCid,type}];throw Error('connection dropped');}}};
    await assert.rejects(service(bad).scan(id,hlsRun),/connection dropped/);const result=await s.status(id);assert.equal(result.pins,'1');assert.equal(result.pinTraversalComplete,false);assert.equal(result.capacityAfter,null);
    assert.equal((await service(inert).scan(id,hlsRun)).pinTraversalComplete,false);await assert.rejects(s.entries(id),{status:409});await assert.rejects(s.missing(id),{status:409});
  });
  await t.test('duplicate pins, concurrent invocations and lost completion acknowledgement retain exact state',async()=>{
    const id=randomUUID();const repeated={...inert,async *pins(type){if(type==='recursive'){yield [{cid:sourceCid,type},{cid:sourceCid,type}];yield [{cid:sourceCid,type}];}}};
    const outcomes=await Promise.all([service(repeated).scan(id,hlsRun),service(repeated).scan(id,hlsRun)]);assert.ok(outcomes.some(x=>x.pinTraversalComplete));assert.equal((await s.status(id)).pins,'1');
    const lostId=randomUUID();const lost={query:(...p)=>db.query(...p),transaction:async fn=>{const r=await db.transaction(fn);const status=await db.query('SELECT phase FROM shorts_pin_inventory_runs WHERE id=$1',[lostId]);if(status[0]?.phase==='complete')throw Error('lost ack');return r;}};
    await assert.rejects(service(inert,lost).scan(lostId,hlsRun),/lost ack/);assert.equal((await s.status(lostId)).pinTraversalComplete,true);
  });
  await t.test('SQL rollback, cancellation and changed node prevent completion',async()=>{
    const id=randomUUID();
    const rollback={query:(...p)=>db.query(...p),transaction:fn=>db.transaction(async tx=>{const result=await fn(tx);const status=await tx.query('SELECT pins FROM shorts_pin_inventory_runs WHERE id=$1',[id]);if(status[0]?.pins==='1')throw Error('rollback');return result;})};
    await assert.rejects(service(inert,rollback).scan(id,hlsRun),/rollback/);const unchanged=await s.status(id);assert.equal(unchanged.pins,'0');assert.equal(unchanged.batches,'0');assert.equal(unchanged.pinTraversalComplete,false);
    const abort=new AbortController(),cancel={...inert,async *pins(type){if(type==='recursive'){yield [{cid:sourceCid,type}];abort.abort();}}};
    const cancelId=randomUUID();await assert.rejects(service(cancel).scan(cancelId,hlsRun,abort.signal));assert.equal((await s.status(cancelId)).pinTraversalComplete,false);
    let calls=0;const changed={...inert,identity:async()=>{if(++calls===2)throw Error('node changed');return peer;}};const changedId=randomUUID();await assert.rejects(service(changed).scan(changedId,hlsRun),/node changed/);assert.equal((await s.status(changedId)).pinTraversalComplete,false);
  });
  await t.test('compiled isolated CLI uses dedicated role and outputs saved status without media credentials',async()=>{
    const request=join(dir,'request');await writeFile(request,JSON.stringify({id:run}));
    const result=await promisify(execFile)(process.execPath,['dist/shorts/pin-inventory-main','status',request],{env,timeout:30000});assert.equal(JSON.parse(result.stdout).pinTraversalComplete,true);assert.equal(result.stderr,'');
    const cliRun=randomUUID();await writeFile(request,JSON.stringify({id:cliRun,hlsRun}));
    const scanned=await promisify(execFile)(process.execPath,['dist/shorts/pin-inventory-main','scan',request],{env,timeout:30000});assert.equal(JSON.parse(scanned.stdout).pinTraversalComplete,true);assert.equal(scanned.stderr,'');
  });
});
