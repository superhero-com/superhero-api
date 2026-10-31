require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { mkdtemp, writeFile, chmod, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const Redis = require('ioredis');
const { NestFactory } = require('@nestjs/core');
const { UnauthorizedException, ForbiddenException } = require('@nestjs/common');
const { shortsClientIdentity, shortsRateConfig, SHORTS_RATE_CONFIG } = require('./shorts-rate.config');
const { ShortsRateService } = require('./shorts-rate.service');
const { ShortsRateGuard } = require('./shorts-rate.guard');
const { SHORTS_HTTP_POLICY, SHORTS_RATE_GROUPS } = require('./shorts-rate-policy');
const { ShortsController } = require('./shorts.controller');
const { ShortsWalletTransactionsService } = require('./shorts-wallet-transactions.service');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsAuthGuard } = require('./shorts-auth.guard');
const { ShortsService } = require('./shorts.service');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const { ShortsChainService } = require('./shorts-chain.service');
const { ShortsUploadAdmissionService } = require('./shorts-upload-admission.service');
function request(peer, forwarded, ip='forged-express-ip') {
  return { socket: {remoteAddress:peer}, headers: forwarded === undefined ? {} : {'x-forwarded-for':forwarded}, ip };
}
function execution(name, req = request('127.0.0.1')) {
  const headers={};
  return { headers, getHandler: () => ({name}), switchToHttp: () => ({getRequest:()=>req,getResponse:()=>({setHeader:(key,value)=>headers[key]=value})}) };
}

test('Shorts identifies clients through explicit proxy addresses and groups IPv6 privacy addresses', () => {
  for (const raw of ['true','1','2','-1','loopback','0.0.0.0/0','::/0','10.0.0.1/33','::1/129','10.0.0.1/2/3','not-an-ip','127.0.0.1,'])
    assert.throws(()=>shortsClientIdentity(raw), /TRUST_PROXY/);
  for (const raw of [undefined,'','false','0']) {
    const client=shortsClientIdentity(raw);
    assert.equal(client(request('192.0.2.1','203.0.113.1')), 'v4:192.0.2.1');
    assert.equal(client(request('::ffff:192.0.2.1',['broken'])), 'v4:192.0.2.1');
  }
  const client=shortsClientIdentity('127.0.0.1/32,10.10.0.1/32');
  assert.equal(client(request('127.0.0.1','203.0.113.99, 192.0.2.1, 10.10.0.1')), 'v4:192.0.2.1');
  assert.equal(client(request('10.10.0.2','203.0.113.99')), 'v4:10.10.0.2');
  assert.equal(client(request('::ffff:127.0.0.1','::ffff:c000:201')), 'v4:192.0.2.1');
  assert.equal(client(request('127.0.0.1','2001:db8:1:2::1')),client(request('127.0.0.1','2001:0db8:0001:0002:ffff:ffff:ffff:ffff')));
  assert.notEqual(client(request('127.0.0.1','2001:db8:1:2::1')),client(request('127.0.0.1','2001:db8:1:3::1')));
  for (const malformed of ['forged','010.0.0.1','fe80::1%zone','1.2.3.4:443',Array(17).fill('192.0.2.1').join(','),['192.0.2.1']])
    assert.throws(()=>client(request('127.0.0.1',malformed)), {status:400});
});

test('IPv6 proxy CIDRs cannot turn untrusted IPv4 peers into trusted forwarding hops', () => {
  for (const cidr of ['::/1', '::ffff:10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const client = shortsClientIdentity(cidr);
    for (const peer of ['198.51.100.25', '::ffff:198.51.100.25'])
      assert.equal(client(request(peer, '203.0.113.99')), 'v4:198.51.100.25');
  }
  const client = shortsClientIdentity('::ffff:10.0.0.0/104');
  assert.equal(client(request('10.1.2.3', '203.0.113.99')), 'v4:203.0.113.99');
  assert.equal(client(request('::ffff:10.1.2.3', '203.0.113.99')), 'v4:203.0.113.99');
});

test('shared limiter secret is an owner-only regular file and proxy trust fails at startup', async t => {
  const dir=await mkdtemp(join(tmpdir(),'shorts-rate-key-')); const saved={...process.env};
  t.after(async()=>{process.env=saved;await rm(dir,{recursive:true,force:true});});
  process.env.TRUST_PROXY='false'; process.env.SHORTS_RATE_KEY_FILE='relative'; await assert.rejects(shortsRateConfig());
  const path=join(dir,'key');process.env.SHORTS_RATE_KEY_FILE=path;
  await writeFile(path,randomBytes(32).toString('hex'),{mode:0o600});assert.equal((await shortsRateConfig()).key.length,32);
  await chmod(path,0o644);await assert.rejects(shortsRateConfig(),/permissions/);await chmod(path,0o600);
  await writeFile(path,'invalid-secret');await assert.rejects(shortsRateConfig(),/Invalid Shorts rate key/);
  await writeFile(path,'a'.repeat(300));await assert.rejects(shortsRateConfig(),/size/);
  const linked=join(dir,'link');await symlink(path,linked);process.env.SHORTS_RATE_KEY_FILE=linked;await assert.rejects(shortsRateConfig());
  process.env.TRUST_PROXY='true';await assert.rejects(shortsRateConfig(),/TRUST_PROXY/);
});

test('all Shorts HTTP actions have policies; hosted guards cannot omit their shared provider', async()=>{
  const methods=Object.getOwnPropertyNames(ShortsController.prototype).filter(name=>name!=='constructor');
  assert.deepEqual([...Object.keys(SHORTS_HTTP_POLICY)].sort(),methods.sort());
  await assert.rejects(new ShortsRateGuard({shared:true}).canActivate(execution('feed')), {status:503});
  assert.equal(await new ShortsRateGuard({shared:false}).canActivate(execution('feed')), true);
  await assert.rejects(new ShortsRateGuard({},{}).canActivate(execution('unconfigured')), {status:503});
  const calls=[]; const rates={config:{client:()=> 'owned'}, request:async()=>calls.push('ip'),actor:async()=>calls.push('bytes')};
  const auth={authenticate:async()=>{calls.push('auth');throw new UnauthorizedException();}};
  await assert.rejects(new ShortsRateGuard(auth,rates).canActivate(execution('upload')), {status:401});
  assert.deepEqual(calls,['ip','auth']);
});

const endpoint=process.env.SHORTS_TEST_REDIS_URL;
test('two API instances share atomic request and byte budgets with safe failure and recovery', {skip:!endpoint,timeout:45000}, async t=>{
  const url=new URL(endpoint);assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.protocol,'redis:');
  assert.equal(process.env.SHORTS_TEST_REDIS_DISPOSABLE,'1','Use a disposable Redis: this suite pauses its server');
  const savedNetwork=process.env.AE_NETWORK_ID;process.env.AE_NETWORK_ID='ae_uat';
  const admin=new Redis(endpoint); const clients=[],apps=[],prefixes=[];
  const key=randomBytes(32), scope={network:'ae_uat',contract:`ct_${randomUUID().replaceAll('-','')}`,sourceHash:'a'.repeat(64)};
  const opts={host:url.hostname,port:Number(url.port)};
  const fixture=(suffix='',network='ae_uat')=>{
    const chain={release:{network,contract:scope.contract+suffix},state:{...scope,contract:scope.contract+suffix}};
    prefixes.push('shorts:rate:v1:{'+createHash('sha256').update(network+':'+chain.state.contract).digest('hex').slice(0,32)+'}:');
    const config={key,client:shortsClientIdentity('127.0.0.1/32'),redis:opts};
    const service=new ShortsRateService(config,chain); clients.push(service);return {chain,config,service};
  };
  t.after(async()=>{
    for(const app of apps)await app.close();for(const client of clients)await client.onModuleDestroy();
    // Only this test's scoped keys; the endpoint itself is an owned disposable Redis.
    for(const prefix of prefixes){const keys=await admin.keys(prefix+'*');if(keys.length)await admin.del(...keys);}
    admin.disconnect();if(savedNetwork===undefined)delete process.env.AE_NETWORK_ID;else process.env.AE_NETWORK_ID=savedNetwork;
  });
  const one=fixture(),two=fixture();await Promise.all([one.service.onApplicationBootstrap(),two.service.onApplicationBootstrap()]);
  await t.test('the same contract and client have independent limits on different release networks',async()=>{
    const main=fixture('','ae_mainnet');await main.service.onApplicationBootstrap();
    const policy={group:'auth'},ip='v4:192.0.2.96',limit=SHORTS_RATE_GROUPS.auth[0];
    await assert.rejects(main.service.request(policy,ip),{status:503});
    try {
      process.env.AE_NETWORK_ID='ae_mainnet';
      for(let i=0;i<limit;i++)await main.service.request(policy,ip);
      await assert.rejects(main.service.request(policy,ip),{status:429});
      process.env.AE_NETWORK_ID='ae_uat';
      for(let i=0;i<limit;i++)await one.service.request(policy,ip);
      await assert.rejects(two.service.request(policy,ip),{status:429});
    } finally {process.env.AE_NETWORK_ID='ae_uat';}
  });
  await t.test('racing instances cannot overspend a shared client budget; another client retains capacity',async()=>{
    const policy={group:'auth'};
    const results=await Promise.allSettled(Array.from({length:30},(_,i)=>(i%2?one:two).service.request(policy,'v4:192.0.2.1')));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,SHORTS_RATE_GROUPS.auth[0]);
    assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.getStatus()===429));
    await one.service.request(policy,'v4:192.0.2.2');
    await new Promise(resolve=>setTimeout(resolve,3100));await two.service.request(policy,'v4:192.0.2.1');
    const third=fixture('Other');await third.service.onApplicationBootstrap();await third.service.request(policy,'v4:192.0.2.1');
    const keys=await admin.keys('shorts:rate:v1:*');assert.ok(keys.length>0);
    for(const item of keys){assert.ok(!item.includes('192.0.2'));assert.ok(await admin.pttl(item)>0);}
  });
  await t.test('global exhaustion neither creates new client keys nor consumes their budget',async()=>{
    const policy={group:'health'};for(let i=0;i<120;i++)await one.service.request(policy,`client-${i}`);
    const before=await admin.dbsize();await assert.rejects(two.service.request(policy,'never-admitted'),{status:429});
    assert.equal(await admin.dbsize(),before);
  });
  await t.test('a wallet cannot multiply its byte allowance across addresses or API instances',async()=>{
    const policy={group:'uploadStart',private:true,bytes:40*1024*1024};
    await one.service.actor(policy,'ip-1','ak_owned');await two.service.actor(policy,'ip-2','ak_owned');
    await assert.rejects(one.service.actor(policy,'ip-3','ak_owned'),{status:429});
    await two.service.actor(policy,'ip-3','ak_other');
    const all=await admin.keys('shorts:rate:v1:*');assert.ok(all.every(k=>!k.includes('ak_owned')));
  });
  let touches=0;
  async function api(rate) {
    const auth={shared:true, authenticate:async token=>{
      const address={'Bearer owned-session':'ak_http','Bearer allowed-session':'ak_allowed','Bearer operator-session':'ak_operator'}[token];
      if(!address)throw new UnauthorizedException();return address;
    },operator:async token=>{if(token!=='Bearer operator-session')throw new ForbiddenException();return 'ak_operator';}};
    const app=await NestFactory.create({module:class RateHttp {},controllers:[ShortsController],providers:[
      ShortsAuthGuard,ShortsUploadInterceptor,ShortsUploadAdmissionService,
      {provide:SHORTS_RATE_CONFIG,useValue:rate.config},{provide:ShortsChainService,useValue:rate.chain},
      {provide:ShortsRateService,useValue:rate.service},{provide:ShortsAuthService,useValue:auth},
      {provide:ShortsService,useValue:{records:{shared:true},config:()=>({ready:true}),report:()=>{touches++;return {};},chain:{serial:work=>work()}}},
      {provide:ShortsUploadsService,useValue:{part:()=>{touches++;return {};},health:()=>({ready:true})}},
      {provide:ShortsWalletTransactionsService,useValue:{observe:()=>{touches++;return {status:'unknown'};}}},
    ]},{logger:false});
    // The services above are already started. Nest still owns the real guard/controller.
    rate.service.onApplicationBootstrap=async()=>{};
    apps.push(app);await app.listen(0,'127.0.0.1');return app.getUrl();
  }
  const a=await api(one),b=await api(two);
  await t.test('wallet status checks need no signing challenge and share limits across API instances and supplied identities',async()=>{
    const before=touches;
    for(let i=0;i<30;i++){
      const response=await fetch((i%2?a:b)+`/shorts/wallet-transactions/tx-${i}?address=caller-${i}&contract=contract-${i}`,{headers:{'X-Forwarded-For':'192.0.2.91'}});
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');await response.arrayBuffer();
    }
    const denied=await fetch(b+'/shorts/wallet-transactions/different?address=other&contract=other',{headers:{'X-Forwarded-For':'192.0.2.91'}});
    assert.equal(denied.status,429);assert.ok(Number(denied.headers.get('retry-after'))>0);await denied.arrayBuffer();
    assert.equal(touches-before,30,'overload must be denied before starting node work');
  });
  await t.test('real HTTP reports share limits across routes and forged body identities',async()=>{
    for(let i=0;i<6;i++){
      const result=await fetch((i%2?a:b)+`/shorts/video-${i}/report`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'192.0.2.88'},body:JSON.stringify({id:randomUUID(),reason:'spam'})});
      assert.equal(result.status,201);await result.arrayBuffer();
    }
    const result=await fetch(b+'/shorts/different-id/report',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'192.0.2.88'},body:'{}'});
    assert.equal(result.status,429);assert.ok(Number(result.headers.get('retry-after'))>0);assert.equal(result.headers.get('cache-control'),'no-store');await result.arrayBuffer();
    const result2=await fetch(a+'/shorts/config',{headers:{'X-Forwarded-For':'192.0.2.89'}});assert.equal(result2.status,200);await result2.arrayBuffer();
  });
  await t.test('unauthenticated uploads do not consume the shared authenticated-operation budget',async()=>{
    for(let i=0;i<3;i++){
      const result=await fetch(a+'/shorts/uploads/owned/parts/0',{method:'POST',headers:{Authorization:'Bearer invalid','X-Forwarded-For':'192.0.2.100','Content-Type':'multipart/form-data; boundary=owned'},body:'invalid'});
      assert.equal(result.status,401);await result.arrayBuffer();
    }
    assert.equal(await admin.exists(prefixes[0]+'global:uploadPart'),0);
  });
  await t.test('over-budget multipart is rejected before any slow body is sent',async()=>{
    const ip='v4:192.0.2.90';
    // Exhaust only the wallet media budget, using two legal full-upload reservations.
    await one.service.actor({group:'uploadStart',bytes:40*1024*1024},ip,'ak_http');
    await two.service.actor({group:'uploadStart',bytes:40*1024*1024},ip,'ak_http');
    const before=touches;
    const status=await new Promise((resolve,reject)=>{
      const req=http.request(a+'/shorts/uploads/owned/parts/0',{method:'POST',headers:{Authorization:'Bearer owned-session','X-Forwarded-For':'192.0.2.90','Content-Type':'multipart/form-data; boundary=owned','Transfer-Encoding':'chunked'}},res=>{res.resume();resolve(res.statusCode);req.destroy();});
      req.on('error',reject);req.setTimeout(1500,()=>req.destroy(new Error('Waited for a denied body')));req.flushHeaders();
    });
    assert.equal(status,429);assert.equal(touches,before);
  });
  await t.test('allowed multipart and authorized operator requests retain independent capacity',async()=>{
    const before=touches;const part=new FormData();part.append('file',new Blob(['owned bytes']),'part');
    const result=await fetch(b+'/shorts/uploads/owned/parts/0',{method:'POST',headers:{Authorization:'Bearer allowed-session','X-Forwarded-For':'192.0.2.91'},body:part});
    assert.equal(result.status,201);await result.arrayBuffer();assert.equal(touches,before+1);
    const denied=await fetch(a+'/shorts/operator/ingestion',{headers:{Authorization:'Bearer allowed-session','X-Forwarded-For':'192.0.2.92'}});
    assert.equal(denied.status,403);await denied.arrayBuffer();assert.equal(await admin.exists(prefixes[0]+'global:operator'),0);
    const allowed=await fetch(b+'/shorts/operator/ingestion',{headers:{Authorization:'Bearer operator-session','X-Forwarded-For':'192.0.2.93'}});
    assert.equal(allowed.status,200);await allowed.arrayBuffer();assert.equal(await admin.exists(prefixes[0]+'global:operator'),1);
  });
  await t.test('bounded in-flight Redis work fails closed and reconnects without offline replay',async()=>{
    await admin.call('CLIENT','PAUSE','1600','ALL');
    const start=Date.now();
    const pending=Array.from({length:32},()=>one.service.request({group:'read'},'stalled-client').catch(error=>error));
    await assert.rejects(one.service.request({group:'read'},'overload'),{status:503});
    assert.ok((await Promise.all(pending)).every(error=>error.getStatus()===503));assert.ok(Date.now()-start<2500);
    // Recovery must use a live Redis response, not a memory fallback.
    let recovered=false;
    for(let i=0;i<100;i++){
      try { await one.service.request({group:'read'},'after-reconnect');recovered=true;break; }
      catch(error){assert.equal(error.getStatus(),503);await new Promise(resolve=>setTimeout(resolve,50));}
    }
    assert.equal(recovered,true,'Admission resumes only with a live Redis decision');
    await one.service.onModuleDestroy();await assert.rejects(one.service.request({group:'read'},'after-stop'),{status:503});
    const result=await fetch(a+'/shorts/config');assert.equal(result.status,503);assert.equal(result.headers.get('retry-after'),'1');assert.equal(result.headers.get('cache-control'),'no-store');await result.arrayBuffer();
  });
});
