const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {ShortsPrivateInputCleanupVerifierService:Verifier}=require('../shorts-private-input-cleanup-verifier.service');
const {privateCleanupVerifications,privateCleanupCandidates}=require('../shorts-private-cleanup-batch');
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const requests=count=>Array.from({length:count},()=>({operationId:randomUUID(),verificationId:randomUUID()}));
const scope={network:'ae_uat',contract:'ct_batch'};
function fixture(t,rootFor) {
  const old=process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED;process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED='true';
  t.after(()=>{if(old===undefined)delete process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED;else process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED=old;});
  const state={reads:0,media:[],commits:[]};
  const shorts={chain:{release:scope,state:{contract:scope.contract}},ensurePlayable:async()=>({id:'short'})};
  const journal={snapshot:async(_scope,id)=>({operationId:id,scope,stateHash:hash(id),observedAt:new Date().toISOString(),records:rootFor(state.reads++)}),
    verified:async(_scope,_id,verificationId,snapshot)=>{state.commits.push([{verificationId,snapshot}]);return{id:verificationId};},
    verifiedBatch:async(_scope,proofs)=>{state.commits.push(proofs);return proofs.map(proof=>({id:proof.verificationId}));}};
  const media={verifyDurableDelivery:async(record,_descriptor,_prepared,signal)=>{signal.throwIfAborted();state.media.push(record.id);if(state.fail)throw new Error('unavailable media');}};
  const verifier=new Verifier(shorts,media,{acknowledged:async()=>({descriptor:{},prepared:{}})},journal);t.after(()=>verifier.onModuleDestroy());
  return {verifier,state,journal};
}
test('a full batch retains one shared media root and compact per-operation proofs without caching across runs',async t=>{
  const input=requests(128), originalIds=input.map(row=>row.operationId);
  const {verifier,state,journal}=fixture(t,()=>[{shortId:'short',resourceId:'short',sourceKey:hash('source'),rootHash:hash('private'),durabilityHash:hash('durable'),record:{id:'short',payload:'x'.repeat(524288)}}]);
  let release;const gate=new Promise(resolve=>{release=resolve;}),snapshot=journal.snapshot;
  journal.snapshot=async(...args)=>{await gate;return snapshot(...args);};
  const running=verifier.verifyMany(input);input[0].operationId=randomUUID();release();
  assert.equal((await running).length,128);assert.equal(state.reads,128);assert.deepEqual(state.media,['short']);
  const proofs=state.commits[0];assert.deepEqual(proofs.map(row=>row.snapshot.operationId),originalIds);
  assert.ok(JSON.stringify(proofs).length<65536);assert.ok(proofs.every(row=>!Object.hasOwn(row.snapshot,'records')));
  await verifier.verifyMany(originalIds.map(operationId=>({operationId,verificationId:randomUUID()})));
  assert.deepEqual(state.media,['short','short']);assert.equal(state.commits.length,2);
});
test('distinct immutable media identities are never merged, and a failed shared check commits no batch',async t=>{
  const {verifier,state}=fixture(t,index=>[{shortId:'short',sourceKey:hash('source'),durabilityHash:hash(index%2),record:{id:'root-'+index%2}}]);
  await verifier.verifyMany(requests(4));assert.deepEqual(state.media,['root-0','root-1']);
  state.fail=true;await assert.rejects(verifier.verifyMany(requests(2)),/unavailable media/);assert.equal(state.commits.length,1);
});
test('verification bounds unique roots and retained metadata before media I/O',async t=>{
  let largeCount=false;
  const f=fixture(t,index=>largeCount?Array.from({length:257},(_,i)=>({shortId:'short',durabilityHash:hash(i),record:{id:'root'}})):[{shortId:'short',sourceKey:hash('source'),durabilityHash:hash(index),record:{id:'root',payload:'x'.repeat(1048576)}}]);
  await assert.rejects(f.verifier.verifyMany(requests(17)),/too large/);assert.deepEqual(f.state.media,[]);assert.deepEqual(f.state.commits,[]);
  largeCount=true;await assert.rejects(f.verifier.verifyMany(requests(1)),/too large/);assert.deepEqual(f.state.media,[]);
});
test('invalid or duplicated batch identities are rejected before any snapshots or media work',async t=>{
  const {verifier,state}=fixture(t,()=>assert.fail('invalid request must not read SQL'));
  const duplicate=requests(1)[0];
  for(const value of [null,[],requests(129),[duplicate,duplicate],[duplicate,{operationId:randomUUID(),verificationId:duplicate.verificationId}],
    [{...duplicate,unexpected:true}],[{...duplicate,operationId:'bad'}]]) await assert.rejects(verifier.verifyMany(value));
  await assert.rejects(verifier.verifyMany(requests(1),AbortSignal.abort()),{name:'AbortError'});assert.equal(state.reads,0);
  const candidate={id:randomUUID(),barrier:randomUUID(),inventory:randomUUID(),identity:hash('version')};
  for(const value of [[],[candidate,candidate],[{...candidate,identity:'bad'}],[{...candidate,extra:1}]])assert.throws(()=>privateCleanupCandidates(value));
  const copied=privateCleanupCandidates([candidate]);candidate.id=randomUUID();assert.notEqual(copied[0].id,candidate.id);
  assert.equal(privateCleanupVerifications(requests(128)).length,128);
});
