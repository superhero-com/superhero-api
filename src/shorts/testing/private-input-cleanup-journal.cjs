const { ShortsPrivateInputCleanupJournal: Migration } = require('./schema-migrations.cjs');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsPrivateInputCleanupJournalService: Journal } = require('../shorts-private-input-cleanup-journal.service');
const { ShortsPrivateInputCleanupVerifierService: Verifier } = require('../shorts-private-input-cleanup-verifier.service');
const { ShortsDeliverySelectionService } = require('../shorts-delivery-selection.service');
const hash = value => createHash('sha256').update(value).digest('hex');

module.exports = async f => {
  const { t, owner, workerDb, scope, base, original, candidate, inventory, operation: barrier, target, retention } = f;
  await owner.transaction(manager => new Migration().up(manager));
  await owner.transaction(manager => new Migration().down(manager));
  await owner.transaction(manager => new Migration().up(manager));
  const [{ schema }] = await owner.query('SELECT current_schema() AS schema');
  const roles = [], connections = [], args = [scope.network, scope.contract];
  t.after(async () => {
    for (const connection of connections) if (connection.isInitialized) await connection.destroy();
    for (const role of roles) await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  });
  const principal = async verifier => {
    const name = 'shclean_' + randomUUID().replaceAll('-',''), password = randomUUID();
    await owner.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`); roles.push(name);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name};
      GRANT SELECT ON shorts_private_input_cleanup,shorts_private_input_verifications,shorts_private_input_attempts,shorts_private_input_outcomes,shorts_private_input_barriers TO ${name};
      GRANT EXECUTE ON FUNCTION shorts_private_cleanup_snapshot(uuid) TO ${name}`);
    if (verifier) await owner.query(`GRANT INSERT ON shorts_private_input_verifications TO ${name};
      GRANT EXECUTE ON FUNCTION shorts_private_cleanup_lock_batch(text,text,uuid[]) TO ${name}`);
    else await owner.query(`GRANT INSERT ON shorts_private_input_cleanup,shorts_private_input_attempts,shorts_private_input_outcomes TO ${name};
      GRANT EXECUTE ON FUNCTION shorts_private_sealed_snapshot(uuid),shorts_private_cleanup_dispatch(uuid) TO ${name}`);
    const login = new URL(process.env.SHORTS_TEST_PG_URL); login.username=name; login.password=password;
    const connection = new DataSource({ ...owner.options, url:login.href }); await connection.initialize(); connections.push(connection);
    return { db:connection, journal:new Journal(connection) };
  };
  const operator = await principal(false), verifier = await principal(true);
  const add = async label => {
    const identity=hash('journal-'+label), id=randomUUID();
    await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
      VALUES($1,$2,$3,$4,$5,$6,false,true,$7,clock_timestamp())`, [...args,inventory,identity,target.key,'version-'+label,target.bytes+36]);
    return { id, identity };
  };
  const reserve = async label => { const item=await add(label); await operator.journal.reserve(scope,item.id,barrier,inventory,item.identity); return item.id; };
  const unrelated = () => owner.query("UPDATE shorts_upload_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id='other-upload'");
  const count = async table => (await owner.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
  const verify = async id => verifier.journal.verified(scope,id,randomUUID(),await verifier.journal.snapshot(scope,id));
  let id;
  await t.test('cleanup journal freezes one inventory version behind a permanent reference barrier', async () => {
    const item=await add('initial'); id=item.id;
    const rows=await Promise.all([operator.journal.reserve(scope,id,barrier,inventory,item.identity),operator.journal.reserve(scope,id,barrier,inventory,item.identity)]);
    assert.deepEqual(rows[0],rows[1]); assert.equal(rows[0].version_id,'version-initial'); assert.equal(rows[0].object_key,target.key);
    const snapshot=await verifier.journal.snapshot(scope,id);
    assert.deepEqual(snapshot.records.map(root=>root.resourceId).sort(),[base.id,candidate.record.id].sort());
    assert.deepEqual(snapshot.ref,target); assert.equal(snapshot.version,'version-initial');
    await assert.rejects(operator.journal.reserve(scope,id,barrier,inventory,'f'.repeat(64)),{status:409});
    await assert.rejects(operator.journal.reserve(scope,randomUUID(),barrier,inventory,'f'.repeat(64)),/completed inventory/);
    await assert.rejects(verifier.journal.snapshot({...scope,network:'ae_mainnet'},id),{status:404});
  });
  await t.test('unrelated uploads and counters can change while the sealed key retains the same proof', async () => {
    const before=await verifier.journal.snapshot(scope,id); await unrelated();
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{likes}','99') WHERE id=$1",[base.id]);
    const after=await verifier.journal.snapshot(scope,id); assert.equal(after.stateHash,before.stateHash); assert.notEqual(after.epoch,before.epoch);
    const receipt=await verifier.journal.verified(scope,id,randomUUID(),before);
    assert.ok(Date.parse(receipt.expires_at)>Date.parse(receipt.verified_at));
    const [proof]=await owner.query('SELECT * FROM shorts_private_input_verifications WHERE id=$1',[receipt.id]);
    assert.equal(proof.reference_epoch,after.epoch);
    await owner.query('UPDATE shorts_content SET body=$1 WHERE id=$2',[original.record,base.id]);
  });
  await t.test('only the API verifier can mint durability proofs and only the operator can consume them', async () => {
    const snapshot=await operator.journal.snapshot(scope,id);
    await assert.rejects(operator.journal.verified(scope,id,randomUUID(),snapshot),{code:'42501'});
    const proof=await verifier.journal.verified(scope,id,randomUUID(),snapshot);
    await assert.rejects(verifier.journal.issue(scope,id,proof.id,randomUUID()),{code:'42501'});
    await assert.rejects(workerDb.query('SELECT * FROM shorts_private_input_verifications'),{code:'42501'});
    await assert.rejects(workerDb.query('SELECT shorts_private_cleanup_snapshot($1)',[id]),{code:'42501'});
    await assert.rejects(operator.db.query('UPDATE shorts_private_storage_epochs SET revision=0'),{code:'42501'});
    await assert.rejects(operator.db.query('UPDATE shorts_private_input_verifications SET expires_at=clock_timestamp()'),{code:'42501'});
  });
  await t.test('old, changed or held verification cannot mint a dispatch', async () => {
    const snapshot=await verifier.journal.snapshot(scope,id);
    await assert.rejects(verifier.journal.verified(scope,id,randomUUID(),{...snapshot,stateHash:'f'.repeat(64)}),/changed or expired/);
    await assert.rejects(verifier.journal.verified(scope,id,randomUUID(),{...snapshot,observedAt:new Date(Date.now()-360000).toISOString()}),/changed or expired/);
    const proof=await verify(id), hold=randomUUID(); await retention.hold({id:hold,resourceId:base.id,reason:'legal',reference:'cleanup-journal'});
    await assert.rejects(operator.journal.issue(scope,id,proof.id,randomUUID()),/retained/); await retention.release(hold);
    await owner.transaction(async manager => {
      await manager.query('ALTER TABLE shorts_private_input_verifications DISABLE TRIGGER shorts_private_cleanup_journal');
      await manager.query("UPDATE shorts_private_input_verifications SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[proof.id]);
      await manager.query('ALTER TABLE shorts_private_input_verifications ENABLE TRIGGER shorts_private_cleanup_journal');
    });
    await assert.rejects(operator.journal.issue(scope,id,proof.id,randomUUID()),/changed or expired/);
    assert.equal(await count('shorts_private_input_attempts'),0);
  });
  await t.test('disabled reference or hold serialization guards cannot supply cleanup proof', async () => {
    for (const [table,trigger] of [['shorts_ingestion','shorts_private_reference_barrier'],['shorts_retention_holds','shorts_private_reference_epoch']]) {
      await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      try { await assert.rejects(verifier.journal.snapshot(scope,id),/unavailable/); }
      finally { await owner.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
    }
    assert.equal((await verifier.journal.snapshot(scope,id)).operationId,id);
  });
  await t.test('the API verifier visits every shared root and cannot record failed, cancelled or stale media proof', async () => {
    const operation=await reserve('media'), seen=[]; let fail=false, change=false;
    const shorts={chain:{release:scope,state:{contract:scope.contract}},ensurePlayable:async short=>{
      assert.equal(short,base.id);return (await owner.query('SELECT body FROM shorts_content WHERE id=$1',[short]))[0].body;
    }};
    const media={verifyDurableDelivery:async(record,descriptor,prepared,signal)=>{
      signal.throwIfAborted(); seen.push(record.id); assert.equal(descriptor.id,base.id); assert.ok(prepared.cid);
      if(fail)throw new Error('durable bytes unavailable');
      if(change)await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{reports}','1') WHERE id=$1",[base.id]);
    }};
    const previous=process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED;
    const construct=enabled=>{process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED=String(enabled);return new Verifier(shorts,media,new ShortsDeliverySelectionService(owner),verifier.journal);};
    let active,disabled;
    try { active=construct(true);disabled=construct(false); }
    finally { if(previous===undefined)delete process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED;else process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED=previous; }
    t.after(()=>active.onModuleDestroy());t.after(()=>disabled.onModuleDestroy());
    const before=await count('shorts_private_input_verifications');
    await assert.rejects(disabled.verify(operation,randomUUID()),{status:503});
    fail=true;await assert.rejects(active.verify(operation,randomUUID()),/durable bytes/);fail=false;
    change=true;await assert.rejects(active.verify(operation,randomUUID()));change=false;
    await owner.query('UPDATE shorts_content SET body=$1 WHERE id=$2',[original.record,base.id]);
    await assert.rejects(active.verify(operation,randomUUID(),AbortSignal.abort()),{name:'AbortError'});
    assert.equal(await count('shorts_private_input_verifications'),before);
    seen.length=0;const proof=await active.verify(operation,randomUUID());
    assert.deepEqual(seen.sort(),[base.id,candidate.record.id].sort());assert.equal(proof.operation_id,operation);
    assert.deepEqual(Object.keys(proof).sort(),['expires_at','id','operation_id','verified_at']);
  });
  await t.test('issued authority remains usable across unrelated writes but not changed roots or renewed holds', async () => {
    const operation=await reserve('dispatch'), proof=await verify(operation), attempt=randomUUID();
    await operator.journal.issue(scope,operation,proof.id,attempt);
    await unrelated(); const dispatch=await operator.journal.dispatch(scope,operation,attempt);
    assert.equal(dispatch.version,'version-dispatch');assert.deepEqual(dispatch.ref,target);assert.ok(dispatch.issuedAt);
    assert.equal(Date.parse(dispatch.expiresAt),new Date(proof.expires_at).getTime());
    assert.equal('records' in dispatch,false);
    await assert.rejects(operator.journal.issue(scope,operation,proof.id,randomUUID()),/dispatch is still active|unique constraint/);
    const other=await reserve('other');await assert.rejects(operator.journal.issue(scope,other,proof.id,randomUUID()),/matching durability/);
    await owner.query('INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref) VALUES($1,$2,$3,1,$4)',[...args,base.id,original.parts[1].object]);
    await assert.rejects(operator.journal.dispatch(scope,operation,attempt),/references changed/);
    await owner.query('DELETE FROM shorts_upload_parts WHERE upload_id=$1 AND part=1',[base.id]);
    const hold=randomUUID();await retention.hold({id:hold,resourceId:base.id,reason:'recovery',reference:'after-issue'});
    await assert.rejects(operator.journal.dispatch(scope,operation,attempt),/retained/);
    await operator.journal.outcome(scope,operation,attempt,'uncertain');
    const restarted=new Journal(operator.db);const saved=await restarted.get(scope,operation);
    assert.equal(saved.operation.removed,false);assert.deepEqual(saved.outcomes.map(event=>event.kind),['uncertain']);
    // An accepted request can finish after a hold: record the observed outcome,
    // without allowing policy changes to erase the already-issued history.
    const results=await Promise.all([restarted.outcome(scope,operation,attempt,'removed'),restarted.outcome(scope,operation,attempt,'removed')]);
    assert.deepEqual(results[0],results[1]);assert.equal((await restarted.get(scope,operation)).operation.removed,true);
    await retention.release(hold);
    await assert.rejects(restarted.dispatch(scope,operation,attempt),/already removed/);
    await assert.rejects(verify(operation),/already removed/);
    await assert.rejects(restarted.outcome(scope,operation,randomUUID(),'removed'),{status:404});
  });
  await t.test('journal history cannot be rewritten or rolled back, and expired attempts cannot dispatch', async () => {
    const operation=await reserve('expiry'), proof=await verify(operation), attempt=randomUUID();
    await operator.journal.issue(scope,operation,proof.id,attempt);
    await owner.transaction(async manager=>{
      await manager.query('ALTER TABLE shorts_private_input_attempts DISABLE TRIGGER shorts_private_cleanup_journal');
      await manager.query("UPDATE shorts_private_input_attempts SET issued_at=clock_timestamp()-interval '31 seconds' WHERE id=$1",[attempt]);
      await manager.query('ALTER TABLE shorts_private_input_attempts ENABLE TRIGGER shorts_private_cleanup_journal');
    });
    await assert.rejects(operator.journal.dispatch(scope,operation,attempt),/expired/);
    for(const table of ['shorts_private_input_cleanup','shorts_private_input_verifications','shorts_private_input_attempts','shorts_private_input_outcomes'])
      for(const sql of [`DELETE FROM ${table}`,`TRUNCATE ${table} CASCADE`,`UPDATE ${table} SET id=id`])await assert.rejects(owner.query(sql),{code:'SH409'});
    await assert.rejects(owner.transaction(manager=>new Migration().down(manager)),/Preserve private cleanup journal/);
    await assert.rejects(owner.transaction('REPEATABLE READ',manager=>manager.query('SELECT shorts_private_cleanup_snapshot($1)',[id])),{code:'SH400'});
  });
  await t.test('private cleanup operator requests real API proofs and recovers issued outcomes', async t => {
    await require('./private-input-cleanup-operator.cjs')({ ...f, t, operator, verifier, add, barrier, schema });
  });
  await t.test('batch proofs are scoped and atomic, and the deletion role cannot mint them',async()=>{
    const ids=[await reserve('atomic-a'),await reserve('atomic-b')];
    const proofs=await Promise.all(ids.map(async operation=>({verificationId:randomUUID(),snapshot:await verifier.journal.snapshot(scope,operation)})));
    assert.deepEqual(proofs[0].snapshot.records.map(root=>root.durabilityHash),proofs[1].snapshot.records.map(root=>root.durabilityHash));
    await assert.rejects(operator.journal.verifiedBatch(scope,proofs),{code:'42501'});
    const before=await count('shorts_private_input_verifications');
    await assert.rejects(verifier.journal.verifiedBatch(scope,[proofs[0],{...proofs[1],snapshot:{...proofs[1].snapshot,stateHash:'f'.repeat(64)}}]),/changed or expired/);
    assert.equal(await count('shorts_private_input_verifications'),before);
    for(const operations of [[],[ids[0],ids[0]],[ids[0],randomUUID()],[null]])
      await assert.rejects(verifier.db.query('SELECT shorts_private_cleanup_lock_batch($1,$2,$3::uuid[])',[...args,operations]),{code:'SH400'});
    await assert.rejects(verifier.db.query('SELECT shorts_private_cleanup_lock_batch($1,$2,$3::uuid[])',['ae_mainnet',scope.contract,ids]),{code:'SH400'});
    const result=await verifier.journal.verifiedBatch(scope,proofs);assert.equal(result.length,2);
    assert.equal(+result[0].verified_at,+result[1].verified_at);assert.equal(+result[0].expires_at,+result[1].expires_at);
  });
  await t.test('different upload-part barriers share only identical durable roots',async()=>{
    const part=original.parts[1].object,identity=hash('different-part'),operation=randomUUID();
    await owner.query(`INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
      VALUES($1,$2,$3,$4,$5,'other-part-version',false,true,$6,clock_timestamp())`,[...args,inventory,identity,part.key,part.bytes+36]);
    const otherBarrier=await f.barrierFor(part);await operator.journal.reserve(scope,operation,otherBarrier,inventory,identity);
    const other=await verifier.journal.snapshot(scope,operation),first=await verifier.journal.snapshot(scope,id);
    assert.equal(other.records.length,1);assert.equal(first.records.length,2);assert.notDeepEqual(other.ref,first.ref);
    assert.equal(other.records[0].durabilityHash,first.records.find(root=>root.resourceId===other.records[0].resourceId).durabilityHash);
    const proofs=await verifier.journal.verifiedBatch(scope,[{verificationId:randomUUID(),snapshot:first},{verificationId:randomUUID(),snapshot:other}]);
    assert.equal(proofs.length,2);
  });
  await t.test('a batch locks every canonical Short before the epoch, without granting proof to a synthetic root',async()=>{
    const other='zz-batch-lock-canonical',fakeBarrier=randomUUID(),fakeOperation=randomUUID();
    await owner.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
      VALUES($1,$2,$3,'ak_fixture',1,$4)`,[...args,other,require('./original-record.cjs').originalRecord(other,{creator:'ak_fixture',createdAt:1,publication:'withdrawn'})]);
    // Owner-only fault fixture: the helper's lock ordering can be exercised without
    // inventing a playable second Short. Its ordinary snapshot must still reject it.
    await owner.transaction(async db=>{
      await db.query('ALTER TABLE shorts_private_input_barriers DISABLE TRIGGER USER; ALTER TABLE shorts_private_input_cleanup DISABLE TRIGGER USER');
      await db.query(`INSERT INTO shorts_private_input_barriers SELECT (jsonb_populate_record(NULL::shorts_private_input_barriers,
        to_jsonb(b)||jsonb_build_object('id',$2::text,'object_key',replace(b.object_key,$3::text,$4::text),'roots',jsonb_build_array(jsonb_build_object('shortId',$4::text))))).* FROM shorts_private_input_barriers b WHERE id=$1`,[barrier,fakeBarrier,base.id,other]);
      await db.query(`INSERT INTO shorts_private_input_cleanup SELECT (jsonb_populate_record(NULL::shorts_private_input_cleanup,
        to_jsonb(o)||jsonb_build_object('id',$2::text,'barrier_id',$3::text))).* FROM shorts_private_input_cleanup o WHERE id=$1`,[id,fakeOperation,fakeBarrier]);
      await db.query('ALTER TABLE shorts_private_input_barriers ENABLE TRIGGER USER; ALTER TABLE shorts_private_input_cleanup ENABLE TRIGGER USER');
    });
    await assert.rejects(verifier.journal.snapshot(scope,fakeOperation),/retirement closure changed|owner is retained/);
    const writer=owner.createQueryRunner(),probe=owner.createQueryRunner();await writer.connect();await probe.connect();await writer.startTransaction();
    let pending;
    try{
      await writer.query('SELECT id FROM shorts_content WHERE id=$1 FOR UPDATE',[other]);
      pending=verifier.db.query('SELECT shorts_private_cleanup_lock_batch($1,$2,$3::uuid[])',[...args,[id,fakeOperation]]);
      const deadline=Date.now()+3000;let blocked=false;
      while(Date.now()<deadline){
        [{blocked}]=await owner.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT shorts_private_cleanup_lock_batch%') AS blocked");
        if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true);
      await probe.startTransaction();
      await probe.query('SELECT revision FROM shorts_private_storage_epochs WHERE network=$1 AND contract=$2 FOR UPDATE NOWAIT',args);
      await probe.rollbackTransaction();await writer.commitTransaction();await pending;
    }finally{
      if(probe.isTransactionActive)await probe.rollbackTransaction();if(writer.isTransactionActive)await writer.rollbackTransaction();
      await pending?.catch(()=>{});await writer.release();await probe.release();
    }
  });
};
