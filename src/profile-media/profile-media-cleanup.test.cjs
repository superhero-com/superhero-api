const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { AccountMemory } = require('@aeternity/aepp-sdk');
const { ProfileMedia1792954800000 } = require('../migrations/1792954800000-ProfileMedia');
const { PostImages1793012400000 } = require('../migrations/1793012400000-PostImages');
const { ProfileMediaCleanup1793008800000 } = require('../migrations/1793008800000-ProfileMediaCleanup');
const { ProfileMediaRetention } = require('./profile-media-retention.service');
const { ProfileMediaCleanup } = require('./profile-media-cleanup.service');
const { ProfileMediaService } = require('./profile-media.service');
const { ProfileMediaStorage, profileImageHash } = require('./profile-media-storage.service');
const { ProfileMediaAssets } = require('./profile-media-assets.service');
const { ProfileMediaSourceCleanup } = require('./profile-media-source-cleanup.service');
const { ProfileMediaUploads } = require('./profile-media-uploads.service');
const { ShortsPrivateObjectsService } = require('../shorts/shorts-private-objects.service');
const { imageReference, profileImageReference } = require('./image-reference');

const url = process.env.PROFILE_MEDIA_TEST_DATABASE_URL;
const config = { enabled: true, scope: 'cleanup-test', network: 'ae_uat', contract: 'ct_test', maxStoredBytes: 268435456 };
const cid = letter => `bafy${letter.repeat(55)}`;
const chain = { providerAddress: 'ak_provider', links: async () => ({}), nonce: async () => 0, message: () => 'test' };
let db, schema;
before(async () => {
  if (!url) return;
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1'); assert.match(parsed.pathname, /_test$/);
  schema = `profile_cleanup_${randomBytes(6).toString('hex')}`;
  db = new DataSource({ type: 'postgres', url, extra: { options: `-c search_path=${schema}`, max: 6 } });
  await db.initialize(); await db.query(`CREATE SCHEMA ${schema}`);
  const runner = db.createQueryRunner(); await runner.connect();
  await new ProfileMedia1792954800000().up(runner);
  await new ProfileMediaCleanup1793008800000().up(runner);
  await new PostImages1793012400000().up(runner); await runner.release();
});
after(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.destroy(); } });
const row = async c => (await db.query('SELECT * FROM profile_media_assets WHERE scope=$1 AND cid=$2', [config.scope, c]))[0];
async function asset(letter, role = 'avatar') {
  await db.query(`INSERT INTO profile_media_assets(scope,cid,address,role,files,bytes,ready,created_at,last_linked_at,replaced_at)
    VALUES($1,$2,$3,$4,'[]',100,true,now()-interval '2 days',now()-interval '2 days',now()-interval '2 minutes')`,
    [config.scope, cid(letter), `ak_${letter}`, role]);
  return cid(letter);
}
async function write(c, address, state, expired = false) {
  await db.query(`INSERT INTO profile_media_writes(scope,id,address,role,cid,nonce,message,state,expires_at)
    VALUES($1,$2,$3,'avatar',$4,0,'test',$5,now()+$6::interval)`,
    [config.scope, randomUUID(), address, c, state, expired ? '-1 minute' : '5 minutes']);
}

test('only obsolete assets are queued; canonical images, pending changes, uploads and chain outages are protected', { skip: !url }, async () => {
  for (const letter of ['a','b','c','d','e','f','g']) await asset(letter, letter === 'b' ? 'cover' : 'avatar');
  await write(cid('c'), 'ak_c', 'submitted');
  await write(cid('d'), 'ak_d', 'prepared');
  await write(cid('e'), 'ak_e', 'prepared', true);
  await db.query(`INSERT INTO profile_media_uploads(scope,id,address,role,bytes,sha256,state,expires_at)
    VALUES($1,$2,'ak_f','avatar',100,$3,'processing',now()-interval '1 hour')`, [config.scope, randomUUID(), 'a'.repeat(64)]);
  chain.links = async address => address === 'ak_a' ? { avatar: profileImageReference(cid('a')) } : {};
  const retention = new ProfileMediaRetention(db, chain, config);
  await retention.process();
  assert.equal((await row(cid('a'))).ready, true);
  assert.equal((await row(cid('a'))).replaced_at, null);
  for (const letter of ['b','e','g']) assert.ok((await row(cid(letter))).cleanup_requested_at);
  for (const letter of ['c','d','f']) assert.equal((await row(cid(letter))).cleanup_requested_at, null);
  await asset('h');
  chain.links = async () => { throw new Error('Node unavailable'); };
  await assert.rejects(retention.process(), /Node unavailable/);
  assert.equal((await row(cid('h'))).ready, true);
  chain.links = async () => ({});
});

test('a claim committed while retention waits for the asset lock prevents deletion', { skip: !url }, async () => {
  await asset('i');
  const holder = db.createQueryRunner(); await holder.connect(); await holder.startTransaction();
  await holder.query('SELECT cid FROM profile_media_assets WHERE scope=$1 AND cid=$2 FOR UPDATE', [config.scope, cid('i')]);
  let notify;
  const waiting = new Promise(resolve => { notify = resolve; });
  const wrapped = { query: (...args) => db.query(...args), createQueryRunner: () => {
    const runner = db.createQueryRunner(), original = runner.query.bind(runner);
    runner.query = (sql, params) => {
      if (sql.includes('FOR UPDATE') && params?.[1] === cid('i')) notify();
      return original(sql, params);
    };
    return runner;
  } };
  const work = new ProfileMediaRetention(wrapped, chain, config).process();
  await waiting;
  await holder.query(`INSERT INTO profile_media_writes(scope,id,address,role,cid,nonce,message,state,expires_at)
    VALUES($1,$2,'ak_i','avatar',$3,0,'test','prepared',now()+interval '5 minutes')`, [config.scope, randomUUID(), cid('i')]);
  await holder.commitTransaction(); await holder.release(); await work;
  assert.equal((await row(cid('i'))).ready, true);
  assert.equal((await row(cid('i'))).cleanup_requested_at, null);
});

test('a cached profile read cannot erase a replacement marker', { skip: !url }, async () => {
  const address = AccountMemory.generate().address, c = cid('q');
  await db.query(`INSERT INTO profile_media_assets(scope,cid,address,role,files,bytes,ready,last_linked_at,replaced_at)
    VALUES($1,$2,$3,'avatar','[]',100,true,now(),now())`, [config.scope,c,address]);
  const service = new ProfileMediaService(db, {}, { links: async () => ({avatar:c}) }, config);
  assert.equal((await service.images(address)).avatar_cid,c);
  assert.ok((await row(c)).replaced_at, 'only an uncached retention check may clear the marker');
});

test('journal survives partial deletion; cleanup retries, stops serving old bytes, releases capacity and permits re-upload', { skip: !url }, async () => {
  // Use a new scope so earlier protected fixtures cannot affect the worker.
  const scope = { ...config, scope: 'cleanup-retry' }, c = cid('j');
  const files = [{ name: 'image.webp', bytes: 3, sha256: profileImageHash('img') }];
  await db.query(`INSERT INTO profile_media_assets(scope,cid,address,role,files,bytes,ready,last_linked_at,replaced_at,cleanup_requested_at,cleanup_retry_at)
    VALUES($1,$2,'ak_j','avatar',$3,100,false,now(),now(),now(),now())`, [scope.scope, c, JSON.stringify(files)]);
  let inventories = 0, removals = 0, pins = 0;
  const storage = {
    blocks: async () => { inventories++; return [cid('k'), c]; },
    remove: async () => {
      const [journal] = await db.query('SELECT cleanup_blocks,ready FROM profile_media_assets WHERE scope=$1 AND cid=$2', [scope.scope,c]);
      assert.deepEqual(journal.cleanup_blocks, [cid('k'),c]); assert.equal(journal.ready, false);
      if (++removals === 1) throw new Error('Lost reply after deleting a block');
    },
    prepare: async () => ({ cid: c, files }), pin: async () => { pins++; return { cid: c, files }; },
    read: async () => Buffer.from('img'),
  };
  const processor = new ProfileMediaAssets(db, storage, { encode: async () => ({ width:512, height:512, image:Buffer.from('img'),thumb:Buffer.from('t') }) }, scope);
  const service = new ProfileMediaService(db, {}, chain, scope);
  await assert.rejects(processor.image(c, 'image.webp'));
  await assert.rejects(service.claim('ak_j','avatar',c));
  const worker = new ProfileMediaCleanup(db, storage, {}, scope);
  await worker.process();
  let [state] = await db.query('SELECT deleted_at,cleanup_blocks FROM profile_media_assets WHERE scope=$1', [scope.scope]);
  assert.equal(state.deleted_at,null); assert.ok(state.cleanup_blocks);
  await db.query('UPDATE profile_media_assets SET cleanup_retry_at=now() WHERE scope=$1', [scope.scope]);
  await worker.process(); assert.equal(inventories,1); assert.equal(removals,2);
  [state] = await db.query('SELECT deleted_at FROM profile_media_assets WHERE scope=$1', [scope.scope]); assert.ok(state.deleted_at);
  const [capacity] = await db.query('SELECT coalesce(sum(bytes),0)::int AS bytes FROM profile_media_assets WHERE scope=$1 AND deleted_at IS NULL', [scope.scope]);
  assert.equal(capacity.bytes,0);
  const restored = await processor.prepare('ak_j','avatar',Buffer.from('source')); assert.equal(restored.cid,c); assert.equal(pins,1);
  await service.claim('ak_j','avatar',c);
  const [fresh] = await db.query('SELECT ready,deleted_at,cleanup_requested_at,last_linked_at FROM profile_media_assets WHERE scope=$1', [scope.scope]);
  assert.deepEqual(fresh,{ready:true,deleted_at:null,cleanup_requested_at:null,last_linked_at:null});
});

test('temporary cleanup preserves active processing, retries deletion failures and frees only successfully deleted reservations', { skip: !url }, async () => {
  const scope = { ...config, scope: 'cleanup-sources' };
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (let i=0;i<ids.length;i++) await db.query(`INSERT INTO profile_media_uploads(scope,id,address,role,bytes,sha256,parts,state,expires_at)
    VALUES($1,$2,'ak_upload','avatar',100,$3,'{"0":{"object":{"key":"fixture"}}}',$4,now()+$5::interval)`,
    [scope.scope,ids[i],'b'.repeat(64),i===1?'processing':'ready',i===2?'5 minutes':'-2 hours']);
  let calls=0;
  const worker = new ProfileMediaCleanup(db,{}, { remove: async id => { assert.equal(id,ids[0]); if (++calls===1) throw new Error('Storage outage'); } }, scope);
  await worker.process();
  assert.equal((await db.query('SELECT source_deleted_at FROM profile_media_uploads WHERE id=$1',[ids[0]]))[0].source_deleted_at,null);
  await worker.process(); assert.equal(calls,2);
  const rows=await db.query('SELECT id,source_deleted_at FROM profile_media_uploads WHERE scope=$1',[scope.scope]);
  assert.ok(rows.find(r=>r.id===ids[0]).source_deleted_at);
  assert.equal(rows.filter(r=>r.source_deleted_at===null).length,2);
});

test('storage deletion accepts only an exact journal and preserves pinned shared blocks; unknown failures stop it', async () => {
  const root=cid('m'), shared=cid('n'), missing=cid('o'), storage=new ProfileMediaStorage(config), paths=[];
  storage.request=async path=>{
    paths.push(path);
    if (path.startsWith('pin/rm')) return new Response(JSON.stringify({Code:0,Message:'not pinned or pinned indirectly'}),{status:500});
    const block=new URLSearchParams(path.split('?')[1]).get('arg');
    return new Response(JSON.stringify({Hash:block,...(block===shared?{Error:`pinned via ${cid('p')}`}:
      block===missing?{Error:`ipld: could not find ${missing}`}:{})}));
  };
  await storage.remove(root,[shared,missing,root]); assert.equal(paths.length,4);
  await assert.rejects(storage.remove(root,[shared])); assert.equal(paths.length,4);
  storage.request=async path=>new Response(JSON.stringify(path.startsWith('pin/rm')?{Pins:[root]}:{Hash:shared,Error:'pin check failed: unavailable'}));
  await assert.rejects(storage.remove(root,[shared,root]),/could not complete/);
  storage.request=async()=>new Response(JSON.stringify({Ref:shared,Err:'missing child'}));
  await assert.rejects(storage.blocks(root),/Incomplete/);
});

test('source delete credentials cannot address Shorts objects, another upload or another namespace', async () => {
  const bucket={endpoint:'https://storage.example',uploadEndpoint:'https://uploads.example',region:'us-east-1',bucket:'private',prefix:'private',forcePathStyle:true,
    credentials:{accessKeyId:'fixture',secretAccessKey:'fixture'},activeKeyId:'v1',keys:{v1:randomBytes(32)}};
  const objects=new ShortsPrivateObjectsService(bucket),uploads=new ProfileMediaUploads({},objects,config), cleaner=new ProfileMediaSourceCleanup(bucket,uploads);
  const id=randomUUID(),ref=objects.directReference(uploads.scope(),`profile-${id}`,0,100,'a'.repeat(64));
  let calls=0;
  const versions=new Set(['old-version','new-version','delete-marker']);
  cleaner.client.send=async command=>{
    calls++;
    if (command.constructor.name==='ListObjectVersionsCommand') {
      assert.equal(command.input.Prefix,ref.key);
      return {Versions:[...versions].filter(v=>v!=='delete-marker').map(v=>({Key:ref.key,VersionId:v})),
        DeleteMarkers:versions.has('delete-marker')?[{Key:ref.key,VersionId:'delete-marker'}]:[]};
    }
    assert.equal(command.input.Key,ref.key); assert.ok(command.input.VersionId);
    versions.delete(command.input.VersionId);return {};
  };
  try {
    await cleaner.remove(id,'0',ref); assert.equal(calls,5);assert.equal(versions.size,0);
    await assert.rejects(cleaner.remove(randomUUID(),'0',ref));
    await assert.rejects(cleaner.remove(id,'1',ref));
    await assert.rejects(cleaner.remove(id,'0',objects.directReference(uploads.scope(),'shorts-video',0,100,'a'.repeat(64))));
    await assert.rejects(cleaner.remove(id,'0',{...ref,key:ref.key.replace('private/','elsewhere/')}));
    assert.equal(calls,5);
  } finally {cleaner.onModuleDestroy();objects.onModuleDestroy();}
});


test('unused post drafts expire, retained images survive and a partially valid batch retains nothing', {skip:!url}, async()=>{
  const {PostMediaService}=require('./post-media.service');
  const scope={...config,scope:'post-cleanup',publicUrl:'https://images.example/profile-images'};
  const posts=new PostMediaService(db,scope);
  for (const letter of ['a','b','c','d']) {
    await db.query(`INSERT INTO profile_media_assets(scope,cid,address,role,files,bytes,ready,created_at)
      VALUES($1,$2,'ak_owner','post','[]',100,true,now()-interval '2 days')`,[scope.scope,cid(letter)]);
  }
  await assert.rejects(posts.retain('ak_owner',[cid('a'),cid('z')]));
  assert.equal((await db.query('SELECT last_linked_at FROM profile_media_assets WHERE scope=$1 AND cid=$2',[scope.scope,cid('a')]))[0].last_linked_at,null);
  await posts.retain('ak_owner',[cid('b')]);
  const holder=db.createQueryRunner(); await holder.connect(); await holder.startTransaction();
  await holder.query('SELECT cid FROM profile_media_assets WHERE scope=$1 AND cid=$2 FOR UPDATE',[scope.scope,cid('c')]);
  let notify; const waiting=new Promise(resolve=>{notify=resolve;});
  const wrapped={query:(...args)=>db.query(...args),createQueryRunner:()=>{
    const runner=db.createQueryRunner(),original=runner.query.bind(runner);
    runner.query=(sql,params)=>{if(sql.includes('FOR UPDATE') && params?.[1]===cid('c'))notify();return original(sql,params);};return runner;
  }};
  const work=new ProfileMediaRetention(wrapped,{...chain,links:async()=>{throw new Error('Post retention must not query profile links');}},scope).process();
  await waiting;
  await holder.query('UPDATE profile_media_assets SET last_linked_at=now() WHERE scope=$1 AND cid=$2',[scope.scope,cid('c')]);
  await holder.commitTransaction(); await holder.release(); await work;
  const rows=await db.query('SELECT cid,ready,cleanup_requested_at FROM profile_media_assets WHERE scope=$1',[scope.scope]);
  for(const row of rows) assert.equal(row.ready,[cid('b'),cid('c')].includes(row.cid));
  await assert.rejects(posts.retain('ak_owner',[cid('a')]));
});


test('cleanup preserves linked images for bare, colon and underscore identities', { skip: !url }, async () => {
  const scope = {...config, scope: 'reference-formats'};
  for (const format of [value=>value, imageReference, profileImageReference]) {
    const c = cid('z');
    await db.query(`INSERT INTO profile_media_assets(scope,cid,address,role,files,bytes,ready,created_at,last_linked_at,replaced_at)
      VALUES($1,$2,'ak_formats','avatar','[]',100,true,now()-interval '2 days',now()-interval '2 days',now()-interval '2 minutes')
      ON CONFLICT(scope,cid) DO UPDATE SET replaced_at=now()-interval '2 minutes'`, [scope.scope,c]);
    await new ProfileMediaRetention(db, {...chain,links:async()=>({avatar:format(c)})}, scope).process();
    const [asset] = await db.query('SELECT ready,replaced_at,cleanup_requested_at FROM profile_media_assets WHERE scope=$1 AND cid=$2',[scope.scope,c]);
    assert.equal(asset.ready,true);assert.equal(asset.replaced_at,null);assert.equal(asset.cleanup_requested_at,null);
  }
});
