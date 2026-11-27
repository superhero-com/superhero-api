require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Module, NotFoundException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ShortsPrivateInputCleanupControlGuard: Guard, ShortsPrivateInputCleanupControlController: Controller } = require('./shorts-private-input-cleanup-control.controller');
const { ShortsPrivateInputCleanupVerifierService: Verifier } = require('./shorts-private-input-cleanup-verifier.service');
const { ShortsStorageControlGuard, ShortsStorageControlController } = require('./shorts-storage-control.controller');
const { ShortsService } = require('./shorts.service');
const { ShortsPrivateInputCleanupClientService: Client } = require('./shorts-private-input-cleanup-client.service');
const { ShortsPrivateInputCleanupService: Operator } = require('./shorts-private-input-cleanup.service');
const { createServer } = require('node:http');
require('./testing/private-input-cleanup-batch.cjs');

function environment(t, values) {
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values)) if(value===undefined)delete process.env[key];else process.env[key]=value;
  t.after(()=>{for(const [key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}

test('private cleanup control defaults off and requires its own flag and mounted credential', async t => {
  environment(t,{SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:undefined,SHORTS_STORAGE_CONTROL_TOKEN_FILE:undefined,SHORTS_IPFS_EXPIRING_WRITES:'true'});
  await assert.rejects(new Guard().canActivate({}),{status:404});
  process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED='true';assert.throws(()=>new Guard(),/absolute/);
  process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE='relative';assert.throws(()=>new Guard(),/absolute/);
  process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED='invalid';assert.throws(()=>new Verifier(),/flag/);
});

test('HTTP cleanup verification authenticates, rotates credentials and never enables the independent pin routes', async t => {
  const directory=await mkdtemp(join(tmpdir(),'shorts-cleanup-control-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'key'), key=randomBytes(32).toString('hex');await writeFile(file,key,{mode:0o600});
  environment(t,{SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:'true',SHORTS_STORAGE_CONTROL_TOKEN_FILE:file,SHORTS_IPFS_EXPIRING_WRITES:undefined});
  const operation=randomUUID(), verification=randomUUID(), calls=[];let available=true;
  const verifier={verify:async(op,id)=>{if(!available||op!==operation)throw new NotFoundException();calls.push([op,id]);
    return {id,operation_id:op,verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+30000).toISOString()};},
    verifyMany:async rows=>rows.map(row=>({id:row.verificationId,operation_id:row.operationId,verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+30000).toISOString()}))};
  class FixtureModule {}
  Module({controllers:[Controller,ShortsStorageControlController],providers:[Guard,ShortsStorageControlGuard,
    {provide:Verifier,useValue:verifier},{provide:ShortsService,useValue:{}}]})(FixtureModule);
  const app=await NestFactory.create(FixtureModule,{logger:false});await app.listen(0,'127.0.0.1');t.after(()=>app.close());
  const root=await app.getUrl(), path=`/shorts/internal/private-input-cleanup/${operation}/verify`;
  const request=async(body={verificationId:verification},headers={Authorization:`Bearer ${key}`},route=path)=>{
    const result=await fetch(root+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:result.status,value:await result.json()};
  };
  for(const headers of [{},{Authorization:'Bearer bad'},{Authorization:`Bearer ${'0'.repeat(64)}`},{Authorization:`Bearer ${key}`,Origin:'https://browser.example'}])
    assert.equal((await request(undefined,headers)).status,401);
  for(const body of [{},{verificationId:[verification]},{verificationId:'bad'},{verificationId:verification,extra:true},[]])
    assert.equal((await request(body)).status,404);
  assert.deepEqual(calls,[]);
  const result=await request();assert.equal(result.status,200);assert.equal(result.value.id,verification);
  assert.deepEqual(Object.keys(result.value).sort(),['expires_at','id','operation_id','verified_at']);
  assert.equal((await request(undefined,undefined,'/shorts/internal/storage/short/pins')).status,404);
  available=false;assert.equal((await request()).status,404);available=true;
  const rotated=randomBytes(32).toString('hex');await writeFile(file,rotated,{mode:0o600});
  assert.equal((await request()).status,401);
  assert.equal((await request(undefined,{Authorization:`Bearer ${rotated}`})).status,200);
  assert.equal(calls.length,2);
  const batchRoute='/shorts/internal/private-input-cleanup/verify-batch',headers={Authorization:`Bearer ${rotated}`};
  const operations=[{operationId:operation,verificationId:verification},{operationId:randomUUID(),verificationId:randomUUID()}];
  assert.equal((await request({operations},headers,batchRoute)).value.proofs.length,2);
  assert.equal((await request({operations},{},batchRoute)).status,401);
  for(const body of [{operations:[]},{operations:Array.from({length:129},()=>({operationId:randomUUID(),verificationId:randomUUID()}))},
    {operations:[operations[0],operations[0]]},{operations:[operations[0],{...operations[1],verificationId:verification}]},
    {operations:[{...operations[0],extra:1}]},{operations,extra:1}])assert.equal((await request(body,headers,batchRoute)).status,404);
});

test('cleanup verification bounds concurrent media proofs and drains them on cancellation and shutdown', async t => {
  environment(t,{SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED:'true'});
  const scope={network:'ae_uat',contract:'ct_cleanup'};let started=0,ready;
  const entered=new Promise(resolve=>{ready=resolve;});
  const shorts={chain:{release:scope,state:{contract:scope.contract}},ensurePlayable:async()=>({id:'short'})};
  const media={verifyDurableDelivery:async(_record,_descriptor,_prepared,signal)=>{
    if(++started===2)ready();await new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);
    });
  }};
  const journal={snapshot:async()=>({records:[{shortId:'short',sourceKey:'a'.repeat(64),durabilityHash:'b'.repeat(64),record:{}}]}),verified:async()=>assert.fail('cancelled verification cannot commit')};
  const service=new Verifier(shorts,media,{acknowledged:async()=>({})},journal), parent=new AbortController();
  const first=assert.rejects(service.verify(randomUUID(),randomUUID(),parent.signal),{name:'AbortError'}),
    second=assert.rejects(service.verify(randomUUID(),randomUUID()),{name:'AbortError'});
  await entered;await assert.rejects(service.verify(randomUUID(),randomUUID()),{status:503});
  parent.abort();await first;await service.onModuleDestroy();await second;
  await assert.rejects(service.verify(randomUUID(),randomUUID()),{status:503});assert.equal(started,2);
});

test('operator HTTP client bounds responses, rejects redirects and wrong proofs, and rotates its mounted token', async t => {
  const directory=await mkdtemp(join(tmpdir(),'shorts-cleanup-client-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'key');let key=randomBytes(32).toString('hex');await writeFile(file,key,{mode:0o600});
  const operation=randomUUID(),verification=randomUUID();let mode='ok',requests=0,redirects=0;
  const batchRequests=[{operationId:operation,verificationId:verification},{operationId:randomUUID(),verificationId:randomUUID()}];
  const server=createServer(async(req,res)=>{
    requests++;
    if(req.url==='/redirect'){redirects++;res.end('{}');return;}
    if(req.headers.authorization!==`Bearer ${key}`){res.writeHead(401).end();return;}
    const batch=req.url==='/api/shorts/internal/private-input-cleanup/verify-batch';
    if(!batch)assert.equal(req.url,`/api/shorts/internal/private-input-cleanup/${operation}/verify`);assert.equal(req.method,'POST');
    const parts=[];for await(const part of req)parts.push(part);
    assert.deepEqual(JSON.parse(Buffer.concat(parts).toString()),batch?{operations:batchRequests}:{verificationId:verification});
    if(batch){
      if(mode==='batch-large'){res.end(' '.repeat(65537));return;}
      const now=new Date(),proofs=batchRequests.map(row=>({id:row.verificationId,operation_id:row.operationId,verified_at:now.toISOString(),expires_at:new Date(+now+30000).toISOString()}));
      if(mode==='batch-duplicate')proofs[1]=proofs[0];if(mode==='batch-foreign')proofs[1].operation_id=randomUUID();
      if(mode==='batch-missing')proofs.pop();if(mode==='batch-reverse')proofs.reverse();
      res.end(JSON.stringify({proofs,...(mode==='batch-extra'?{extra:true}:{})}));return;
    }
    if(mode==='redirect'){res.writeHead(307,{Location:'/redirect'}).end();return;}
    if(mode==='error'){res.writeHead(500).end('private provider details');return;}
    if(mode==='large'){res.end(' '.repeat(4097));return;}
    if(mode==='invalid'){res.end('{"credential":');return;}
    const proof={id:verification,operation_id:operation,verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+30000).toISOString()};
    // Use the same instant even at a millisecond boundary.
    proof.expires_at=new Date(Date.parse(proof.verified_at)+30000).toISOString();
    if(mode==='identity')proof.id=randomUUID();if(mode==='expiry')proof.expires_at=proof.verified_at;if(mode==='extra')proof.private='not-allowed';
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(proof));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  environment(t,{SHORTS_STORAGE_CONTROL_URL:endpoint,SHORTS_STORAGE_CONTROL_TOKEN_FILE:file,NODE_ENV:'test'});
  const client=new Client(),signal=new AbortController().signal;
  assert.deepEqual(await client.verify(operation,verification,signal),{id:verification});
  key=randomBytes(32).toString('hex');await writeFile(file,key,{mode:0o600});assert.deepEqual(await client.verify(operation,verification,signal),{id:verification});
  for(const value of ['redirect','error','large','invalid','identity','expiry','extra']){
    mode=value;await assert.rejects(client.verify(operation,verification,signal));
  }
  mode='batch-reverse';assert.deepEqual(await client.verifyMany(batchRequests,signal),batchRequests.map(row=>({id:row.verificationId})));
  for(const value of ['batch-duplicate','batch-foreign','batch-missing','batch-large','batch-extra']){
    mode=value;await assert.rejects(client.verifyMany(batchRequests,signal));
  }
  assert.equal(redirects,0);const before=requests;
  await assert.rejects(client.verify(operation,verification,AbortSignal.abort()),{name:'AbortError'});
  await assert.rejects(client.verify('../escape',verification,signal));assert.equal(requests,before);
  for(const value of ['http://remote.example','https://user@example.com','https://example.com/api','https://example.com?x=1']){
    process.env.SHORTS_STORAGE_CONTROL_URL=value;assert.throws(()=>new Client());
  }
  process.env.SHORTS_STORAGE_CONTROL_URL=endpoint;process.env.NODE_ENV='production';assert.throws(()=>new Client());
});

test('operator bounds in-flight recovery and drains cancellation without recording a false removal', async t => {
  environment(t,{SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED:undefined});
  const scope={network:'ae_uat',contract:'ct_cleanup'},config={scope,sourceHash:'a'.repeat(64),storageId:'b'.repeat(64),objectPrefix:'private/scope/'};
  const operation={storage_id:config.storageId,source_hash:config.sourceHash,object_key:'private/scope/short/part',version_id:'version',bytes:1,key_id:'key',sha256:'c'.repeat(64),removed:false};
  let ready;const entered=new Promise(resolve=>{ready=resolve;});
  const journal={get:async()=>({operation,attempts:[{id:randomUUID()}],outcomes:[]}),outcome:async()=>assert.fail('cancelled observation cannot report removal')};
  const storage={absent:async(_scope,_ref,_version,signal)=>{ready();await new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);
  });},remove:async()=>assert.fail('disabled operator cannot delete')};
  const service=new Operator({},config,journal,storage,{}),id=randomUUID();
  await assert.rejects(service.reclaim(id,randomUUID(),randomUUID(),'d'.repeat(64)),/disabled/);
  const recovery=assert.rejects(service.recover(id),{name:'AbortError'});await entered;
  await assert.rejects(service.recover(id),/busy or stopped/);await service.onModuleDestroy();await recovery;
  await assert.rejects(service.recover(id),/busy or stopped/);
  process.env.SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED='invalid';assert.throws(()=>new Operator(),/flag/);
});
