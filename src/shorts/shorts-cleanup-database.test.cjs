require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, chmod, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsCleanupDatabaseService, shortsCleanupCredentials } = require('./shorts-cleanup-database.service');
const { ShortsDatabaseService } = require('./shorts-database.service');
const { ShortsPublicationBoundaryService } = require('./shorts-publication-boundary.service');
const { ShortsPrivateInputRetirementsService } = require('./shorts-private-input-retirements.service');
const { ShortsPrivateReferenceBarriersService } = require('./shorts-private-reference-barriers.service');
const { ShortsPrivateInputCleanupJournalService } = require('./shorts-private-input-cleanup-journal.service');

const flags = ['SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED','SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED',
  'SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED','SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED','SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE'];
const proof = {direct:true,restricted:true,no_ddl:true,no_publication:true,no_destructive:true,no_source_writes:true,scoped_helpers:true};
function environment(t, values = {}) {
  const old = Object.fromEntries(flags.map(k => [k, process.env[k]]));
  for (const key of flags) delete process.env[key]; Object.assign(process.env, values);
  t.after(() => { for (const key of flags) { if(old[key]===undefined) delete process.env[key]; else process.env[key]=old[key]; } });
}
async function credential(t, value = {username:'cleanup_control',password:'c'.repeat(64)}) {
  const dir=await mkdtemp(join(tmpdir(),'shorts-cleanup-db-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'control.json');await writeFile(path,JSON.stringify(value),{mode:0o600});return path;
}
function primary() {
  const calls=[];
  return {options:{type:'postgres',host:'127.0.0.1',port:5432,username:'publication_api',password:'p'.repeat(64),database:'test'},
    calls,query:async(...args)=>{calls.push(['query',...args]);return 'primary';},
    transaction:async(...args)=>{calls.push(['transaction',...args]);return 'primary-transaction';},
    onModuleDestroy:async()=>assert.fail('cleanup must never destroy the publication pool')};
}

test('disabled cleanup and isolated deletion contexts retain the existing database without another pool', async t=>{
  environment(t,{SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED:'true'});
  const source=primary(), db=new ShortsCleanupDatabaseService(source);
  db.createPool=()=>assert.fail('no control credentials or pool in deletion context');
  await db.onModuleInit();assert.equal(await db.query('SELECT 1'),'primary');
  assert.equal(await db.transaction('READ COMMITTED',async()=>{}),'primary-transaction');
  await db.onModuleDestroy();assert.throws(()=>db.query('SELECT 1'),{status:503});
});

test('enabled control requires a distinct private credential and cannot share deletion authority', async t=>{
  const path=await credential(t), env={SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:'true',SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE:path};
  assert.equal((await shortsCleanupCredentials('publication_api',env)).username,'cleanup_control');
  await assert.rejects(shortsCleanupCredentials('cleanup_control',env),/unavailable/);
  await assert.rejects(shortsCleanupCredentials('publication_api',{SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:'true'}),/separate/);
  await assert.rejects(shortsCleanupCredentials('publication_api',{...env,SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED:'true'}),/separate/);
  await assert.rejects(shortsCleanupCredentials('publication_api',{SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE:path}),/separate/);
  await assert.rejects(shortsCleanupCredentials('publication_api',{SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:'yes'}),/flag/);
});

test('credential loading rejects broad permissions, symlinks and malformed secret data without exposing contents', async t=>{
  const path=await credential(t), env={SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED:'true',SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE:path};
  await chmod(path,0o644);await assert.rejects(shortsCleanupCredentials('publication_api',env),/unavailable/);
  await chmod(path,0o600);const alias=path+'.link';await symlink(path,alias);
  await assert.rejects(shortsCleanupCredentials('publication_api',{...env,SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE:alias}),/unavailable/);
  await writeFile(path,'{"password":"private-sentinel", malformed');
  await assert.rejects(shortsCleanupCredentials('publication_api',env),e=>e.message==='Cleanup control credentials are unavailable'&&!String(e).includes('private-sentinel'));
});

test('cleanup pool inherits the endpoint, overrides only login and uses fixed one-connection bounds', async t=>{
  environment(t);const source=primary(), before=structuredClone(source.options), db=new ShortsCleanupDatabaseService(source);
  const pool=db.createPool({username:'cleanup_control',password:'c'.repeat(64)});
  assert.equal(pool.options.host,source.options.host);assert.equal(pool.options.database,source.options.database);
  assert.equal(pool.options.username,'cleanup_control');assert.equal(pool.options.password,'c'.repeat(64));
  assert.equal(pool.options.poolSize,1);assert.equal(pool.options.extra.max,1);
  assert.equal(pool.options.extra.connectionTimeoutMillis,1000);assert.equal(pool.options.extra.statement_timeout,15000);
  assert.equal(pool.limits.operationMs,25000);assert.deepEqual(source.options,before);
  await pool.onModuleDestroy();
});

test('control SQL goes only to its verified pool while publication remains on the baseline token', async t=>{
  const path=await credential(t);environment(t,{SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:'true',SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE:path});
  const source=primary(),db=new ShortsCleanupDatabaseService(source);let closed=0,queries=0;
  db.createPool=()=>({onModuleInit:async()=>{},onModuleDestroy:async()=>{closed++;},
    query:async()=>++queries===1?[proof]:'control',transaction:async()=> 'control-transaction'});
  await db.onModuleInit();assert.equal(await db.query('SELECT cleanup_snapshot'),'control');
  assert.equal(await db.transaction(async()=>{}),'control-transaction');assert.deepEqual(source.calls,[]);
  const token = type => Reflect.getMetadata('self:paramtypes',type).find(x=>x.index===0).param;
  assert.equal(token(ShortsPublicationBoundaryService),ShortsDatabaseService);
  for(const type of [ShortsPrivateInputRetirementsService,ShortsPrivateReferenceBarriersService,ShortsPrivateInputCleanupJournalService])assert.equal(token(type),ShortsCleanupDatabaseService);
  await db.onModuleDestroy();assert.equal(closed,1);
});

test('publication authority, source writes and deletion-journal authority fail control startup and close only that pool', async t=>{
  const path=await credential(t);environment(t,{SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED:'true',SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE:path});
  for(const rejected of Object.keys(proof)) {
    const source=primary(), db=new ShortsCleanupDatabaseService(source);let closed=0;
    db.createPool=()=>({onModuleInit:async()=>{},onModuleDestroy:async()=>{closed++;},query:async()=>[{...proof,[rejected]:false}]});
    await assert.rejects(db.onModuleInit(),/initialization failed/);assert.equal(closed,1);assert.deepEqual(source.calls,[]);
    assert.throws(()=>db.query('SELECT 1'),{status:503});
  }
});

test('shutdown during credential loading cannot create a late database pool', async t=>{
  const path=await credential(t);environment(t,{SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:'true',SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE:path});
  const db=new ShortsCleanupDatabaseService(primary());db.createPool=()=>assert.fail('shutdown must fence late initialization');
  const starting=db.onModuleInit();await db.onModuleDestroy();await assert.rejects(starting,{status:503});
});

test('private retirement locks through its guarded snapshot without requesting source UPDATE permission', async()=>{
  const statements=[], operation='c2fc990b-c1ce-4d42-89bb-0a01d2abed5a', key='a'.repeat(64), scope={network:'ae_uat',contract:'ct_test'};
  const db={query:async(text)=>{statements.push(text);return [];},transaction:async(_level,work)=>work({query:async(text)=>{
    statements.push(text);
    if(text.includes('INSERT INTO shorts_private_input_retirements'))return [{source_key:key,resource_id:'short',operation_id:operation,root_hash:'b'.repeat(64),reference_epoch:'1',object_count:1,retired_at:new Date()}];
    return [];
  }})};
  const receipt=await new ShortsPrivateInputRetirementsService(db).commit(scope,'short',key,operation,'b'.repeat(64),'{}');
  assert.equal(receipt.sourceKey,key);assert.ok(statements.some(x=>x==='SELECT shorts_private_input_snapshot($1,$2,$3,$4)'));
  assert.ok(!statements.some(x=>x.includes('FROM shorts_content')));
});
