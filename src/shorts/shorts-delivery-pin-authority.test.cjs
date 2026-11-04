require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsDeliveryPackagesService } = require('./shorts-delivery-packages.service');
const { ShortsPinTransfersService } = require('./shorts-pin-transfers.service');
const { sourceKey, validateSourcePackage } = require('./hls-protocol/hls-package');
const fixture = require('./testing/hls-v3.json');

test('PostgreSQL atomically acknowledges HLS under fresh, source-bound pin authority', {
  skip:!process.env.SHORTS_TEST_PG_URL,timeout:120000,
},async t=>{
  const url=new URL(process.env.SHORTS_TEST_PG_URL);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  const previous=process.env.SHORTS_IPFS_EXPIRING_WRITES;process.env.SHORTS_IPFS_EXPIRING_WRITES='true';
  t.after(()=>{if(previous===undefined)delete process.env.SHORTS_IPFS_EXPIRING_WRITES;else process.env.SHORTS_IPFS_EXPIRING_WRITES=previous;});
  const schema='shorts_ack_authority_'+randomUUID().replaceAll('-','');
  const admin=new DataSource({type:'postgres',url:url.href});await admin.initialize();await admin.query(`CREATE SCHEMA ${schema}`);
  const owner=new DataSource({type:'postgres',url:url.href,schema,extra:{options:`-c search_path=${schema}`,max:4}});await owner.initialize();
  t.after(async()=>{await owner.destroy();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.destroy();});
  await owner.transaction(async db=>{
    for(const name of ['1791763200000-ShortsMetadata','1791763202000-ShortsUploads','1791763203000-ShortsWorkers',
      '1791763204000-ShortsWorkerAuthority','1791763215000-ShortsProcessingCapacity','1791763216000-ShortsRetentionHolds',
      '1791763219000-ShortsHlsInventory','1791763220000-ShortsPinInventory','1791763222000-ShortsWorkerBackpressure',
      '1791763224000-ShortsUploadBudget','1793145600000-ShortsOriginalContent','1793145601000-ShortsAdaptiveInventory',
      '1793145602000-ShortsDeliveryPackages','1793145603000-ShortsDeliveryGenerations','1793145605000-ShortsGenerationDeliveryPackages',
      '1793145606000-ShortsDeliveryStaging','1793145607000-ShortsDeliverySelection','1793145608000-ShortsDeliveryInputRetirement',
      '1793145609000-ShortsInputReclamationReservations','1793145610000-ShortsPinTransfers'])
      await new (Object.values(require('../migrations/'+name))[0])().up(db);
  });
  const scope={network:fixture.descriptor.network,contract:fixture.descriptor.contract};
  await owner.query('INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,4)',
    [scope.network,scope.contract,'a'.repeat(64)]);
  const create=async id=>{
    const d=structuredClone(fixture.descriptor);d.id=id;d.derivatives.generation.job=id;
    await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
      [scope.network,scope.contract,id,'ak_creator',JSON.stringify({...d,creator:'ak_creator',createdAt:1,publication:'published'})]);
    return d;
  };
  const packages=new ShortsDeliveryPackagesService(owner), transfers=new ShortsPinTransfersService(owner);
  const grant=(d,extra={})=>transfers.begin(scope,{cid:fixture.package.cid,jobId:d.id,purpose:'hls',sourceKey:sourceKey(d),...extra});
  await t.test('missing, mismatched and expired permits cannot create a ready package',async()=>{
    const d=await create('authority-rejected');await assert.rejects(packages.acknowledge(d,fixture.package),{status:409});
    for(const extra of [{sourceKey:'0'.repeat(64)},{jobId:'another-short'},{cid:d.cid}]) {
      const pin=await grant(d,extra);await assert.rejects(packages.acknowledge(d,fixture.package,pin.operationId),{status:409});
      assert.equal((await transfers.get(pin.operationId)).state,'issued');
    }
    const expired=await grant(d);
    // Advance only this isolated fixture's stored authority; the production trigger is restored before the operation.
    await owner.transaction(async db=>{
      await db.query('ALTER TABLE shorts_pin_transfers DISABLE TRIGGER shorts_pin_transfer_guard');
      await db.query("UPDATE shorts_pin_transfers SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',quiet_until=quiet_until-interval '1 hour' WHERE operation_id=$1",[expired.operationId]);
      await db.query('ALTER TABLE shorts_pin_transfers ENABLE TRIGGER shorts_pin_transfer_guard');
    });
    await assert.rejects(packages.acknowledge(d,fixture.package,expired.operationId),{status:409});
    assert.equal(await packages.get(d),undefined);assert.equal((await transfers.get(expired.operationId)).state,'issued');
  });
  await t.test('a failure after package insertion rolls back both readiness and permit consumption',async()=>{
    const d=await create('authority-rollback'),pin=await grant(d);
    await owner.query(`CREATE FUNCTION reject_ack_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture lost acknowledgement'; END $$;
      CREATE TRIGGER reject_ack_fixture BEFORE UPDATE ON shorts_pin_transfers FOR EACH ROW EXECUTE FUNCTION reject_ack_fixture()`);
    await assert.rejects(packages.acknowledge(d,fixture.package,pin.operationId),/fixture lost acknowledgement/);
    assert.equal(await packages.get(d),undefined);assert.equal((await transfers.get(pin.operationId)).state,'issued');
    await owner.query('DROP TRIGGER reject_ack_fixture ON shorts_pin_transfers; DROP FUNCTION reject_ack_fixture()');
    await packages.acknowledge(d,fixture.package,pin.operationId);assert.deepEqual(await packages.get(d),validateSourcePackage(d,fixture.package));
    assert.equal((await transfers.get(pin.operationId)).state,'pinned');
    await packages.acknowledge(d,fixture.package); // A response lost after commit can be recovered without another upload.
    const [row]=await owner.query('SELECT body FROM shorts_content WHERE id=$1',[d.id]);assert.equal(row.body.cid,d.cid);
  });
  await t.test('a settled upload receipt cannot be reused as fresh acknowledgement authority',async()=>{
    const d=await create('authority-settled'),pin=await grant(d);await transfers.finish(pin.operationId,'pinned');
    await assert.rejects(packages.acknowledge(d,fixture.package,pin.operationId),{status:409});assert.equal(await packages.get(d),undefined);
    const fresh=await grant(d);await packages.acknowledge(d,fixture.package,fresh.operationId);
    assert.equal((await transfers.get(fresh.operationId)).state,'pinned');
  });
});
