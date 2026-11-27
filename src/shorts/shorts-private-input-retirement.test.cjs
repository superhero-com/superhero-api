const schemaMigrations = require('./testing/schema-migrations.cjs');
const {
  ShortsPrivateInputRetirement: Migration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { migratePrivateVersionTables } = require('./testing/private-version-database.cjs');
const { workerRole } = require('./testing/worker-role.cjs');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { WorkerRpc } = require('../../test/shorts/worker-rpc');
const { ShortsDeliveryGenerationsService } = require('./shorts-delivery-generations.service');
const { ShortsDeliveryStagingService } = require('./shorts-delivery-staging.service');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { ShortsDeliverySelectionService } = require('./shorts-delivery-selection.service');
const { ShortsDeliveryInputRetirementService } = require('./shorts-delivery-input-retirement.service');
const { ShortsPrivateInputRetirementsService } = require('./shorts-private-input-retirements.service');
const { ShortsPrivateInputRetirementService } = require('./shorts-private-input-retirement.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsSourceReaderService } = require('./shorts-source-reader.service');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { ShortsStorageReconciliationService } = require('./shorts-storage-reconciliation.service');
const golden = structuredClone(require('./testing/hls-v3.json'));
golden.descriptor.bytes = 100000000;
const { sourceKey } = require('./hls-protocol/hls-package');
const hash = value => createHash('sha256').update(value).digest('hex');

test('private retirement bounds concurrent proofs and drains them on parent cancellation and shutdown', { timeout: 10000 }, async () => {
  let started = 0, ready;
  const startedBoth = new Promise(resolve => { ready = resolve; });
  const scope = { network: 'ae_uat', contract: 'ct_protocol' };
  const shorts = { chain: { release: scope, state: { contract: scope.contract } }, ensurePlayable: async () => ({ id: 'original' }) };
  const media = { verifyDurableDelivery: async (_record, _descriptor, _prepared, signal) => {
    if (++started === 2) ready();
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } };
  const retirements = { operation: async () => undefined, snapshot: async () => ({ record: {} }),
    commit: async () => { assert.fail('cancelled proof must not commit'); } };
  const previous = process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED;
  process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED = 'true';
  let service;
  try { service = new ShortsPrivateInputRetirementService(shorts, media, { acknowledged: async () => ({}) }, retirements, {}, {}); }
  finally { if (previous === undefined) delete process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED; else process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED = previous; }
  const parent = new AbortController();
  const first = assert.rejects(service.retireInputs('original', 'a'.repeat(64), randomUUID(), parent.signal), { name: 'AbortError' });
  const second = assert.rejects(service.retireInputs('original', 'a'.repeat(64), randomUUID()), { name: 'AbortError' });
  await startedBoth;
  await assert.rejects(service.retireInputs('original', 'a'.repeat(64), randomUUID()), { status: 503 });
  parent.abort(); await first;
  await service.onModuleDestroy(); await second;
  await assert.rejects(service.retireInputs('original', 'a'.repeat(64), randomUUID()), { status: 503 });
  assert.equal(started, 2);
});

test('private retirement binds authenticated source references without deleting originals or releasing retention', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_private_retire_' + randomUUID().replaceAll('-', '');
  const role = 'shretire_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  const scope = { network: 'ae_uat', contract: 'ct_protocol' }, scopeArgs = [scope.network, scope.contract];
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  let owner, db, workerDb, identity, objects, roleCreated = false;
  t.after(async () => {
    objects?.onModuleDestroy();
    for (const connection of [db, workerDb, owner]) if (connection?.isInitialized) await connection.destroy();
    if (roleCreated) await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await identity?.dispose(); await admin.destroy();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 5 } };
  owner = new DataSource(options); await owner.initialize();
  await owner.transaction(async runner => {
    await migratePrivateVersionTables(runner);
    for (const name of ['ShortsDirectUploads', 'ShortsOriginalUploads',
      'ShortsDeliverySelection', 'ShortsDeliveryInputRetirement'])
      await new schemaMigrations[name]().up(runner);
    await new Migration().up(runner);
  });
  await owner.transaction(runner => new Migration().down(runner));
  await owner.transaction(runner => new Migration().up(runner));
  const sourceHash = hash('source'), metadata = new ShortsMetadataService(owner);
  await metadata.initialize(scope, sourceHash, 30, 30);
  identity = await workerRole(admin, { url: url.href, schema, scope });
  workerDb = new DataSource({ ...options, url: identity.url }); await workerDb.initialize();
  const worker = new WorkerRpc(workerDb, { scope, sourceHash }); await worker.verifyRuntime(scope, sourceHash);
  const generations = new ShortsDeliveryGenerationsService(owner, metadata);
  const staging = new ShortsDeliveryStagingService(owner, metadata);
  const packages = new ShortsDeliveryPackagesService(owner), selections = new ShortsDeliverySelectionService(owner);
  const encoded = new ShortsDeliveryInputRetirementService(owner);
  const prefix = `shorts-private-v1/${hash(JSON.stringify(scopeArgs))}/`;
  const ref = (id, name, bytes, sha256) => ({ key: `${prefix}${id}/${name}/key1/${sha256}`, keyId: 'key1', bytes, sha256 });
  const base = { ...structuredClone(golden.descriptor), creator: 'ak_creator', title: 'Original title', topic: 'Art', duration: 4,
    moderation: 'pending', safety: { status: 'no_flags', sourceSha256: golden.descriptor.original.sha256 },
    createdAt: 1, reports: 0, views: ['existing-view'], likes: 42 };
  const manifests = new Map();
  const prepare = async (id, replacement = false, sharedPart) => {
    const parts = Array.from({ length: Math.ceil(base.bytes / 1048576) }, (_, index) => ({ index,
      object: ref(id, 'part/' + index, Math.min(1048576, base.bytes - index * 1048576), hash('part-' + index)) }));
    if (sharedPart) parts[0].object = sharedPart;
    const bytes = Buffer.from(JSON.stringify({ version: 1, id, creator: base.creator, bytes: base.bytes, sha256: base.original.sha256, parts }));
    const manifest = ref(id, 'source-manifest', bytes.length, hash(bytes));
    manifests.set(manifest.key, bytes);
    const input = { processingProfile: 'original-h264-v1', acceptedMaxBytes: 100000000,
      objectKey: manifest.key, manifest, sha256: base.original.sha256, bytes: base.bytes,
      title: base.title, topic: base.topic, details: {} };
    if (replacement) {
      const claim = await staging.reserve(scope, id, base.id, input, bytes.toString());
      await staging.finish(scope, claim);
    } else await metadata.enqueue(scope, id, base.creator, input);
    const job = await worker.claim(scope); assert.equal(job.id, id);
    const record = { ...structuredClone(base), id, derivatives: { ...structuredClone(base.derivatives),
      fingerprint: replacement ? hash(id) : base.derivatives.fingerprint, generation: { job: id, fence: job.fence } } };
    record.privateMedia = { version: 1, fence: job.fence, source: job.input,
      files: Object.fromEntries(record.files.map(file => [file.name, ref(id, 'attempt/1/' + file.name.replaceAll('.', '-'), file.bytes, file.sha256)])) };
    await worker.complete(scope, job, record);
    if (replacement) {
      const candidate = await generations.get(scope, id);
      await packages.acknowledge(candidate.descriptor, golden.package);
      return { ...candidate, manifest: bytes.toString(), parts };
    }
    record.publication = 'published'; record.moderation = 'approved';
    await owner.query('UPDATE shorts_content SET body=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...scopeArgs, id, record]);
    await packages.acknowledge(golden.descriptor, golden.package);
    return { record, sourceKey: sourceKey(golden.descriptor), manifest: bytes.toString(), parts };
  };
  const original = await prepare(base.id), candidate = await prepare('replacement-private', true, original.parts[0].object);
  const args = [...scopeArgs, base.id], key = original.sourceKey;
  const patch = record => owner.query('UPDATE shorts_content SET body=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, record]);
  // Owner-only fixture time travel. Runtime roles cannot alter these clocks.
  const age = (table, trigger, column) => owner.transaction(async runner => {
    await runner.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await runner.query(`UPDATE ${table} SET ${column}=clock_timestamp()-interval '2 hours'`);
    await runner.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  });
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  roleCreated = true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT,INSERT ON ${schema}.shorts_private_input_retirements TO ${role};
    GRANT EXECUTE ON FUNCTION ${schema}.shorts_private_input_snapshot(text,text,text,text) TO ${role}`);
  const login = new URL(url); login.username = role; login.password = password;
  db = new DataSource({ ...options, url: login.href }); await db.initialize();
  const retirements = new ShortsPrivateInputRetirementsService(db);
  const snapshot = (source = key) => retirements.snapshot(scope, base.id, source);
  const count = async () => (await owner.query('SELECT count(*)::integer AS n FROM shorts_private_input_retirements'))[0].n;
  const commit = async (proof, manifest = original.manifest, operation = randomUUID(), source = key) =>
    retirements.commit(scope, base.id, source, operation, proof.rootHash, manifest);
  const retention = new ShortsRetentionService(owner, { scope, prefix: 'shorts-private-v1' });

  await t.test('private retirement requires prior encoded-input retirement and rechecks its policy without changing history', async () => {
    await assert.rejects(snapshot(), { code: 'SH409' });
    await age('shorts_delivery_packages', 'shorts_delivery_package_guard', 'acknowledged_at');
    await encoded.commit(scope, base.id, key, randomUUID());
    const history = await owner.query('SELECT * FROM shorts_delivery_input_retirements');
    const first = await snapshot(); assert.equal(first.resourceId, base.id);
    assert.deepEqual(await owner.query('SELECT * FROM shorts_delivery_input_retirements'), history);
    await selections.commit(scope, base.id, { sourceKey: key, revision: '0' }, candidate.sourceKey, randomUUID(), 'activate');
    await assert.rejects(snapshot(), { code: 'SH409' });
    await age('shorts_delivery_selections', 'shorts_delivery_selection_guard', 'selected_at');
    await encoded.commit(scope, base.id, candidate.sourceKey, randomUUID());
    assert.equal((await snapshot(candidate.sourceKey)).resourceId, candidate.record.id);
  });
  await t.test('holds, withdrawal, reports and pending appeals invalidate a previously valid snapshot', async () => {
    const proof = await snapshot(), holdId = randomUUID();
    await owner.query(`INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
      VALUES($1,$2,$3,$4,'recovery','owned-fixture')`, [...scopeArgs, holdId, base.id]);
    await assert.rejects(commit(proof), { code: 'SH409' });
    await owner.query('UPDATE shorts_retention_holds SET released_by=current_user,released_at=clock_timestamp() WHERE id=$1', [holdId]);
    for (const change of [{ publication: 'withdrawn' }, { moderation: 'rejected' }, { reports: 1 },
      { reportDetails: [{ reason: 'test' }] }, { appeal: { status: 'pending' } }, { safety: { status: 'error' } }]) {
      await patch({ ...original.record, ...change });
      await assert.rejects(commit(proof), { code: 'SH409' }); await patch(original.record);
    }
    assert.equal(await count(), 0);
  });
  await t.test('new upload references change the bound root while view counters and unrelated roots do not', async () => {
    const proof = await snapshot();
    await patch({ ...original.record, likes: 43, views: ['another-view'] });
    assert.equal((await snapshot()).rootHash, proof.rootHash); await patch(original.record);
    await owner.query(`INSERT INTO shorts_upload_sessions(network,contract,id,creator,input,state,direct_parts)
      VALUES($1,$2,$3,$4,$5,'uploading',$6)`, [...args, base.creator, original.record.privateMedia.source,
      { 0: { object: original.parts[0].object } }]);
    await assert.rejects(snapshot(), { code: 'SH409' });
    await owner.query("UPDATE shorts_upload_sessions SET state='enqueued' WHERE id=$1", [base.id]);
    await owner.query('INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref) VALUES($1,$2,$3,0,$4)',
      [...args, original.parts[0].object]);
    await assert.rejects(commit(proof), /references changed/);
    const current = await snapshot(); assert.notEqual(current.rootHash, proof.rootHash);
    await owner.query(`INSERT INTO shorts_upload_sessions(network,contract,id,creator,input) VALUES($1,$2,'other-upload',$3,'{"bytes":1,"processingProfile":"original-h264-v1"}')`, [...scopeArgs, base.creator]);
    assert.equal((await snapshot()).rootHash, current.rootHash);
  });
  await t.test('SQL authenticates exact manifest bytes and rejects stale roots, missing parts and cross-scope references', async () => {
    const proof = await snapshot();
    await assert.rejects(commit({ ...proof, rootHash: 'f'.repeat(64) }), /references changed/);
    await assert.rejects(commit(proof, original.manifest + ' '), /manifest identity/);
    // Corrupt saved manifests as an owner fixture, preserving their byte/digest binding.
    const old = structuredClone(original.record);
    for (const mutate of [doc => { doc.parts = []; }, doc => { doc.parts[0].index = 1; },
      doc => { doc.parts[0].object.bytes--; }, doc => { doc.parts[0].object.key = doc.parts[0].object.key.replace(hash(JSON.stringify(scopeArgs)), 'f'.repeat(64)); },
      doc => { doc.parts[0].object.extra = true; }]) {
      const doc = JSON.parse(original.manifest); mutate(doc); const text = JSON.stringify(doc);
      const changed = structuredClone(old), manifest = ref(base.id, 'source-manifest', Buffer.byteLength(text), hash(text));
      changed.privateMedia.source.manifest = manifest; changed.privateMedia.source.objectKey = manifest.key;
      await owner.query('UPDATE shorts_ingestion SET input=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, changed.privateMedia.source]);
      await patch(changed);
      await assert.rejects(commit(await snapshot(), text), { code: 'SH400' });
    }
    await owner.query('UPDATE shorts_ingestion SET input=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, old.privateMedia.source]);
    await patch(old); assert.equal(await count(), 0);
  });
  await t.test('completed job state and the frozen original byte limit remain required', async () => {
    await owner.query("UPDATE shorts_ingestion SET status='failed',result_id=NULL WHERE network=$1 AND contract=$2 AND id=$3", args);
    await assert.rejects(snapshot(), { code: 'SH409' });
    await owner.query("UPDATE shorts_ingestion SET status='ready',result_id=id WHERE network=$1 AND contract=$2 AND id=$3", args);
    for (const limit of [base.bytes - 1, '100000000', null]) {
      const changed = structuredClone(original.record); changed.privateMedia.source.acceptedMaxBytes = limit;
      await owner.query('UPDATE shorts_ingestion SET input=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, changed.privateMedia.source]);
      await patch(changed); await assert.rejects(snapshot(), { code: 'SH409' });
    }
    await owner.query('UPDATE shorts_ingestion SET input=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, original.record.privateMedia.source]);
    await patch(original.record);
    assert.equal((await snapshot()).resourceId, base.id);
  });
  let receipt;
  await t.test('concurrent retries create one complete deduplicated receipt without changing content, pins or retention', async () => {
    const before = await retention.inventory(), proof = await snapshot(), operation = randomUUID();
    const results = await Promise.all([commit(proof, original.manifest, operation), commit(proof, original.manifest, operation)]);
    assert.deepEqual(results[0], results[1]); receipt = results[0];
    assert.equal(receipt.objectCount, original.record.files.length + original.parts.length + 1);
    assert.equal(receipt.resourceId, base.id); assert.equal(receipt.rootHash, proof.rootHash);
    assert.equal('objects' in receipt, false); assert.equal('source_manifest' in receipt, false);
    const [row] = await owner.query('SELECT * FROM shorts_private_input_retirements');
    const byKey = (a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key));
    assert.deepEqual([...row.objects].sort(byKey), [...Object.values(original.record.privateMedia.files), original.record.privateMedia.source.manifest,
      ...original.parts.map(part => part.object)].sort(byKey));
    assert.equal(row.source_manifest, original.manifest);
    const withoutRetainedManifest = value => JSON.parse(JSON.stringify(value,
      (key, item) => key === 'retiredManifest' ? undefined : item));
    assert.deepEqual(withoutRetainedManifest(await retention.inventory()), before);
    assert.deepEqual((await owner.query('SELECT body FROM shorts_content WHERE id=$1', [base.id]))[0].body, original.record);
    assert.equal((await selections.current(scope, original.record)).sourceKey, candidate.sourceKey);
    assert.equal((await packages.get(golden.descriptor)).cid, golden.package.cid);
    await assert.rejects(commit(proof), { status: 409 });
    await assert.rejects(commit(proof, original.manifest, operation, candidate.sourceKey), { status: 409 });
    assert.equal(await retirements.operation({ ...scope, network: 'ae_mainnet' }, base.id, operation), undefined);
  });

  objects = new ShortsPrivateObjectsService({ endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'unused', prefix: 'shorts-private-v1',
    credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' }, activeKeyId: 'key1', keys: { key1: Buffer.alloc(32) } });
  let checks = 0, reads = 0, failMedia = false, failManifest = false, changePolicy = false, withdrawn = false;
  const sources = new ShortsSourceReaderService({ validateReference: (...values) => objects.validateReference(...values),
    get: async (_scope, reference) => { reads++; if (failManifest) throw new Error('authentication failed'); return manifests.get(reference.key); } });
  const shorts = { chain: { release: scope, state: { contract: scope.contract } }, ensurePlayable: async () => {
    if (withdrawn) throw new Error('withdrawn'); return original.record;
  } };
  const media = { verifyDurableDelivery: async (record, descriptor, prepared, signal) => {
    checks++; signal.throwIfAborted(); assert.equal(record.id, candidate.record.id); assert.equal(descriptor.id, base.id);
    assert.equal(prepared.cid, golden.package.cid); if (failMedia) throw new Error('corrupt durable bytes');
    if (changePolicy) await patch({ ...original.record, reports: 1 });
  } };
  const coordinator = enabled => {
    const old = process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED;
    if (enabled === undefined) delete process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED;
    else process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED = enabled;
    try { return new ShortsPrivateInputRetirementService(shorts, media, selections, retirements, sources, objects); }
    finally { if (old === undefined) delete process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED; else process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED = old; }
  };
  await t.test('coordinator is opt-in, verifies durable bytes and source authentication, and rejects changes during proof', async () => {
    assert.throws(() => coordinator('invalid'), /flag/);
    const disabled = coordinator();
    await assert.rejects(disabled.retireInputs(base.id, candidate.sourceKey, randomUUID()), { status: 503 });
    assert.equal(checks, 0); await disabled.onModuleDestroy();
    const active = coordinator('true'); t.after(() => active.onModuleDestroy());
    failMedia = true; await assert.rejects(active.retireInputs(base.id, candidate.sourceKey, randomUUID()), /corrupt durable bytes/);
    assert.equal(reads, 0); failMedia = false;
    failManifest = true; await assert.rejects(active.retireInputs(base.id, candidate.sourceKey, randomUUID()), /authentication failed/); failManifest = false;
    changePolicy = true; await assert.rejects(active.retireInputs(base.id, candidate.sourceKey, randomUUID()), { code: 'SH409' });
    changePolicy = false; await patch(original.record); assert.equal(await count(), 1);
    const operation = randomUUID(), result = await active.retireInputs(base.id, candidate.sourceKey, operation);
    assert.equal(result.resourceId, candidate.record.id); assert.equal(await count(), 2);
    const io = [checks, reads], restarted = coordinator('false');
    assert.deepEqual(await restarted.retireInputs(base.id, candidate.sourceKey, operation), result);
    assert.deepEqual([checks, reads], io); withdrawn = true;
    await assert.rejects(restarted.retireInputs(base.id, candidate.sourceKey, operation), /withdrawn/); withdrawn = false;
    await assert.rejects(active.retireInputs(base.id, candidate.sourceKey, operation, AbortSignal.abort()), { name: 'AbortError' });
    await restarted.onModuleDestroy();
  });
  await t.test('reference scans use authenticated retirement manifests after encrypted manifests disappear and retain holds and all object edges', async scanTest => {
    const scanRole = 'shscan_' + randomUUID().replaceAll('-', ''), scanPassword = randomUUID();
    await admin.query(`CREATE ROLE ${scanRole} LOGIN PASSWORD '${scanPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    let scanDb;
    scanTest.after(async () => { if (scanDb?.isInitialized) await scanDb.destroy(); await admin.query(`DROP OWNED BY ${scanRole}; DROP ROLE ${scanRole}`); });
    const readTables = ['shorts_runtime', 'shorts_content', 'shorts_ingestion', 'shorts_upload_sessions', 'shorts_upload_parts',
      'shorts_delivery_packages', 'shorts_delivery_generations', 'shorts_delivery_staging', 'shorts_retention_holds',
      'shorts_private_input_retirements', 'shorts_storage_inventory_runs', 'shorts_storage_inventory_objects',
      'shorts_storage_reconciliations', 'shorts_storage_reference_roots', 'shorts_storage_references'];
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${scanRole};
      GRANT SELECT ON ${readTables.map(name => schema + '.' + name).join(',')} TO ${scanRole};
      GRANT INSERT,UPDATE ON ${schema}.shorts_storage_reconciliations TO ${scanRole};
      GRANT INSERT ON ${schema}.shorts_storage_reference_roots,${schema}.shorts_storage_references TO ${scanRole}`);
    const scanLogin = new URL(url); scanLogin.username = scanRole; scanLogin.password = scanPassword;
    scanDb = new DataSource({ ...options, url: scanLogin.href }); await scanDb.initialize();
    manifests.clear();
    const beforeReads = reads, holdId = randomUUID();
    await owner.query(`INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
      VALUES($1,$2,$3,$4,'recovery','owned-fixture')`, [...scopeArgs, holdId, base.id]);
    const config = { scope, sourceHash, storageId: hash('storage'), prefix: 'shorts-private-v1', objectPrefix: prefix };
    const inventory = randomUUID();
    await owner.query(`INSERT INTO shorts_storage_inventory_runs(network,contract,id,source_hash,storage_id,object_prefix,complete)
      VALUES($1,$2,$3,$4,$5,$6,true)`, [...scopeArgs, inventory, sourceHash, config.storageId, prefix]);
    const scanRetention = new ShortsRetentionService(scanDb, config);
    const reconciliation = new ShortsStorageReconciliationService(scanDb, config, scanRetention, sources, objects);
    await reconciliation.verify();
    await admin.query(`REVOKE SELECT ON ${schema}.shorts_private_input_retirements FROM ${scanRole}`);
    await assert.rejects(reconciliation.verify(), /complete and read-only/);
    await admin.query(`GRANT SELECT,UPDATE(source_manifest) ON ${schema}.shorts_private_input_retirements TO ${scanRole}`);
    await assert.rejects(reconciliation.verify(), /complete and read-only/);
    await admin.query(`REVOKE UPDATE(source_manifest) ON ${schema}.shorts_private_input_retirements FROM ${scanRole}`);
    await reconciliation.verify();
    const run = randomUUID(); await reconciliation.start(run, inventory);
    let status;
    do { status = await reconciliation.step(run); } while (!status.referenceTraversalComplete);
    assert.equal(Number(status.references), 2 * (original.record.files.length + original.parts.length + 1));
    assert.equal(reads, beforeReads, 'retired manifests must not depend on removed storage objects');
    const roots = await owner.query('SELECT resource_id,active_holds,reasons FROM shorts_storage_reference_roots WHERE run_id=$1', [run]);
    for (const resource of [base.id, candidate.record.id]) {
      const root = roots.find(item => item.resource_id === resource);
      assert.equal(root.active_holds, 1); assert.ok(root.reasons.includes('explicit-hold'));
    }
    const originalSource = (await retention.inventory()).items.find(item => item.id === base.id).manifestSources[0];
    assert.throws(() => sources.manifestPartsFromDocument(scope, originalSource, Buffer.from(original.manifest + ' ')), /manifest identity/);
    assert.throws(() => sources.manifestPartsFromDocument(scope, originalSource, Buffer.from(original.manifest.replace('"version":1', '"version":2'))), /manifest identity/);
    assert.throws(() => sources.manifestPartsFromDocument(scope, originalSource, Buffer.from(original.manifest), AbortSignal.abort()), { name: 'AbortError' });
    const scan = randomUUID(); await reconciliation.start(scan, inventory);
    // A different currently persisted admission policy cannot borrow the old receipt's validation.
    const changed = { ...original.record.privateMedia.source, acceptedMaxBytes: base.bytes - 1 };
    await owner.query('UPDATE shorts_ingestion SET input=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, changed]);
    await reconciliation.step(scan); // unrelated upload root
    await assert.rejects(reconciliation.step(scan), /accepted upload/);
    assert.equal((await reconciliation.status(scan)).references, '0');
    await owner.query('UPDATE shorts_ingestion SET input=$4 WHERE network=$1 AND contract=$2 AND id=$3', [...args, original.record.privateMedia.source]);
    assert.equal(Number((await reconciliation.step(scan)).references), original.record.files.length + original.parts.length + 1);
    await owner.query('UPDATE shorts_retention_holds SET released_by=current_user,released_at=clock_timestamp() WHERE id=$1', [holdId]);
  });
  await t.test('workers have no private retirement authority and committed history survives failed modification and rollback', async () => {
    await assert.rejects(workerDb.query('SELECT * FROM shorts_private_input_retirements'), { code: '42501' });
    await assert.rejects(workerDb.query('SELECT shorts_private_input_snapshot($1,$2,$3,$4)', [...args, key]), { code: '42501' });
    for (const sql of ['DELETE FROM shorts_private_input_retirements', 'TRUNCATE shorts_private_input_retirements',
      'UPDATE shorts_private_input_retirements SET retired_at=clock_timestamp()']) await assert.rejects(owner.query(sql), { code: 'SH409' });
    await assert.rejects(owner.transaction('REPEATABLE READ', runner => runner.query('SELECT shorts_private_input_snapshot($1,$2,$3,$4)', [...args, key])), { code: 'SH400' });
    await assert.rejects(owner.transaction(runner => new Migration().down(runner)), /Preserve private input retirement history/);
    assert.deepEqual(await retirements.operation(scope, base.id, receipt.operationId), receipt);
  });
  await require('./testing/private-reference-barriers.cjs')({
    t, owner, db, workerDb, schema, role, scope, sourceHash, prefix, metadata,
    original, candidate, base, objects, sources, retention, manifests, ref,
  });
});
