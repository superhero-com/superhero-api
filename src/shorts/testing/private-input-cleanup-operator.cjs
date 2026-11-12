const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ShortsPrivateInputCleanupService: Operator } = require('../shorts-private-input-cleanup.service');
const { ShortsPrivateInputCleanupClientService: Client } = require('../shorts-private-input-cleanup-client.service');
const { ShortsPrivateInputCleanupVerifierService: Verifier } = require('../shorts-private-input-cleanup-verifier.service');
const { ShortsPrivateInputCleanupControlController: Controller, ShortsPrivateInputCleanupControlGuard: Guard } = require('../shorts-private-input-cleanup-control.controller');
const { ShortsDeliverySelectionService } = require('../shorts-delivery-selection.service');

module.exports = async f => {
  const {t, owner, scope, base, target, operator, verifier, add, barrier, inventory, retention}=f;
  const directory=await mkdtemp(join(tmpdir(),'shorts-operator-'));
  const keyFile=join(directory,'key'); await writeFile(keyFile,randomBytes(32).toString('hex'),{mode:0o600});
  const keys=['SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED','SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED','SHORTS_STORAGE_CONTROL_URL','SHORTS_STORAGE_CONTROL_TOKEN_FILE','NODE_ENV'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(async()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(directory,{recursive:true,force:true});});
  process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED='true';process.env.SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED='true';
  process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE=keyFile;process.env.NODE_ENV='test';
  const [binding]=await owner.query('SELECT storage_id,source_hash FROM shorts_private_input_barriers WHERE id=$1',[barrier]);
  const config={scope,storageId:binding.storage_id,sourceHash:binding.source_hash,objectPrefix:target.key.split('/').slice(0,2).join('/')+'/'};
  const [{role}]=await operator.db.query('SELECT current_user AS role');await owner.query(`GRANT SELECT ON shorts_runtime TO ${role}`);
  let mediaReads=0, rejectMedia=false;
  const media={verifyDurableDelivery:async(_record,_descriptor,_prepared,signal)=>{signal.throwIfAborted();mediaReads++;if(rejectMedia)throw new Error('Unavailable durable media');}};
  const shorts={chain:{release:scope,state:{contract:scope.contract}},ensurePlayable:async short=>{
    assert.equal(short,base.id);return (await owner.query('SELECT body FROM shorts_content WHERE id=$1',[short]))[0].body;
  }};
  const api=new Verifier(shorts,media,new ShortsDeliverySelectionService(owner),verifier.journal);
  class FixtureModule {}
  Module({controllers:[Controller],providers:[Guard,{provide:Verifier,useValue:api}]})(FixtureModule);
  const app=await NestFactory.create(FixtureModule,{logger:false});app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');t.after(()=>app.close());
  process.env.SHORTS_STORAGE_CONTROL_URL=await app.getUrl();
  const client=new Client(), absent=new Set();let deletes=0, observations=0, failBefore=false, failAfter=false, beforeDelete;
  const storage={
    remove:async(s,ref,version,signal,issue)=>{
      assert.deepEqual(s,scope);assert.deepEqual(ref,target);signal.throwIfAborted();
      if(failBefore)throw new Error('Candidate integrity failed');
      const grant=await issue(s,ref,version);assert.equal(grant.version,version);assert.deepEqual(grant.ref,ref);
      assert.ok(grant.issuedAt instanceof Date);
      assert.ok(grant.expiresAt instanceof Date);assert.ok(grant.expiresAt-grant.issuedAt<=30000);
      if(beforeDelete)await beforeDelete();await grant.assertCurrent();deletes++;absent.add(version);
      if(failAfter)throw new Error('Provider response lost');return {key:ref.key,version,removed:true};
    },
    absent:async(s,ref,version,signal)=>{signal.throwIfAborted();assert.deepEqual(s,scope);assert.deepEqual(ref,target);observations++;return absent.has(version);},
  };
  let preparations=0;
  storage.prepare=async(...args)=>{preparations++;if(failBefore)throw new Error('Candidate integrity failed');return issue=>storage.remove(...args,issue);};
  const construct=(journal=operator.journal,cfg=config,db=operator.db)=>{
    const service=new Operator(db,cfg,journal,storage,client);t.after(()=>service.onModuleDestroy());return service;
  };
  const service=construct();await service.verify();
  await assert.rejects(construct(operator.journal,config,owner).verify(),/restricted/);
  await assert.rejects(construct(operator.journal,{...config,sourceHash:'f'.repeat(64)}).verify(),/deployment/);
  await owner.query(`GRANT INSERT ON shorts_private_input_verifications TO ${role}`);
  try {await assert.rejects(service.verify(),/grants/);}finally{await owner.query(`REVOKE INSERT ON shorts_private_input_verifications FROM ${role}`);}
  await owner.query(`GRANT UPDATE (body) ON shorts_content TO ${role}`);
  try {await assert.rejects(service.verify(),/grants/);}finally{await owner.query(`REVOKE UPDATE (body) ON shorts_content FROM ${role}`);}

  await t.test('success uses API proofs, freezes the version and is idempotent without repeating media or deletion',async()=>{
    const item=await add('operator-success');
    const result=await service.reclaim(item.id,barrier,inventory,item.identity);
    assert.equal(result.operation.removed,true);assert.equal(result.attempts.length,1);assert.equal(deletes,1);assert.equal(mediaReads,2);
    assert.deepEqual(result.outcomes.map(row=>row.kind),['removed']);
    const hold=randomUUID();await retention.hold({id:hold,resourceId:base.id,reason:'legal',reference:'after-removal'});
    try {assert.deepEqual(await service.reclaim(item.id,barrier,inventory,item.identity),result);}finally{await retention.release(hold);}
    assert.equal(deletes,1);assert.equal(mediaReads,2);
    await assert.rejects(service.reclaim(item.id,barrier,inventory,'e'.repeat(64)),{status:409});
    await assert.rejects(construct(operator.journal,{...config,storageId:'e'.repeat(64)}).status(item.id),{status:409});
  });
  await t.test('failed candidate or durable media cannot issue a deletion, and absence without issuance cannot settle it',async()=>{
    const item=await add('operator-integrity');failBefore=true;
    await assert.rejects(service.reclaim(item.id,barrier,inventory,item.identity),/integrity/);failBefore=false;
    assert.equal((await service.status(item.id)).attempts.length,0);const reads=observations;
    assert.equal((await service.recover(item.id)).operation.removed,false);assert.equal(observations,reads);
    rejectMedia=true;try{await assert.rejects(service.reclaim(item.id,barrier,inventory,item.identity),/verification unavailable/);}finally{rejectMedia=false;}
    assert.equal((await service.status(item.id)).attempts.length,0);assert.equal(deletes,1);
  });
  await t.test('lost provider response survives restart and can be observed with deletion disabled and a later hold',async()=>{
    const item=await add('operator-lost');failAfter=true;
    try{await assert.rejects(service.reclaim(item.id,barrier,inventory,item.identity),/response lost/);}finally{failAfter=false;}
    const saved=await service.status(item.id);assert.equal(saved.operation.removed,false);assert.deepEqual(saved.outcomes.map(row=>row.kind),['uncertain']);
    const calls=mediaReads,removed=deletes;
    process.env.SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED='false';const restarted=construct();process.env.SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED='true';
    await assert.rejects(restarted.reclaim(item.id,barrier,inventory,item.identity),/disabled/);
    const hold=randomUUID();await retention.hold({id:hold,resourceId:base.id,reason:'safety',reference:'after-issued'});
    try{const result=await restarted.recover(item.id);assert.equal(result.operation.removed,true);assert.deepEqual(result.outcomes.map(row=>row.kind),['uncertain','removed']);}
    finally{await retention.release(hold);}
    assert.equal(mediaReads,calls);assert.equal(deletes,removed);
  });
  await t.test('a hold after issuance blocks dispatch without losing the attempt history',async()=>{
    const item=await add('operator-held'),hold=randomUUID(),removed=deletes;
    beforeDelete=()=>retention.hold({id:hold,resourceId:base.id,reason:'legal',reference:'before-dispatch'});
    try{await assert.rejects(service.reclaim(item.id,barrier,inventory,item.identity),/retained/);}
    finally{beforeDelete=undefined;await retention.release(hold);}
    const saved=await service.status(item.id);assert.equal(saved.attempts.length,1);assert.equal(saved.operation.removed,false);
    assert.deepEqual(saved.outcomes.map(row=>row.kind),['uncertain']);assert.equal(deletes,removed);
    assert.equal((await construct().recover(item.id)).operation.removed,false);
  });
  await t.test('lost issuance acknowledgement never dispatches and recovery retains its saved uncertainty',async()=>{
    const item=await add('operator-issue'),removed=deletes;
    const journal=new Proxy(operator.journal,{get:(target,key)=>key==='issue'?async(...args)=>{
      await target.issue(...args);throw new Error('Issue response lost');
    }:typeof target[key]==='function'?target[key].bind(target):target[key]});
    await assert.rejects(construct(journal).reclaim(item.id,barrier,inventory,item.identity),/Issue response lost/);
    const saved=await service.status(item.id);assert.equal(saved.attempts.length,1);assert.deepEqual(saved.outcomes.map(row=>row.kind),['uncertain']);
    assert.equal(deletes,removed);assert.equal((await service.recover(item.id)).operation.removed,false);
  });
  const batch=async(label,count)=>{
    const result=[];for(let i=0;i<count;i++)result.push({...await add(label+'-'+i),barrier,inventory});return result;
  };
  await t.test('a 96-version batch checks its two shared media roots once and commits proofs with one fixed expiry',async()=>{
    const items=await batch('operator-batch',96),reads=mediaReads,removed=deletes,prepared=preparations;
    const result=await service.reclaimMany(items);
    assert.equal(result.length,96);assert.ok(result.every(row=>row.operation.removed));
    assert.equal(mediaReads-reads,2);assert.equal(deletes-removed,96);assert.equal(preparations-prepared,96);
    const proofs=await owner.query('SELECT verified_at,expires_at FROM shorts_private_input_verifications WHERE operation_id=ANY($1::uuid[])',[items.map(item=>item.id)]);
    assert.equal(proofs.length,96);assert.equal(new Set(proofs.map(proof=>proof.verified_at.toISOString())).size,1);
    assert.equal(new Set(proofs.map(proof=>proof.expires_at.toISOString())).size,1);
    assert.ok(proofs.every(proof=>proof.expires_at-proof.verified_at===30000));
    const calls=mediaReads,removals=deletes,ready=preparations;
    assert.deepEqual(await service.reclaimMany(items),result);
    assert.equal(mediaReads,calls);assert.equal(deletes,removals);assert.equal(preparations,ready);
  });
  await t.test('an interrupted batch never retries deletion and resumes only the remaining exact versions',async()=>{
    const items=await batch('operator-batch-lost',3),removed=deletes,reads=mediaReads;
    failAfter=true;try{await assert.rejects(service.reclaimMany(items),/response lost/);}finally{failAfter=false;}
    assert.equal(deletes-removed,1);assert.equal((await service.status(items[0].id)).operation.removed,false);
    assert.equal((await service.status(items[1].id)).attempts.length,0);
    const result=await construct().reclaimMany(items);assert.ok(result.every(row=>row.operation.removed));
    assert.equal(deletes-removed,3);assert.equal(mediaReads-reads,4);
  });
  await t.test('expired remaining proofs stop a batch; retry obtains fresh verification without renewing the old proof',async()=>{
    const items=await batch('operator-batch-expiry',2),removed=deletes,reads=mediaReads;
    beforeDelete=async()=>{
      beforeDelete=undefined;
      await owner.transaction(async db=>{
        await db.query('ALTER TABLE shorts_private_input_verifications DISABLE TRIGGER shorts_private_cleanup_journal');
        await db.query("UPDATE shorts_private_input_verifications SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[items[1].id]);
        await db.query('ALTER TABLE shorts_private_input_verifications ENABLE TRIGGER shorts_private_cleanup_journal');
      });
    };
    await assert.rejects(service.reclaimMany(items),/changed or expired/);assert.equal(deletes-removed,1);
    const [expired]=await owner.query('SELECT id,expires_at FROM shorts_private_input_verifications WHERE operation_id=$1',[items[1].id]);
    assert.ok((await service.reclaimMany(items)).every(row=>row.operation.removed));assert.equal(deletes-removed,2);assert.equal(mediaReads-reads,4);
    const [same]=await owner.query('SELECT expires_at FROM shorts_private_input_verifications WHERE id=$1',[expired.id]);assert.equal(+same.expires_at,+expired.expires_at);
    assert.equal((await owner.query('SELECT count(*)::int n FROM shorts_private_input_verifications WHERE operation_id=$1',[items[1].id]))[0].n,2);
  });
};
