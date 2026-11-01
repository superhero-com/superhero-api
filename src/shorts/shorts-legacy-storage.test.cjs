const { releaseFixture } = require('./shorts-release.fixture.cjs');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash, createCipheriv } = require('node:crypto');
const { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { DatabaseSync } = require('node:sqlite');
const { DataSource } = require('typeorm');
const { AccountMemory, encode, Encoding } = require('@aeternity/aepp-sdk');
const { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const { Test } = require('@nestjs/testing');
process.env.DOTENV_CONFIG_PATH='/dev/null';
const { ShortsLegacyStorageModule } = require('./shorts-legacy-storage.module');
const { ShortsLegacyStorageService, SHORTS_LEGACY_STORAGE_CONFIG, legacyStorageConfig } = require('./shorts-legacy-storage.service');
const { ShortsStoreService } = require('./shorts-store.service');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsLegacyImportsService } = require('./shorts-legacy-imports.service');
const { ShortsSourceService } = require('./shorts-source.service');
const { ShortsPrivateMediaService } = require('./shorts-private-media.service');
const { ShortsUploadRecordsService } = require('./shorts-upload-records.service');
const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
const { SHORTS_PRIVATE_OBJECT_CONFIG } = require('./shorts-private-objects.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { legacyUploads } = require('./shorts-legacy-snapshot');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsLegacyStorage1791763205000 } = require('../migrations/1791763205000-ShortsLegacyStorage');
const { ShortsAnalytics1791763207000 } = require('../migrations/1791763207000-ShortsAnalytics');
const { ShortsReceipts1791763208000 } = require('../migrations/1791763208000-ShortsReceipts');
const { ShortsSharedCutover1791763214000 } = require('../migrations/1791763214000-ShortsSharedCutover');
const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
const PART=1048576;

test('offline legacy storage migration preserves media, sessions, decisions and admission history', {
  skip: !process.env.SHORTS_TEST_PG_URL || !process.env.SHORTS_TEST_S3_ENDPOINT, timeout: 120000,
}, async t => {
  const url=new URL(process.env.SHORTS_TEST_PG_URL), endpoint=new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(endpoint.hostname,'127.0.0.1');
  const schema=`shorts_legacy_${randomUUID().replaceAll('-','')}`;
  const admin=new DataSource({type:'postgres',url:url.href});await admin.initialize();await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new DataSource({type:'postgres',url:url.href,schema,extra:{options:`-c search_path=${schema}`},
    migrations:[ShortsMetadata1791763200000,ShortsUploads1791763202000,ShortsLegacyStorage1791763205000,ShortsAnalytics1791763207000,ShortsReceipts1791763208000,ShortsSharedCutover1791763214000, ShortsUploadBudget1791763224000]});await db.initialize();await db.runMigrations({transaction:'all'});
  const credentials={accessKeyId:process.env.SHORTS_TEST_S3_ACCESS_KEY,secretAccessKey:process.env.SHORTS_TEST_S3_SECRET_KEY};
  const raw=new S3Client({endpoint:endpoint.origin,region:'us-east-1',forcePathStyle:true,credentials});
  const bucket=`shorts-legacy-${randomUUID()}`;await raw.send(new CreateBucketCommand({Bucket:bucket}));
  const key=randomBytes(32),fixtures=[];
  t.after(async()=>{
    for(const f of fixtures){await f.app.close();if(!f.closed)f.sqlite.close();await rm(f.dir,{recursive:true,force:true});}
    if(db.isInitialized)await db.destroy();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.destroy();
    const objects=await raw.send(new ListObjectsV2Command({Bucket:bucket}));
    if(objects.Contents?.length)await raw.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:objects.Contents.map(o=>({Key:o.Key}))}}));
    await raw.send(new DeleteBucketCommand({Bucket:bucket}));raw.destroy();
  });
  async function fixture(){
    const dir=await mkdtemp(join(tmpdir(),'shorts-legacy-'));await mkdir(join(dir,'private'),{mode:0o700});
    await writeFile(join(dir,'quarantine.key'),key,{mode:0o600});
    const sqlite=new DatabaseSync(join(dir,'shorts.sqlite'));sqlite.exec(`
      PRAGMA journal_mode=WAL; CREATE TABLE state(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE shorts_uploads(id TEXT PRIMARY KEY,actor TEXT,created INTEGER,body TEXT);
      CREATE TABLE shorts_ingest_jobs(id TEXT PRIMARY KEY,actor TEXT,status TEXT,attempts INTEGER,created INTEGER,updated INTEGER,error TEXT);
      CREATE TABLE shorts_upload_attempts(id TEXT PRIMARY KEY,actor TEXT,created INTEGER,bytes INTEGER,prepared INTEGER);`);
    const scope={network:'ae_uat',contract:releaseFixture().release.contract},sourceHash=hash('fixture-contract'),actor=AccountMemory.generate().address,now=Date.now();
    const encrypt=async(id,name,data)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(data),cipher.final()]);await writeFile(join(dir,'private',`${id}-${name}.enc`),Buffer.concat([iv,cipher.getAuthTag(),bytes]),{mode:0o600});};
    const original=Buffer.from('owned original byte fixture');
    // Migration verifies and copies bytes; decoding/model quality is tested elsewhere.
    const files=[{name:'video.mp4',data:Buffer.from('owned prepared byte fixture')},{name:'poster.jpg',data:Buffer.from('owned poster')},{name:'manifest.json',data:Buffer.from('{"fixture":true}')}];
    const id=randomUUID();for(const file of files)await encrypt(id,file.name,file.data);await encrypt(id,'original',original);
    const record={id,creator:actor,title:'Existing Short',topic:'Art',createdAt:now-10000,bytes:files.reduce((n,f)=>n+f.data.length,0),duration:3,
      cid:await new ShortsPackageService().cid(files),files:files.map(f=>({name:f.name,bytes:f.data.length,sha256:hash(f.data)})),
      moderation:'approved',publication:'published',safety:{status:'no_flags',sourceSha256:hash(original)},views:[],reports:0};
    const receipt={actor,action:'wallet_transaction',tx:encode(randomBytes(32),Encoding.TxHash),at:now-1000};
    const state={contract:scope.contract,sourceHash,shorts:[record],receipts:[receipt]};sqlite.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(state));
    sqlite.exec(`CREATE TABLE shorts_analytics_settings(id INTEGER PRIMARY KEY,salt TEXT,since INTEGER);
      CREATE TABLE shorts_plays(id TEXT PRIMARY KEY,short_id TEXT,viewer TEXT,started INTEGER,seconds REAL,source TEXT,duration REAL);
      CREATE TABLE shorts_view_totals(short_id TEXT PRIMARY KEY,views INTEGER);
      CREATE TABLE shorts_forgotten_viewers(viewer TEXT PRIMARY KEY,expires INTEGER);`);
    const salt='a'.repeat(64), viewer='b'.repeat(64), forgotten='c'.repeat(64);
    sqlite.prepare('INSERT INTO shorts_analytics_settings VALUES(1,?,?)').run(salt,now-10000);
    sqlite.prepare('INSERT INTO shorts_plays VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,viewer,now-4000,3,'for-you',3);
    sqlite.prepare('INSERT INTO shorts_view_totals VALUES(?,?)').run(id,5);
    sqlite.prepare('INSERT INTO shorts_forgotten_viewers VALUES(?,?)').run(forgotten,now+100000);
    function session(sessionId,data,status,attempts,created=now){
      const upload={id:sessionId,actor,created,title:'Existing Short',topic:'Art',rights:true,bytes:data.length,sha256:hash(data),details:{language:'en'},
        parts:status==='partial'?[0]:Array.from({length:Math.ceil(data.length/PART)},(_,i)=>i),complete:status==='ready'};
      sqlite.prepare('INSERT INTO shorts_uploads VALUES(?,?,?,?)').run(upload.id,actor,created,JSON.stringify(upload));
      if(status!=='partial')sqlite.prepare('INSERT INTO shorts_ingest_jobs VALUES(?,?,?,?,?,?,NULL)').run(upload.id,actor,status,attempts,created,created);
      sqlite.prepare('INSERT INTO shorts_upload_attempts VALUES(?,?,?,?,?)').run(upload.id,actor,created,data.length,Number(status!=='partial'));
      return upload;
    }
    session(id,original,'ready',1);
    const source=Buffer.alloc(PART+17,42),queued=session(randomUUID(),source,'processing',1,now-2*86400000),failed=session(randomUUID(),source,'failed',3);
    const partial=session(randomUUID(),source,'partial',0);
    for(const upload of [queued,failed,partial])for(const index of upload.parts)await encrypt(upload.id,`part-${index}`,source.subarray(index*PART,(index+1)*PART));
    // Three recent session reservations plus seven additional failures = ten.
    for(let i=0;i<7;i++)sqlite.prepare('INSERT INTO shorts_upload_attempts VALUES(?,?,?,?,1)').run(randomUUID(),actor,now,original.length);
    const store={db:sqlite,load:()=>JSON.parse(sqlite.prepare('SELECT body FROM state WHERE id=1').get().body)};
    const config={directory:dir,scope,sourceHash};
    const app=await Test.createTestingModule({imports:[ShortsLegacyStorageModule]}).overrideProvider(DataSource).useValue(db)
      .overrideProvider(ShortsStoreService).useValue(store).overrideProvider(SHORTS_LEGACY_STORAGE_CONFIG).useValue(config)
      .overrideProvider(SHORTS_PRIVATE_OBJECT_CONFIG).useValue({endpoint:endpoint.origin,region:'us-east-1',bucket,prefix:'shorts-private-v1',forcePathStyle:true,
        credentials,activeKeyId:'key1',keys:{key1:randomBytes(32)}}).setLogger(false).compile();await app.init();
    const metadata=app.get(ShortsMetadataService),imports=app.get(ShortsLegacyImportsService),uploads=app.get(ShortsUploadRecordsService),sourceService=app.get(ShortsSourceService);
    const adapter=new ShortsHostedUploadsService({shared:true,chain:{release: releaseFixture({...scope,sourceHash}).release,state:{contract:scope.contract,sourceHash}},get:async id=>(await metadata.get(scope,id)).record},metadata,uploads,sourceService,store,imports);
    const result={dir,sqlite,scope,sourceHash,actor,record,original,files,source,queued,failed,partial,store,app,metadata,imports,uploads,sourceService,adapter,
      service:app.get(ShortsLegacyStorageService),encrypt,receipt,salt,forgotten};fixtures.push(result);return result;
  }
  const f=await fixture();
  await t.test('preflight reads the original encryption key and validates bytes without changing shared state',async()=>{
    const result=await f.service.run();assert.equal(result.mode,'checked');assert.equal(result.videos,1);assert.equal(result.uploads,4);
    assert.deepEqual(await db.query('SELECT * FROM shorts_runtime'),[]);
    assert.equal((await raw.send(new ListObjectsV2Command({Bucket:bucket}))).KeyCount,0);
    await writeFile(join(f.dir,'deployment.json'),JSON.stringify(releaseFixture({...f.scope,sourceHash:f.sourceHash}).release));
    const env={ENABLE_SHORTS:'true',AE_NETWORK_ID:'ae_uat',SHORTS_TESTNET_MVP:'1',SHORTS_DATA_DIR:f.dir,SHORTS_DEPLOYMENT_FILE:join(f.dir,'deployment.json')};
    assert.equal((await legacyStorageConfig(env)).directory,await realpath(f.dir));
    await assert.rejects(legacyStorageConfig({...env,SHORTS_DATA_DIR:'/a-missing-legacy-store'}));
  });
  await t.test('an interruption after S3 copying leaves no false checkpoint and retry preserves newer moderation',async()=>{
    const attach=f.imports.content.bind(f.imports);f.imports.content=async()=>{throw new Error('injected interruption after verified copies');};
    await assert.rejects(f.service.run(true),/injected interruption/);f.imports.content=attach;
    assert.equal((await f.metadata.get(f.scope,f.record.id)).record.privateMedia,undefined);
    await assert.rejects(f.adapter.initialize(),/Complete the offline/);
    await f.metadata.change(f.scope,f.record.id,r=>{r.moderation='rejected';r.reports=5;r.reviewReason='Newer decision';});
    const result=await f.service.run(true);assert.equal(result.mode,'applied');
    const current=(await f.metadata.get(f.scope,f.record.id)).record;
    assert.equal(current.moderation,'rejected');assert.equal(current.reports,5);assert.equal(current.reviewReason,'Newer decision');assert.equal(current.publication,'published');
    assert.equal(current.privateMedia.fence,'0');assert.equal(current.cid,f.record.cid);
    const privateMedia=f.app.get(ShortsPrivateMediaService);
    assert.deepEqual(await privateMedia.original(f.scope,current),f.original);
    for(const file of f.files)assert.deepEqual(await privateMedia.file(f.scope,current,file.name),file.data);
    assert.deepEqual(f.store.load().shorts[0],f.record);
    await f.adapter.initialize();
    const [settings]=await db.query('SELECT salt,legacy_hash FROM shorts_measurement_settings WHERE contract=$1',[f.scope.contract]);
    assert.equal(settings.salt,f.salt); assert.ok(settings.legacy_hash);
    assert.equal(Number((await db.query('SELECT views FROM shorts_measurement_totals WHERE contract=$1',[f.scope.contract]))[0].views),5);
    assert.equal((await db.query('SELECT viewer FROM shorts_measurement_viewers WHERE contract=$1 AND forgotten_until>0',[f.scope.contract]))[0].viewer,f.forgotten);
    const [receipt]=await db.query('SELECT tx,verification FROM shorts_transaction_receipts WHERE contract=$1',[f.scope.contract]);
    assert.equal(receipt.tx,f.receipt.tx); assert.equal(receipt.verification,'legacy');
  });
  await t.test('saved partial, accepted, exhausted and ready uploads keep their identity and retry history',async()=>{
    const accepted=await f.metadata.getJob(f.scope,f.actor,f.queued.id);assert.equal(accepted.status,'queued');assert.equal(accepted.attempts,1);
    assert.ok((await f.uploads.get(f.scope,f.queued.id,f.actor)).expiresAt<Date.now());
    assert.deepEqual(await f.sourceService.read(f.scope,accepted),f.source);
    assert.equal((await f.metadata.claim(f.scope)).attempts,2);
    const failed=await f.metadata.getJob(f.scope,f.actor,f.failed.id);assert.equal(failed.status,'failed');assert.equal(failed.attempts,3);
    await assert.rejects(f.metadata.retry(f.scope,f.actor,f.failed.id),{status:409});
    const ready=await f.adapter.get(f.actor,f.record.id);assert.equal(ready.status,'ready');assert.equal(ready.video.id,f.record.id);
    assert.equal((await f.adapter.get(f.actor,f.partial.id)).status,'uploading');
    await f.adapter.part(f.actor,f.partial.id,1,f.source.subarray(PART));
    assert.equal((await f.adapter.finish(f.actor,f.partial.id)).status,'queued');
    await assert.rejects(f.adapter.get('ak_other',f.partial.id),{status:404});
    const sample={...f.partial};delete sample.id;delete sample.actor;delete sample.created;delete sample.parts;delete sample.complete;
    await assert.rejects(f.uploads.create(f.scope,randomUUID(),f.actor,sample),{status:429});
  });
  await t.test('repeated migration verifies the saved copies and does not duplicate counters or overwrite newer jobs',async()=>{
    const before=(await raw.send(new ListObjectsV2Command({Bucket:bucket}))).KeyCount;
    const job=await f.metadata.getJob(f.scope,f.actor,f.queued.id);
    const result=await f.service.run(true);assert.equal(result.processed,0);assert.equal(result.resumed,5);
    assert.deepEqual(await f.metadata.getJob(f.scope,f.actor,f.queued.id),job);
    assert.equal((await raw.send(new ListObjectsV2Command({Bucket:bucket}))).KeyCount,before);
    const [count]=await db.query('SELECT count(*)::int AS n FROM shorts_upload_admission WHERE contract=$1',[f.scope.contract]);assert.equal(count.n,11);
    const snapshots=legacyUploads(f.store),snapshot=snapshots.find(s=>s.upload.id===f.partial.id);
    f.sqlite.prepare('UPDATE shorts_uploads SET body=? WHERE id=?').run(JSON.stringify({...snapshot.upload,title:'Changed source'}),f.partial.id);
    await f.adapter.initialize(); // Hosted runtime never rereads an obsolete local snapshot.
    await assert.rejects(f.service.run(true),/snapshot changed/);
    f.sqlite.prepare('UPDATE shorts_uploads SET body=? WHERE id=?').run(JSON.stringify(snapshot.upload),f.partial.id);
  });
  await t.test('corrupt ciphertext, outside symlinks and mismatched deployment stop before attaching media',async()=>{
    const other=await fixture();const path=join(other.dir,'private',`${other.record.id}-video.mp4.enc`),bytes=await readFile(path);
    const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;await writeFile(path,corrupt);
    await assert.rejects(other.service.run(true));assert.equal((await other.metadata.get(other.scope,other.record.id)).record.privateMedia,undefined);
    await rm(path);await symlink(join(other.dir,'quarantine.key'),path);await assert.rejects(other.service.run());await rm(path);await writeFile(path,bytes,{mode:0o600});
    const state=other.store.load();state.contract='ct_wrong';other.sqlite.prepare('UPDATE state SET body=?').run(JSON.stringify(state));await assert.rejects(other.service.run(true),/do not match/);
  });
  await t.test('the compiled migration command uses its dedicated environment and closes cleanly',async()=>{
    const cli=await fixture(),storage=cli.app.get(SHORTS_PRIVATE_OBJECT_CONFIG);
    const deployment=join(cli.dir,'deployment.json'),creds=join(cli.dir,'s3.json'),ring=join(cli.dir,'keys.json');
    await writeFile(deployment,JSON.stringify(releaseFixture({...cli.scope,sourceHash:cli.sourceHash}).release));
    await writeFile(creds,JSON.stringify(credentials),{mode:0o600});
    await writeFile(ring,JSON.stringify({activeKeyId:'key1',keys:{key1:storage.keys.key1.toString('hex')}}),{mode:0o600});
    cli.sqlite.close();cli.closed=true;
    const env={...process.env,NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',ENABLE_SHORTS:'true',AE_NETWORK_ID:'ae_uat',SHORTS_TESTNET_MVP:'1',
      SHORTS_DEMO_AUTO_APPROVE:'0',SHORTS_DEMO_CONNECTED_WALLET:'0',SHORTS_DEPLOYMENT_FILE:deployment,SHORTS_DATA_DIR:cli.dir,
      DB_TYPE:'postgres',DB_HOST:url.hostname,DB_PORT:url.port,DB_USER:decodeURIComponent(url.username),DB_PASSWORD:decodeURIComponent(url.password),
      DB_DATABASE:url.pathname.slice(1),DB_SYNC:'false',PGOPTIONS:`-c search_path=${schema}`,
      SHORTS_PRIVATE_S3_ENDPOINT:endpoint.origin,SHORTS_PRIVATE_S3_REGION:'us-east-1',SHORTS_PRIVATE_S3_BUCKET:bucket,
      SHORTS_PRIVATE_S3_ALLOW_LOOPBACK:'1',SHORTS_PRIVATE_S3_CREDENTIALS_FILE:creds,SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE:ring};
    for(const name of ['SHORTS_OPERATOR_KEY_FILE','SHORTS_IPFS_TOKEN_FILE','SHORTS_STREAM_KEY_FILE'])delete env[name];
    for(const mode of ['--check','--apply']){
      const result=await execute(process.execPath,['dist/shorts/legacy-storage-main.js',mode],{cwd:process.cwd(),env,timeout:20000});
      assert.equal(JSON.parse(result.stdout.trim()).mode,mode==='--check'?'checked':'applied');
      assert.equal(result.stdout.includes(creds),false);
    }
    assert.ok((await cli.metadata.get(cli.scope,cli.record.id)).record.privateMedia);
  });
  await t.test('a downgrade refuses to discard admission history or completed migration checkpoints',async()=>{
    const rows=await db.query('SELECT network,contract,kind,id,fingerprint FROM shorts_storage_imports ORDER BY contract,kind,id');
    await assert.rejects(db.undoLastMigration({transaction:'all'}),/Preserve upload reservations/);
    await assert.rejects(db.transaction(manager => new ShortsSharedCutover1791763214000().down(manager)),/Preserve legacy cutover/);
    assert.deepEqual(await db.query('SELECT network,contract,kind,id,fingerprint FROM shorts_storage_imports ORDER BY contract,kind,id'),rows);
    await f.adapter.initialize();
  });

});
