require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ShortsMediaService } = require('./shorts-media.service');
const cid='bafkreie4eiks377hueamwhk5oczazugpqbjhkz7l2ijhgp6d4awskiauay';

function harness(t, options={}) {
  const previous=process.env.SHORTS_IPFS_EXPIRING_WRITES;
  process.env.SHORTS_IPFS_EXPIRING_WRITES='true';
  t.after(()=>{if(previous===undefined)delete process.env.SHORTS_IPFS_EXPIRING_WRITES;else process.env.SHORTS_IPFS_EXPIRING_WRITES=previous;});
  const requests=[], transitions=[], intents=[];
  const ledger={begin:async(scope,binding)=>{
    const value={...scope,...binding,operationId:randomUUID(),state:'issued',issuedAt:new Date().toISOString(),expires:Date.now()+180000,...options.intent};
    intents.push(value);return value;
  },bind:async(operation,storage)=>{
    assert.equal(operation,intents[0].operationId);assert.equal(requests.length,1,'binding must precede import');
    if(options.bindFailure)throw new Error('binding unavailable');
    intents[0].storage={...storage,boundAt:new Date().toISOString()};return {...intents[0],...options.bound};
  },finish:async(operation,state)=>{
    transitions.push({operation,state});
    if(options.metadataFailure)throw new Error('database unavailable after import');
    return {...intents[0],state};
  }};
  const records={shared:true,chain:{state:{contract:'ct_protocol'},release:{network:'ae_uat',contract:'ct_protocol'}}};
  const media=new ShortsMediaService({},undefined,records,undefined,undefined,ledger);
  media.ipfsFetch=async(path,init)=>{
    requests.push({path,init});
    if(path==='shorts/capabilities')return new Response(JSON.stringify({epochVersion:1,nodeEpoch:'e'.repeat(64),peerId:'a'.repeat(52),writing:false,uncertain:false,version:1,addVersion:1,addMaxLifetimeMs:300000,
      addTimeoutMs:120000,legacyWritesEnabled:false,serverTimeUnixMs:Date.now(),...options.caps}),{status:options.capStatus??200});
    assert.ok(path.startsWith('shorts/add?'),'must never fall back to an unfenced import');
    if(options.networkFailure)throw new Error('connection reset after dispatch');
    if(options.upload)await options.upload(init);
    if(options.body)return new Response(options.body);
    return new Response(JSON.stringify({version:1,cid,operation:intents[0].operationId,expires:intents[0].expires,
      status:'pinned',epoch:'e'.repeat(64),...options.receipt}),{status:options.status??200});
  };
  const form=new FormData();form.append('file',new Blob(['exact original bytes']),'original.mov');
  const controller=new AbortController();
  const run=()=>media.addWithIntent(form,false,{id:'original_job'},cid,'original',controller.signal);
  return {media,run,requests,transitions,intents,controller};
}

test('IPFS pin authority binds original bytes and receipt before recording success',async t=>{
  const h=harness(t);assert.equal(await h.run(),cid);
  assert.equal(h.intents[0].cid,cid);assert.equal(h.intents[0].jobId,'original_job');
  assert.equal(h.intents[0].purpose,'original');assert.equal(h.intents[0].network,'ae_uat');
  const upload=h.requests[1],query=new URL('http://fixture/'+upload.path).searchParams;
  assert.equal(query.get('epoch'),'e'.repeat(64));assert.equal(h.intents[0].storage.epoch,query.get('epoch'));
  assert.equal(query.get('expected'),cid);assert.equal(query.get('operation'),h.intents[0].operationId);
  assert.equal(query.get('expires'),String(h.intents[0].expires));assert.equal(query.get('wrap-with-directory'),'false');
  assert.equal(query.get('raw-leaves'),'true');
      assert.equal(query.get('hash'), 'sha2-256');
      assert.equal(query.get('max-file-links'), '174');
      assert.equal(query.get('trickle'), 'false');
      assert.equal(query.get('max-directory-links'), '0');
      assert.equal(query.get('max-hamt-fanout'), '256');assert.equal(query.get('chunker'),'size-262144');
  assert.equal(await upload.init.body.get('file').text(),'exact original bytes');
  assert.deepEqual(h.transitions,[{operation:h.intents[0].operationId,state:'pinned'}]);
});

test('unsupported storage, unsynchronized clocks and expired intents never dispatch an import',async t=>{
  for(const options of [{capStatus:503},{caps:{addVersion:2}},{caps:{legacyWritesEnabled:undefined}},
    {caps:{serverTimeUnixMs:Date.now()+60000}},{intent:{issuedAt:new Date(Date.now()-60000).toISOString()}},
    {intent:{expires:Date.now()-1000}},{caps:{addMaxLifetimeMs:600000}},{caps:{epochVersion:2}},{caps:{nodeEpoch:''}},{caps:{peerId:''}},
    {caps:{writing:true}},{caps:{uncertain:true}},{bindFailure:true},{bound:{state:'pinned'}}]){
    await t.test(JSON.stringify(options),async t=>{
      const h=harness(t,options);await assert.rejects(h.run());
      assert.equal(h.requests.filter(r=>r.path.startsWith('shorts/add')).length,0);
      assert.equal(h.transitions.at(-1).state,'rejected');
    });
  }
});

test('an ambiguous importer or mismatched acknowledgement stays quarantined',async t=>{
  for(const options of [{networkFailure:true},{status:503},{body:'not JSON'},
    {body:' '.repeat(2049)},{receipt:{cid:'bafywrong'}},{receipt:{operation:randomUUID()}},
    {receipt:{expires:1}},{receipt:{status:'removed'}},{receipt:{epoch:'f'.repeat(64)}}]){
    await t.test(JSON.stringify(options).slice(0,80),async t=>{
      const h=harness(t,options);await assert.rejects(h.run());
      assert.equal(h.requests.length,2);assert.equal(h.transitions.at(-1).state,'uncertain');
    });
  }
});

test('known pre-import refusal records rejection without discarding its replay barrier',async t=>{
  for(const status of [400,409,413,422,429])await t.test(String(status),async t=>{
    const h=harness(t,{status});await assert.rejects(h.run());
    assert.equal(h.transitions.at(-1).state,'rejected');
  });
});

test('shutdown or database failure after dispatch cannot report a successful pin',async t=>{
  await t.test('caller cancels before acknowledgement',async t=>{
    let h;h=harness(t,{upload:async()=>h.controller.abort()});
    await assert.rejects(h.run(),{name:'AbortError'});assert.equal(h.transitions.at(-1).state,'uncertain');
  });
  await t.test('database acknowledgement disappears',async t=>{
    const h=harness(t,{metadataFailure:true});await assert.rejects(h.run(),/database unavailable/);
    assert.deepEqual(h.transitions.map(x=>x.state),['pinned','uncertain']);
  });
});

test('expiring write configuration rejects misspellings and requires shared metadata',async t=>{
  const previous=process.env.SHORTS_IPFS_EXPIRING_WRITES;
  t.after(()=>{if(previous===undefined)delete process.env.SHORTS_IPFS_EXPIRING_WRITES;else process.env.SHORTS_IPFS_EXPIRING_WRITES=previous;});
  process.env.SHORTS_IPFS_EXPIRING_WRITES='1';assert.throws(()=>new ShortsMediaService({}),/Invalid expiring/);
  process.env.SHORTS_IPFS_EXPIRING_WRITES='true';const media=new ShortsMediaService({});
  await assert.rejects(media.addWithIntent(new FormData(),false,{id:'post'},cid,'original',new AbortController().signal),/metadata unavailable/);
});

test('delegated pin receipts bind every request and only verified definite refusals release an issued write', async t => {
  const { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os'); const { join } = require('node:path');
  const { ShortsMediaTransferClientService } = require('./shorts-media-transfer-client.service');
  const { pinTransferProof } = require('./shorts-transfer-protocol');
  const { originalRecord } = require('./testing/original-record.cjs');
  const local = await mkdtemp(join(tmpdir(),'shorts-pin-client-')), keyFile = join(local,'key');
  const env={...process.env}, oldFetch=global.fetch, key='ac'.repeat(32);
  t.after(async()=>{process.env=env;global.fetch=oldFetch;await rm(local,{recursive:true,force:true});});
  delete process.env.SHORTS_MEDIA_TRANSFER_URL;
  assert.equal(new ShortsMediaTransferClientService().enabled,false);
  Object.assign(process.env,{NODE_ENV:'test',SHORTS_MEDIA_TRANSFER_URL:'http://127.0.0.1:8899',SHORTS_MEDIA_TRANSFER_KEY_FILE:keyFile});
  await writeFile(keyFile,key,{mode:0o600}); const service=new ShortsMediaTransferClientService();
  const short=originalRecord(),scope={network:'ae_uat',contract:'ct_fixture'},sourceHash='a'.repeat(64);
  const grant={mode:'expiring',operation:randomUUID(),epoch:'c'.repeat(64),peerId:'Qm'+'a'.repeat(44),expires:Date.now()+30000};
  short.creator='ak_creator';short.privateMedia={version:1,fence:short.derivatives.generation.fence,source:{bytes:short.bytes,sha256:short.original.sha256,
    processingProfile:short.derivatives.profile,objectKey:'manifest-key',manifest:{key:'manifest-key'},details:{private:'unused'}},files:{}};
  let response, rejected=0, last, lastRequest;
  global.fetch=async (url,init)=>{
    assert.equal(url,'http://127.0.0.1:8899/internal/media/pin'); assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+key);
    const req=JSON.parse(init.body);assert.equal(req.sourceHash,sourceHash);assert.equal(req.descriptor.network,scope.network);
    assert.equal(req.descriptor.derivatives.generation.job,short.id);
    assert.equal(init.body.includes('unused'),false);lastRequest=req;
    return response(init.body);
  };
  const transfer=g=>service.transfer(scope,sourceHash,short,'original',g,new AbortController().signal,()=>{rejected++;});
  const sign=(raw,receipt)=>({version:1,cid:short.cid,receipt,proof:pinTransferProof(key,raw,short.cid,receipt)});
  const receipt={version:1,cid:short.cid,status:'pinned',epoch:grant.epoch,operation:grant.operation,expires:grant.expires};
  response=raw=>Response.json(last=sign(raw,receipt));
  assert.deepEqual(await transfer(grant),receipt);assert.ok(lastRequest.staging.manifest);assert.equal(rejected,0);
  response=()=>Response.json(last);await assert.rejects(transfer(grant),/acknowledgement mismatch/);
  response=raw=>Response.json(sign(raw,{...receipt,epoch:'f'.repeat(64)}));await assert.rejects(transfer(grant),/acknowledgement mismatch/);
  response=raw=>Response.json(sign(raw,'rejected'),{status:409});await assert.rejects(transfer(grant));assert.equal(rejected,1);
  response=raw=>Response.json({...sign(raw,'rejected'),proof:'0'.repeat(64)},{status:409});
  await assert.rejects(transfer(grant),/acknowledgement mismatch/);assert.equal(rejected,1);
  response=()=>new Response(null,{status:503});await assert.rejects(transfer(grant));assert.equal(rejected,1);
  response=raw=>Response.json(sign(raw,null));await transfer(null);assert.equal(lastRequest.staging,undefined);
});
