const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DataSource } = require('typeorm');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsRetentionHolds1791763216000 } = require('../migrations/1791763216000-ShortsRetentionHolds');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { retentionConfig } = require('./shorts-retention.config');
const { ShortsDatabaseService } = require('./shorts-database.service');

const scope = { network: 'ae_uat', contract: releaseFixture().release.contract };
const sourceHash = 'a'.repeat(64), prefix = 'shorts-private-v1';
const config = { scope, sourceHash, prefix };
const ref = (resource, slot, bytes = 10) => {
  const sha256 = createHash('sha256').update(resource + slot).digest('hex');
  const scopeHash = createHash('sha256').update(JSON.stringify(Object.values(scope))).digest('hex');
  return { key: `${prefix}/${scopeHash}/${resource}/${slot}/key1/${sha256}`, keyId: 'key1', sha256, bytes };
};

test('retention configuration accepts only explicit testnet metadata without service secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-retention-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'deployment.json');
  await writeFile(path, JSON.stringify(releaseFixture({ ...scope, sourceHash }).release));
  const env = { ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_DEPLOYMENT_FILE: path };
  assert.deepEqual(await retentionConfig(env), config);
  for (const change of [
    { ENABLE_SHORTS: 'false' }, { AE_NETWORK_ID: 'ae_mainnet' },
    { SHORTS_PRIVATE_S3_PREFIX: '../escape' }, { SHORTS_PRIVATE_S3_PREFIX: 'UpperCase' },
    { SHORTS_DEPLOYMENT_FILE: 'relative.json' }, { SHORTS_OPERATOR_KEY_FILE: '/key' },
    { SHORTS_PRIVATE_S3_CREDENTIALS_FILE: '/key' }, { AWS_ACCESS_KEY_ID: 'ambient' },
    { SHORTS_MODERATION_TOKEN_FILE: '/key' }, { SHORTS_IPFS_TOKEN_FILE: '/key' },
    { SHORTS_STREAM_KEY_FILE: '/key' }, { SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE: '/key' },
  ]) await assert.rejects(retentionConfig({ ...env, ...change }));
  await writeFile(path, JSON.stringify({ ...scope, network: 'ae_mainnet', sourceHash }));
  await assert.rejects(retentionConfig(env));
});

test('restricted retention inventory and hold history survive concurrent operations', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 90000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_retention_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href });
  await admin.initialize();
  const principals = [];
  let owner;
  const dir = await mkdtemp(join(tmpdir(), 'shorts-retention-cli-'));
  t.after(async () => {
    for (const p of principals) {
      if (p.db?.isInitialized) await p.db.onModuleDestroy();
      await admin.query(`DROP OWNED BY ${p.role}; DROP ROLE ${p.role}`);
    }
    if (owner?.isInitialized) await owner.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 2 },
    migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsRetentionHolds1791763216000] };
  owner = new DataSource(options); await owner.initialize();
  await owner.runMigrations({ transaction: 'all' });
  // Empty rollback/reapply is supported; used hold history later refuses rollback.
  await owner.undoLastMigration({ transaction: 'all' });
  await owner.runMigrations({ transaction: 'all' });
  await owner.query(`INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending)
    VALUES($1,$2,$3,8,2),($1,'ct_other',$3,8,2)`, [scope.network,scope.contract,sourceHash]);
  async function principal() {
    const role = `shretention_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
    const p = { role, password }; principals.push(p);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT ON ${['shorts_runtime','shorts_content','shorts_ingestion','shorts_upload_sessions','shorts_upload_parts'].map(table=>`${schema}.${table}`).join(',')} TO ${role};
      GRANT SELECT,INSERT,UPDATE ON ${schema}.shorts_retention_holds TO ${role}`);
    const endpoint = new URL(url); endpoint.username = role; endpoint.password = password;
    p.db = new ShortsDatabaseService(new DataSource({ ...options, url: endpoint.href, migrations: [] }));
    await p.db.onModuleInit(); p.service = new ShortsRetentionService(p.db, config);
    await p.service.verify(); return p;
  }
  const first = await principal(), second = await principal();
  const hold = { id: randomUUID(), resourceId: 'orphan-root', reason: 'recovery', reference: 'case-101' };
  const service = first.service;
  const sqlScope = [scope.network, scope.contract];

  await t.test('rollback cannot race a hold that is still being committed', async () => {
    const writer = owner.createQueryRunner(); await writer.connect(); await writer.startTransaction();
    const holdId = randomUUID();
    let outcome;
    try {
      await writer.query(`INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
        VALUES($1,$2,$3,'rollback-root','recovery','case-rollback')`,[...sqlScope,holdId]);
      outcome = new ShortsRetentionHolds1791763216000().down(owner).then(()=>({ok:true}),error=>({error}));
      const deadline = Date.now()+3000;
      let waiting = false;
      while (Date.now()<deadline) {
        const [row] = await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE relation=$1::regclass AND mode='AccessExclusiveLock' AND NOT granted) AS waiting`,[`${schema}.shorts_retention_holds`]);
        if (row.waiting) { waiting=true; break; }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true,'rollback must wait for the uncommitted hold');
      await writer.commitTransaction();
      assert.match((await outcome).error?.message || '',/Preserve retention hold history/);
      assert.equal((await service.holds('rollback-root')).items[0].id,holdId);
      await service.release(holdId);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release(); if (outcome) await outcome;
    }
  });

  await t.test('readonly sources and release-only history grants are checked', async () => {
    await assert.rejects(new ShortsRetentionService(owner, config).verify(), /restricted retention login/);
    for (const [table, privilege, error] of [
      ['shorts_content','UPDATE',/read-only/], ['shorts_retention_holds','DELETE',/restricted read/],
      ['shorts_retention_holds','TRUNCATE',/restricted read/],
    ]) {
      await owner.query(`GRANT ${privilege} ON ${table} TO ${first.role}`);
      await assert.rejects(service.verify(), error);
      await owner.query(`REVOKE ${privilege} ON ${table} FROM ${first.role}`);
    }
    await owner.query(`GRANT CREATE ON SCHEMA ${schema} TO ${first.role}`);
    await assert.rejects(service.verify(), /restricted retention login/);
    await owner.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${first.role}`);
    await owner.query(`GRANT UPDATE(body) ON shorts_content TO ${first.role}`);
    await assert.rejects(service.verify(), /read-only/);
    await owner.query(`REVOKE UPDATE(body) ON shorts_content FROM ${first.role}`);
    await owner.query(`REVOKE SELECT ON shorts_upload_parts FROM ${first.role}`);
    await assert.rejects(service.verify(), /read-only/);
    await owner.query(`GRANT SELECT ON shorts_upload_parts TO ${first.role}`);
    await admin.query(`GRANT ${second.role} TO ${first.role}`);
    await assert.rejects(service.verify(), /restricted retention login/);
    await admin.query(`REVOKE ${second.role} FROM ${first.role}`);
    await owner.query('ALTER TABLE shorts_content ENABLE ROW LEVEL SECURITY');
    await assert.rejects(service.verify(), /read-only/);
    await owner.query('ALTER TABLE shorts_content DISABLE ROW LEVEL SECURITY');
    await owner.query('ALTER TABLE shorts_retention_holds ENABLE ROW LEVEL SECURITY');
    await assert.rejects(service.verify(), /restricted read/);
    await owner.query('ALTER TABLE shorts_retention_holds DISABLE ROW LEVEL SECURITY');
    await assert.rejects(new ShortsRetentionService(first.db, { ...config, sourceHash: 'b'.repeat(64) }).verify(), /deployment mismatch/);
    await assert.rejects(first.db.query('DELETE FROM shorts_content'), { code: '42501' });
    await assert.rejects(first.db.query('TRUNCATE shorts_retention_holds'), { code: '42501' });
    await service.verify();
  });

  await t.test('same request can be retried concurrently without duplicate holds or changed identity', async () => {
    const [a,b] = await Promise.all([service.hold(hold), second.service.hold(hold)]);
    assert.deepEqual(a,b); assert.ok([first.role,second.role].includes(a.createdBy));
    assert.equal(a.releasedAt,null);
    const page = await service.holds(hold.resourceId); assert.deepEqual(page.items,[a]);
    assert.equal(page.next,null);
    await assert.rejects(service.hold({ ...hold, reason: 'legal' }), { status: 409 });
    for (const change of [{ id: 'invalid' }, { resourceId: '../secret' }, { reason: 'other' }, { reference: 'free text with private details' }])
      await assert.rejects(service.hold({ ...hold, ...change }), { status: 400 });
    const row = (await service.inventory()).items.find(item=>item.id===hold.resourceId);
    assert.equal(row.activeHolds,1); assert.deepEqual(row.retainReasons,['explicit-hold']);
    assert.equal(row.eligibleForDeletion,false);
  });

  await t.test('database prevents hold edits, forged actors, deletion and rollback of used history', async () => {
    for (const assignment of ["reason='legal'", "resource_id='other'", "reference='other'", "created_at=clock_timestamp()", "created_by='postgres'", "released_by='postgres',released_at=clock_timestamp()"])
      await assert.rejects(first.db.query(`UPDATE shorts_retention_holds SET ${assignment} WHERE id=$1`,[hold.id]), { code: 'P0001' });
    await assert.rejects(first.db.query(`INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference,created_by)
      VALUES($1,$2,$3,'forged','safety','case-1','postgres')`, [...sqlScope,randomUUID()]), { code: 'P0001' });
    await assert.rejects(owner.query('DELETE FROM shorts_retention_holds WHERE id=$1',[hold.id]), { code: 'P0001' });
    await assert.rejects(owner.undoLastMigration({ transaction: 'all' }), /Preserve retention hold history/);
    assert.equal((await service.holds(hold.resourceId)).items.length,1);
  });

  await t.test('release is idempotent across operators and does not reactivate historical holds', async () => {
    const [a,b] = await Promise.all([service.release(hold.id), second.service.release(hold.id)]);
    assert.deepEqual(a,b); assert.ok(a.releasedAt); assert.ok([first.role,second.role].includes(a.releasedBy));
    assert.deepEqual(await service.hold(hold),a);
    await assert.rejects(first.db.query('UPDATE shorts_retention_holds SET released_by=NULL,released_at=NULL WHERE id=$1',[hold.id]), { code: 'P0001' });
    await assert.rejects(service.release(randomUUID()), { status: 404 });
    assert.equal((await service.inventory()).items.some(item=>item.id===hold.resourceId),false);
    assert.equal((await service.holds(hold.resourceId)).items[0].releasedAt,a.releasedAt);
  });

  async function content(id, body = {}, contract = scope.contract) {
    await owner.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,'ak_creator',0,$4::jsonb)`,
      [scope.network,contract,id,JSON.stringify({ id,creator:'ak_creator',...body })]);
  }
  async function upload(id, state, expiry) {
    await owner.query(`INSERT INTO shorts_upload_sessions(network,contract,id,creator,input,state,expires_at)
      VALUES($1,$2,$3,'ak_creator','{}',$4,$5::timestamptz)`,[...sqlScope,id,state,expiry]);
  }
  const part = ref('clip','part/0'), manifest = ref('clip','manifest'), output = ref('clip','attempt/1/video-mp4');
  await t.test('inventory deduplicates known objects but flags manifest children and shared CIDs', async () => {
    await content('clip',{ cid:'bafy-shared',publication:'withdrawn',reports:1,appeal:{status:'pending'},
      privateMedia:{ source:{manifest},files:{ video:output, duplicate:part } } });
    await content('other-clip',{cid:'bafy-shared'},'ct_other');
    await upload('clip','enqueued',new Date(Date.now()+60000));
    await owner.query('INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref) VALUES($1,$2,$3,0,$4::jsonb)', [...sqlScope,'clip',JSON.stringify(part)]);
    await owner.query(`INSERT INTO shorts_ingestion(network,contract,id,creator,input) VALUES($1,$2,'clip','ak_creator',$3::jsonb)`, [...sqlScope,JSON.stringify({manifest})]);
    const a = await service.hold({ id:randomUUID(),resourceId:'clip',reason:'appeal',reference:'case-202' });
    const page = await service.inventory(); assert.equal(page.deletionEnabled,false);
    assert.equal(page.items.length,1); const row = page.items[0];
    assert.equal(row.id,'clip'); assert.equal(row.cidReferences,2);
    assert.equal(row.knownPlaintextBytes,30); assert.equal(row.objects.length,3);
    assert.equal(row.completePhysicalInventory,false); assert.equal(row.eligibleForDeletion,false);
    assert.deepEqual(row.retainReasons,['explicit-hold','pending-appeal','reports-without-disposition','active-preparation','withdrawn-content-reference','source-job-reference','manifest-children-not-inventoried']);
    await service.release(a.id);
    const again = (await service.inventory()).items[0]; assert.equal(again.activeHolds,0);
    assert.equal(again.eligibleForDeletion,false); assert.ok(again.retainReasons.includes('pending-appeal'));
  });

  await t.test('unsealed uploads, expired roots and hold-only roots stay visible with bounded cursor pages', async () => {
    await upload('active-upload','sealed',new Date(Date.now()+60000));
    await upload('expired-upload','uploading',new Date(0));
    await service.hold({ id:randomUUID(),resourceId:'unknown-root',reason:'legal',reference:'case-303' });
    const ids = []; let cursor;
    do {
      const page = await service.inventory(cursor,2); assert.ok(page.items.length<=2);
      ids.push(...page.items.map(row=>row.id)); cursor=page.next;
      for (const row of page.items) {
        assert.equal(row.eligibleForDeletion,false);
        if (row.id==='active-upload') assert.ok(row.retainReasons.includes('active-upload'));
        if (row.id==='expired-upload') assert.deepEqual(row.retainReasons,[]);
      }
    } while (cursor);
    assert.deepEqual(ids,['active-upload','clip','expired-upload','unknown-root']);
    assert.deepEqual(await service.inventory('zzzz'),{ items:[],next:null,deletionEnabled:false });
    for (const limit of [0,51,1.5,'2']) await assert.rejects(service.inventory('',limit),{status:400});
    await assert.rejects(service.inventory('../cursor'),{status:400});
    for (const cursor of [null,false,0,[]]) await assert.rejects(service.inventory(cursor),{status:400});
  });

  await t.test('history is paged and released entries remain queryable', async () => {
    const all = await Promise.all(Array.from({length:3},()=>service.hold({id:randomUUID(),resourceId:'history-root',reason:'safety',reference:'case-404'})));
    await service.release(all[1].id);
    const one = await service.holds('history-root','',2), two = await service.holds('history-root',one.next,2);
    assert.equal(one.items.length,2); assert.equal(two.items.length,1); assert.equal(two.next,null);
    assert.deepEqual([...one.items,...two.items].map(row=>row.id),all.map(row=>row.id).sort());
    await assert.rejects(service.holds('../bad'),{status:400});
    await assert.rejects(service.holds('history-root','bad'),{status:400});
    for (const cursor of [null,false,0,[]]) await assert.rejects(service.holds('history-root',cursor),{status:400});
    await assert.rejects(service.holds('history-root','',100),{status:400});
  });

  await t.test('corrupt and cross-deployment object references fail the whole page', async () => {
    for (const invalid of [{...output,key:'other/'+output.key},{...output,bytes:0},{...output,bytes:67108865},{...output,keyId:'unknown'}]) {
      await owner.query(`UPDATE shorts_content SET body=jsonb_set(body,'{privateMedia,files,video}',$3::jsonb) WHERE network=$1 AND contract=$2 AND id='clip'`,[...sqlScope,JSON.stringify(invalid)]);
      await assert.rejects(service.inventory(),/invalid private object/);
    }
    await owner.query(`UPDATE shorts_content SET body=jsonb_set(body,'{privateMedia,files,video}',$3::jsonb) WHERE network=$1 AND contract=$2 AND id='clip'`,[...sqlScope,JSON.stringify({...part,bytes:11})]);
    await assert.rejects(service.inventory(),/Conflicting private object/);
    await owner.query(`UPDATE shorts_content SET body=jsonb_set(body,'{privateMedia,files,video}',$3::jsonb) WHERE network=$1 AND contract=$2 AND id='clip'`,[...sqlScope,JSON.stringify(output)]);
    await service.inventory();
  });

  await t.test('built Nest command works with only a database login and public manifest', async () => {
    const manifestPath = join(dir,'deployment.json'), requestPath = join(dir,'request.json');
    await writeFile(manifestPath,JSON.stringify(releaseFixture({...scope,sourceHash}).release));
    const env = { PATH:process.env.PATH, NODE_ENV:'production', ENABLE_SHORTS:'true', AE_NETWORK_ID:'ae_uat',
      SHORTS_DEPLOYMENT_FILE:manifestPath, SHORTS_DB_CONCURRENCY:'1', DB_HOST:url.hostname,DB_PORT:url.port,
      DB_DATABASE:url.pathname.slice(1), DB_USER:first.role,DB_PASSWORD:first.password, PGOPTIONS:`-c search_path=${schema}` };
    const run = async (action, request, changes = {}) => {
      await writeFile(requestPath,JSON.stringify(request));
      return promisify(execFile)(process.execPath,['dist/shorts/retention-main.js',action,requestPath],{env:{...env,...changes},timeout:15000,maxBuffer:1048576});
    };
    let result = await run('inventory',{limit:1}); let page = JSON.parse(result.stdout);
    assert.equal(page.items.length,1); assert.ok(page.next); assert.equal(result.stderr,'');
    const request = {id:randomUUID(),resourceId:'cli-root',reason:'recovery',reference:'case-505'};
    result = await run('hold',request); assert.equal(JSON.parse(result.stdout).id,request.id);
    result = await run('release',{id:request.id}); assert.ok(JSON.parse(result.stdout).releasedAt);
    result = await run('holds',{resourceId:'cli-root'}); assert.equal(JSON.parse(result.stdout).items.length,1);
    await assert.rejects(run('inventory',{delete:true}),error=>error.code===1 && !error.stdout);
    await assert.rejects(run('inventory',{}, {AWS_SECRET_ACCESS_KEY:'never-print-this'}),error=>error.code===1 && !error.stdout && !error.stderr.includes('never-print-this'));
    await assert.rejects(run('inventory',{}, {AE_NETWORK_ID:'ae_mainnet'}),error=>error.code===1 && !error.stdout);
    page=await service.inventory(); assert.equal(page.items.some(row=>row.id==='cli-root'),false);
  });
});
