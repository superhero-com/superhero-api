const schemaMigrations = require('./testing/historical-migrations.cjs');
const {
  ShortsFileStorageReferences: Migration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { ShortsStorageReconciliationService } = require('./shorts-storage-reconciliation.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsSourceReaderService } = require('./shorts-source-reader.service');
const fixture = require('./testing/hls-v3.json');
const hash = value => createHash('sha256').update(value).digest('hex');

test('maximum original sources and large renditions remain accounted for without downloading media or widening legacy limits', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_large_refs_' + randomUUID().replaceAll('-', ''), role = 'shrefs_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  let owner, db, objects, roleCreated = false;
  t.after(async () => {
    objects?.onModuleDestroy(); if (db?.isInitialized) await db.destroy(); if (owner?.isInitialized) await owner.destroy();
    if (roleCreated) await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.destroy();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 2 } };
  owner = new DataSource(options); await owner.initialize();
  await owner.transaction(async runner => {
    for (const name of ['ShortsMetadata', 'ShortsUploads', 'ShortsWorkers',
      'ShortsWorkerAuthority', 'ShortsProcessingCapacity', 'ShortsRetentionHolds',
      'ShortsStorageInventory', 'ShortsStorageReferences',
      'ShortsWorkerBackpressure', 'ShortsUploadBudget', 'ShortsOriginalContent',
      'ShortsDeliveryPackages']) await new schemaMigrations[name]().up(runner);
  });
  const scope = { network: 'ae_uat', contract: 'ct_protocol' }, args = [scope.network, scope.contract], prefix = 'shorts-private-v1';
  const config = { scope, prefix, sourceHash: hash('source'), storageId: hash('storage'), objectPrefix: `${prefix}/${hash(JSON.stringify(args))}/` };
  await owner.query('INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)', [...args, config.sourceHash]);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`); roleCreated = true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT ON ${['shorts_runtime', 'shorts_content', 'shorts_ingestion', 'shorts_upload_sessions', 'shorts_upload_parts',
      'shorts_delivery_packages', 'shorts_retention_holds', 'shorts_storage_inventory_runs', 'shorts_storage_inventory_objects'].map(name => `${schema}.${name}`).join(',')} TO ${role};
    GRANT SELECT,INSERT,UPDATE ON ${schema}.shorts_storage_reconciliations TO ${role};
    GRANT SELECT,INSERT ON ${schema}.shorts_storage_reference_roots,${schema}.shorts_storage_references TO ${role}`);
  const login = new URL(url); login.username = role; login.password = password;
  db = new DataSource({ ...options, url: login.href }); await db.initialize();
  objects = new ShortsPrivateObjectsService({ endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'unused', prefix,
    credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' }, activeKeyId: 'key1', keys: { key1: Buffer.alloc(32) } });
  const record = { ...structuredClone(fixture.descriptor), creator: 'ak_creator', createdAt: 1, publication: 'published' };
  record.bytes = 100000000;
  record.files[0].bytes = 100000000;
  const ref = (name, bytes, sha256) => ({ key: `${config.objectPrefix}${record.id}/${name}/key1/${sha256}`, keyId: 'key1', bytes, sha256 });
  const parts = Array.from({ length: Math.ceil(record.bytes / 1048576) }, (_, index) => ({ index,
    object: ref('part/' + index, Math.min(1048576, record.bytes - index * 1048576), hash('source-part-' + index)) }));
  const manifestData = Buffer.from(JSON.stringify({ version: 1, id: record.id, creator: record.creator, bytes: record.bytes,
    sha256: record.original.sha256, parts }));
  const manifest = ref('source-manifest', manifestData.length, hash(manifestData));
  record.privateMedia = { version: 1, fence: record.derivatives.generation.fence,
    source: { processingProfile: record.derivatives.profile, acceptedMaxBytes: 100000000, bytes: record.bytes, sha256: record.original.sha256, objectKey: manifest.key, manifest },
    files: Object.fromEntries(record.files.map(file => [file.name, ref('attempt/1/' + file.name.replaceAll('.', '-'), file.bytes, file.sha256)])) };
  await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [...args, record.id, record.creator, record]);
  await owner.query('INSERT INTO shorts_ingestion(network,contract,id,creator,input) VALUES($1,$2,$3,$4,$5)',
    [...args, record.id, record.creator, { ...record.privateMedia.source, title: 'Original', topic: 'Art', details: {} }]);
  let reads = 0;
  const sources = new ShortsSourceReaderService({ validateReference: (...values) => objects.validateReference(...values),
    get: async (_scope, value) => { assert.deepEqual(value, manifest); reads++; return manifestData; } });
  const retention = new ShortsRetentionService(db, config), service = new ShortsStorageReconciliationService(db, config, retention, sources, objects);
  await assert.rejects(service.verify(), /Apply ShortsFileStorageReferences/);
  await owner.transaction(runner => new Migration().up(runner)); await service.verify();
  await owner.transaction(runner => new Migration().down(runner));
  await assert.rejects(service.verify(), /Apply ShortsFileStorageReferences/);
  await owner.transaction(runner => new Migration().up(runner)); await service.verify();
  const inventoryId = randomUUID(), scanId = randomUUID();
  await owner.query(`INSERT INTO shorts_storage_inventory_runs(network,contract,id,source_hash,storage_id,object_prefix,complete)
    VALUES($1,$2,$3,$4,$5,$6,true)`, [...args, inventoryId, config.sourceHash, config.storageId, config.objectPrefix]);
  const large = record.privateMedia.files['video-1080.mp4'];
  await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
    VALUES($1,$2,$3,$4,$5,'version',false,true,$6,clock_timestamp())`, [...args, inventoryId, hash(large.key), large.key, large.bytes + 36]);
  await service.start(scanId, inventoryId);
  const done = await service.step(scanId); assert.equal(done.referenceTraversalComplete, true);
  assert.equal(done.references, String(parts.length + record.files.length + 1));
  assert.equal(reads, 1, 'identical source policy from the job and content share one manifest read');
  const refs = await service.references(scanId), stored = refs.items.find(row => row.key === large.key);
  assert.equal(stored.bytes, '100000000'); assert.equal(stored.sizeMismatch, false); assert.equal(stored.observations, 1);
  const physical = (await service.objects(scanId)).items[0]; assert.equal(physical.classification, 'referenced'); assert.equal(physical.sizeMismatch, false);
  await t.test('different saved limits on the same manifest cannot share validation or leave partial evidence', async () => {
    const bad = structuredClone(record); bad.privateMedia.source.acceptedMaxBytes = record.bytes - 1;
    await owner.query('UPDATE shorts_content SET body=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, record.id, bad]);
    const retry = randomUUID(); await service.start(retry, inventoryId);
    const before = reads;
    await assert.rejects(service.step(retry), /Private source does not match the accepted upload/);
    assert.equal(reads, before + 2, 'the content claim must be validated independently of the valid ingestion claim');
    assert.equal((await service.status(retry)).roots, '0');
    assert.equal((await service.status(retry)).references, '0');
    await owner.query('UPDATE shorts_content SET body=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, record.id, record]);
    assert.equal((await service.step(retry)).references, String(parts.length + record.files.length + 1));
  });
  await t.test('a policy change while reading the manifest invalidates the reference snapshot', async () => {
    const retry = randomUUID(); await service.start(retry, inventoryId);
    const get = sources.objects.get;
    sources.objects.get = async (...values) => {
      const result = await get(...values);
      const bad = structuredClone(record); bad.privateMedia.source.acceptedMaxBytes = record.bytes - 1;
      await owner.query('UPDATE shorts_content SET body=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, record.id, bad]);
      return result;
    };
    try { await assert.rejects(service.step(retry), /references or holds changed/); }
    finally { sources.objects.get = get; }
    assert.equal((await service.status(retry)).roots, '0');
    assert.equal((await service.status(retry)).references, '0');
    await owner.query('UPDATE shorts_content SET body=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, record.id, record]);
    assert.equal((await service.step(retry)).referenceTraversalComplete, true);
  });
  await t.test('version inspection binds physical observations to the exact scoped logical reference', async () => {
    const identity = hash('older version');
    await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
      VALUES($1,$2,$3,$4,$5,'older/version+1=',false,false,$6,clock_timestamp())`, [...args, inventoryId, identity, large.key, large.bytes + 36]);
    let checks = 0;
    objects.verifyVersionCopies = async (actualScope, actualRef, version, signal) => {
      checks++; assert.deepEqual(actualScope, scope); assert.deepEqual(actualRef, large); assert.equal(version, 'older/version+1=');
      signal?.throwIfAborted();
      return { key: large.key, retainedVersion: 'current', candidateVersion: version, plaintextBytes: large.bytes, storedBytes: large.bytes + 36, sha256: large.sha256 };
    };
    const result = await service.verifyVersions(scanId, identity);
    assert.equal(result.contentVerified, true); assert.equal(result.retainedVersion, 'current');
    assert.equal(result.storageId, config.storageId); assert.equal(result.sourceHash, config.sourceHash);
    assert.equal(result.retentionRechecked, false); assert.equal(result.eligibleForDeletion, false); assert.equal(result.deletionEnabled, false);
    assert.equal(checks, 1);
    await assert.rejects(service.verifyVersions(scanId, 'invalid'), { status: 400 });
    await assert.rejects(service.verifyVersions(scanId, hash('missing')), { status: 409 });
    await assert.rejects(service.verifyVersions(scanId, hash(large.key)), { status: 409 });
    for (const change of ["deleted=true,bytes=0", "bytes=bytes+1", "object_key=object_key||'missing'"]) {
      await owner.query(`UPDATE shorts_storage_inventory_objects SET ${change} WHERE identity=$1`, [identity]);
      await assert.rejects(service.verifyVersions(scanId, identity), { status: 409 });
      await owner.query('UPDATE shorts_storage_inventory_objects SET deleted=false,bytes=$2,object_key=$3 WHERE identity=$1', [identity, large.bytes + 36, large.key]);
    }
    await owner.query('UPDATE shorts_storage_reconciliations SET complete=false WHERE id=$1', [scanId]);
    await assert.rejects(service.verifyVersions(scanId, identity), { status: 409 });
    await owner.query('UPDATE shorts_storage_reconciliations SET complete=true WHERE id=$1', [scanId]);
    await owner.query(`INSERT INTO shorts_storage_reference_roots(network,contract,run_id,resource_id,fingerprint,active_holds,reasons)
      VALUES($1,$2,$3,'conflicting-root',$4,0,'[]')`, [...args, scanId, hash('root')]);
    await owner.query(`INSERT INTO shorts_storage_references(network,contract,run_id,resource_id,object_key,key_id,sha256,bytes)
      VALUES($1,$2,$3,'conflicting-root',$4,$5,$6,$7)`, [...args, scanId, large.key, large.keyId, hash('conflicting digest'), large.bytes]);
    await assert.rejects(service.verifyVersions(scanId, identity), { status: 409 });
    await owner.query("DELETE FROM shorts_storage_references WHERE resource_id='conflicting-root'");
    assert.equal(checks, 1, 'invalid observations never reach object storage');
    await assert.rejects(service.verifyVersions(scanId, identity, AbortSignal.abort()));
    assert.equal(checks, 1);
  });
  await assert.rejects(owner.transaction(runner => new Migration().down(runner)), /Preserve large file reference history/);
  await assert.rejects(owner.query('UPDATE shorts_storage_references SET bytes=100000001 WHERE bytes=100000000'), { code: '23514' });
  for (const change of [{ bytes: 100000001 }, { bytes: 67108865 }, { sha256: hash('wrong') }]) {
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{privateMedia,files,video-1080.mp4}',$4) WHERE network=$1 AND contract=$2 AND id=$3", [...args, record.id, { ...large, ...change }]);
    await assert.rejects(retention.inventory(), /Private output differs/);
  }
  await owner.query('UPDATE shorts_content SET body=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, record.id, record]);
  const legacy = { id: 'z-legacy', creator: 'ak_creator', bytes: 10, privateMedia: { files: { video: { ...large, bytes: 67108865 } } } };
  await owner.query("INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,'z-legacy','ak_creator',1,$3)", [...args, legacy]);
  await assert.rejects(retention.inventory(), /invalid private object/);
  legacy.privateMedia.files.video.bytes = 67108864;
  await owner.query("UPDATE shorts_content SET body=$3 WHERE network=$1 AND contract=$2 AND id='z-legacy'", [...args, legacy]);
  assert.equal((await retention.inventory()).items.length, 2);
});
