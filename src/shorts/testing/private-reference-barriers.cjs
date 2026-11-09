const {
  ShortsPrivateReferenceBarriers: Migration,
  ShortsAcceptedManifests: Manifests,
} = require('./historical-migrations.cjs');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { ShortsPrivateReferenceBarriersService } = require('../shorts-private-reference-barriers.service');
const { ShortsStorageReconciliationService } = require('../shorts-storage-reconciliation.service');
const hash = value => createHash('sha256').update(value).digest('hex');

module.exports = async f => {
  const { t, owner, db, workerDb, role, scope, sourceHash, prefix, metadata, original, candidate, base,
    objects, sources, retention, manifests, ref } = f;
  const args = [scope.network, scope.contract], target = original.parts[0].object;
  await owner.transaction(async manager => { await new Manifests().up(manager); await new Migration().up(manager); });
  await owner.transaction(manager => new Migration().down(manager));
  await owner.transaction(manager => new Migration().up(manager));
  const service = new ShortsPrivateReferenceBarriersService(db);
  await owner.query(`GRANT SELECT,INSERT ON shorts_private_cleanup_scopes,shorts_private_input_barriers TO ${role};
    GRANT UPDATE(state,seal_scan_id) ON shorts_private_input_barriers TO ${role};
    GRANT EXECUTE ON FUNCTION shorts_private_barrier_lock(text,text) TO ${role};
    GRANT EXECUTE ON FUNCTION shorts_private_barrier_proof(text,text,uuid,text) TO ${role}`);
  const storageId = hash('barrier-storage'), inventory = randomUUID(), identity = hash('barrier-version');
  await owner.query(`INSERT INTO shorts_storage_inventory_runs(network,contract,id,source_hash,storage_id,object_prefix,complete)
    VALUES($1,$2,$3,$4,$5,$6,true)`, [...args, inventory, sourceHash, storageId, prefix]);
  await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
    VALUES($1,$2,$3,$4,$5,'immutable-version',false,true,$6,clock_timestamp())`, [...args, inventory, identity, target.key, target.bytes + 36]);
  const config = { scope, sourceHash, storageId, prefix: 'shorts-private-v1', objectPrefix: prefix };
  const inspector = new ShortsStorageReconciliationService(owner, config, retention, sources, objects);
  const scan = async () => { const id = randomUUID(); await inspector.start(id, inventory);
    while (!(await inspector.step(id)).referenceTraversalComplete) {} return id; };
  const addPart = (reference = target) => owner.query(`INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref)
    VALUES($1,$2,'other-upload',0,$3)`, [...args, reference]);
  const dropPart = () => owner.query("DELETE FROM shorts_upload_parts WHERE upload_id='other-upload'");
  const waiting = async pattern => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [{ blocked }] = await owner.query(`SELECT EXISTS(SELECT FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1) AS blocked`, [pattern]);
      if (blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('expected the other database connection to wait for its lock');
  };
  const adopt = async (id, bound = true, share = true, transaction) => {
    const document = JSON.parse(original.manifest); document.id = id;
    if (!share) document.parts = document.parts.map(part => ({ ...part, object: { ...part.object, key: part.object.key.replace('/' + base.id + '/', '/' + id + '/') } }));
    const text = JSON.stringify(document), manifest = ref(id, 'source-manifest', Buffer.byteLength(text), hash(text));
    const input = { ...original.record.privateMedia.source, objectKey: manifest.key, manifest };
    manifests.set(manifest.key, Buffer.from(text));
    return metadata.enqueue(scope, id, base.creator, input, transaction, undefined, bound ? text : undefined);
  };
  let operation, run;
  await t.test('cleanup barriers require explicit enrolment, derive their proof, and serialize duplicate reservations', async () => {
    await assert.rejects(service.reserve(scope, randomUUID(), await scan(), target.key), /fresh enrolled/);
    await adopt('legacy-before-enrolment', false, false);
    await owner.query("UPDATE shorts_ingestion SET status='cancelled' WHERE id='legacy-before-enrolment'");
    await service.enrol(scope); await service.enrol(scope);
    run = await scan(); operation = randomUUID();
    const results = await Promise.all([service.reserve(scope, operation, run, target.key), service.reserve(scope, operation, run, target.key)]);
    assert.deepEqual(results[0], results[1]);
    const row = results[0]; assert.equal(row.state, 'reserved'); assert.equal(row.storage_id, storageId);
    assert.equal(row.bytes, String(target.bytes)); assert.equal(row.sha256, target.sha256);
    assert.deepEqual(row.roots.map(root => root.resourceId), [base.id, candidate.record.id].sort());
    await assert.rejects(service.reserve(scope, randomUUID(), run, target.key), { code: '23505' });
    await assert.rejects(owner.transaction('REPEATABLE READ', manager => manager.query('SELECT shorts_private_barrier_proof($1,$2,$3,$4)', [...args, run, target.key])), { code: 'SH400' });
  });
  await t.test('reserved keys reject new parts, direct intents, private outputs and hidden manifest children atomically', async () => {
    await assert.rejects(addPart(), /reserved for retirement/);
    await assert.rejects(owner.query(`UPDATE shorts_upload_sessions SET direct_parts=$3 WHERE network=$1 AND contract=$2 AND id='other-upload'`,
      [...args, { 0: { object: target } }]), /reserved for retirement/);
    await assert.rejects(owner.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
      VALUES($1,$2,'late-content','ak_creator',1,$3)`, [...args, { id: 'late-content', creator: 'ak_creator', createdAt: 1,
        bytes: target.bytes, publication: 'published', privateMedia: { files: { video: target } } }]), /reserved for retirement/);
    await assert.rejects(adopt('opaque-adopter', false), /bound manifest/);
    await assert.rejects(adopt('bound-adopter'), /reserved for retirement/);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM shorts_ingestion WHERE id IN ('opaque-adopter','bound-adopter')"))[0].n, 0);
    // Existing legacy references and lifecycle fields remain usable after enrolment.
    await owner.query('UPDATE shorts_ingestion SET updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3', [...args, base.id]);
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{likes}','43') WHERE id=$1", [base.id]);
    await owner.query('UPDATE shorts_content SET body=$1 WHERE id=$2', [original.record, base.id]);
  });
  await t.test('holds remain insertable, invalidate sealing, and cancelled reservations reopen admission', async () => {
    const hold = randomUUID(); await retention.hold({ id: hold, resourceId: base.id, reason: 'legal', reference: 'barrier-test' });
    await assert.rejects(service.seal(scope, operation, run), /fresh enrolled/);
    await assert.rejects(service.seal(scope, operation, await scan()), /retains private inputs|eligible retired/);
    await retention.release(hold);
    const beforeSelection = await scan();
    await owner.query(`INSERT INTO shorts_delivery_selections(network,contract,short_id,revision,from_source_key,source_key,operation_id,kind)
      VALUES($1,$2,$3,2,$4,$5,$6,'rollback')`, [...args, base.id, candidate.sourceKey, original.sourceKey, randomUUID()]);
    await assert.rejects(service.seal(scope, operation, beforeSelection), /fresh enrolled/);
    await assert.rejects(service.seal(scope, operation, await scan()), /rollback window/);
    // Owner-only time travel; runtime roles cannot alter immutable selection clocks.
    await owner.transaction(async manager => {
      await manager.query('ALTER TABLE shorts_delivery_selections DISABLE TRIGGER shorts_delivery_selection_guard');
      await manager.query("UPDATE shorts_delivery_selections SET selected_at=clock_timestamp()-interval '2 hours'");
      await manager.query('ALTER TABLE shorts_delivery_selections ENABLE TRIGGER shorts_delivery_selection_guard');
    });
    assert.equal((await service.cancel(scope, operation)).state, 'cancelled');
    assert.equal((await service.cancel(scope, operation)).state, 'cancelled');
    await addPart(); await dropPart();
  });
  await t.test('unretired shared references and changed retired roots prevent reservation even after a fresh scan', async () => {
    await addPart(); await assert.rejects(service.reserve(scope, randomUUID(), await scan(), target.key), /eligible retired/); await dropPart();
    await owner.query('INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref) VALUES($1,$2,$3,1,$4)', [...args, base.id, original.parts[1].object]);
    await assert.rejects(service.reserve(scope, randomUUID(), await scan(), target.key), /references changed/);
    await owner.query('DELETE FROM shorts_upload_parts WHERE upload_id=$1 AND part=1', [base.id]);
    const old = await scan(); await addPart(); await dropPart();
    await assert.rejects(service.reserve(scope, randomUUID(), old, target.key), /fresh enrolled/);
  });
  await t.test('a writer that commits first invalidates the scan before reservation can acquire the epoch', async () => {
    const fresh = await scan(), writer = owner.createQueryRunner(); await writer.connect(); await writer.startTransaction();
    try {
      await writer.query(`INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref) VALUES($1,$2,'other-upload',0,$3)`, [...args, target]);
      const attempt = service.reserve(scope, randomUUID(), fresh, target.key);
      const failed = assert.rejects(attempt, /fresh enrolled/);
      await waiting('%shorts_private_barrier_proof%');
      await writer.commitTransaction(); await failed;
    } finally { if (writer.isTransactionActive) await writer.rollbackTransaction(); await writer.release(); }
    await dropPart();
  });
  await t.test('a barrier committed first rejects a waiting writer when its deferred constraint runs', async () => {
    const fresh = await scan(), reserver = owner.createQueryRunner(); await reserver.connect(); await reserver.startTransaction();
    const id = randomUUID();
    try {
      await reserver.query(`INSERT INTO shorts_private_input_barriers(id,network,contract,scan_id,object_key) VALUES($1,$2,$3,$4,$5)`, [id, ...args, fresh, target.key]);
      const rejected = assert.rejects(addPart(), /reserved for retirement/);
      await waiting('%INSERT INTO shorts_upload_parts%');
      await reserver.commitTransaction(); await rejected;
    } finally { if (reserver.isTransactionActive) await reserver.rollbackTransaction(); await reserver.release(); }
    await service.cancel(scope, id);
  });
  await t.test('sealing preserves a permanent tombstone across restart, policy changes and rejected rollback', async () => {
    run = await scan(); operation = randomUUID(); await service.reserve(scope, operation, run, target.key);
    const [sealed, duplicate] = await Promise.all([service.seal(scope, operation, run), service.seal(scope, operation, run)]);
    assert.deepEqual(sealed, duplicate); assert.equal(sealed.state, 'sealed'); assert.ok(sealed.sealed_at);
    const restarted = new ShortsPrivateReferenceBarriersService(db); assert.deepEqual(await restarted.seal(scope, operation, run), sealed);
    await assert.rejects(restarted.cancel(scope, operation), { status: 409 });
    await assert.rejects(addPart(), /reserved for retirement/);
    const hold = randomUUID(); await retention.hold({ id: hold, resourceId: base.id, reason: 'recovery', reference: 'after-seal' });
    await assert.rejects(owner.query('SELECT shorts_private_barrier_proof($1,$2,$3,$4)', [...args, await scan(), target.key]), /retains private inputs|eligible retired/);
    await retention.release(hold);
    for (const sql of ["UPDATE shorts_private_input_barriers SET state='cancelled' WHERE state='sealed'", 'DELETE FROM shorts_private_input_barriers',
      'TRUNCATE shorts_private_input_barriers', 'DELETE FROM shorts_private_cleanup_scopes', 'TRUNCATE shorts_private_cleanup_scopes CASCADE'])
      await assert.rejects(owner.query(sql), { code: 'SH409' });
    await assert.rejects(owner.transaction(manager => new Migration().down(manager)), /Preserve enrolled/);
    await assert.rejects(workerDb.query('SELECT * FROM shorts_private_input_barriers'), { code: '42501' });
    await assert.rejects(workerDb.query('SELECT shorts_private_barrier_proof($1,$2,$3,$4)', [...args, run, target.key]), { code: '42501' });
    await assert.rejects(db.query('UPDATE shorts_private_storage_epochs SET revision=0'), { code: '42501' });
    assert.equal((await owner.query('SELECT body FROM shorts_content WHERE id=$1', [base.id]))[0].body.cid, original.record.cid);
    assert.equal((await owner.query('SELECT body FROM shorts_delivery_generations WHERE job_id=$1', [candidate.record.id]))[0].body.cid, original.record.cid);
  });
  await t.test('historical-version cleanup cannot compete with a sealed final-copy barrier', async () => {
    const oldIdentity = hash('old-barrier-version');
    await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
      VALUES($1,$2,$3,$4,$5,'old-immutable-version',false,false,$6,clock_timestamp())`, [...args, inventory, oldIdentity, target.key, target.bytes + 36]);
    await assert.rejects(owner.query(`INSERT INTO shorts_private_version_cleanup(id,network,contract,scan_id,identity,storage_id,source_hash,
      object_key,candidate_version,key_id,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'old-immutable-version',$9,$10,$11)`,
      [randomUUID(), ...args, await scan(), oldIdentity, storageId, sourceHash, target.key, target.keyId, target.sha256, target.bytes]), /input retirement barrier/);
  });
  await t.test('unrelated bound source admission remains atomic and old opaque writers fail after enrolment', async () => {
    const created = await adopt('unrelated-bound', true, false); assert.equal(created.id, 'unrelated-bound');
    await assert.rejects(adopt('unrelated-opaque', false, false), /bound manifest/);
    const observer = owner.createQueryRunner(); await observer.connect(); await observer.startTransaction();
    try {
      await adopt('transaction-bound', true, false, observer.manager);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM shorts_ingestion WHERE id='transaction-bound'"))[0].n, 0);
      await observer.commitTransaction();
      assert.ok((await owner.query("SELECT source_manifest FROM shorts_ingestion WHERE id='transaction-bound'"))[0].source_manifest);
    } finally { if (observer.isTransactionActive) await observer.rollbackTransaction(); await observer.release(); }
  });
  await t.test('private cleanup journal and API verification use separate authority', async journalTest => {
    await require('./private-input-cleanup-journal.cjs')({ ...f, t: journalTest, inventory, operation, target,
      barrierFor:async reference=>{const id=randomUUID(),fresh=await scan();await service.reserve(scope,id,fresh,reference.key);await service.seal(scope,id,fresh);return id;},
    });
  });
};
