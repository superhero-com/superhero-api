const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { AeSdk, AccountMemory, Node, Contract } = require('@aeternity/aepp-sdk');

// Opt-in integration using externally supplied disposable accounts and an owned clip.
test('Free publication, IPFS playback, paid Likes and reward claims on ae_uat', {
  skip: process.env.SHORTS_TESTNET_E2E !== '1', timeout: 600000,
}, async t => {
  const keys = JSON.parse(readFileSync(process.env.SHORTS_TEST_KEYS_FILE));
  const actors = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, new AccountMemory(v.secretKey)]));
  const api = 'http://127.0.0.1:3334/api/shorts';
  const tokens = {};
  const req = async (path, body, actor, expected) => {
    const form = body instanceof FormData;
    const response = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'X-Shorts-Local': '1', ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
      ...(tokens[actor] ? { Authorization: `Bearer ${tokens[actor]}` } : {}),
    }, body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const data = await response.json();
    if (expected) assert.equal(response.status, expected, JSON.stringify(data));
    else assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const cfg = await req('/config');
  assert.equal(cfg.network, 'ae_uat'); assert.equal(cfg.hosting, 'platform-funded'); assert.equal(cfg.ipfs, true);
  const sdk = new AeSdk({ accounts: Object.values(actors), nodes: [{name: 'testnet', instance: new Node('https://testnet.aeternity.io')}], interval: 1500 });
  assert.equal((await sdk.getNodeInfo()).nodeNetworkId, 'ae_uat');
  const contract = await Contract.initialize({ ...sdk.getContext(), aci: cfg.aci, address: cfg.contract });
  assert.equal(createHash('sha256').update((await sdk.api.getContractCode(cfg.contract)).bytecode).digest('hex'), cfg.bytecodeHash);
  const read = async (method, args = []) => (await contract.$call(method, args, {callStatic: true})).decodedResult;
  const call = async (actor, method, args = [], amount) => contract.$call(method, args, {onAccount: actors[actor], ...(amount === undefined ? {} : {amount})});
  const balanced = async () => { const [liability, balance] = await read('get_liabilities'); assert.equal(liability, balance); };
  let video;
  await t.test('creator authentication and removed hosting endpoints', async () => {
    await req('/dashboard', undefined, undefined, 401);
    for (const [name, actor] of Object.entries(actors)) {
      const c = await req('/auth/challenge', {address: actor.address});
      tokens[name] = (await req('/auth/verify', {id: c.id, signature: Buffer.from(await actor.signMessage(c.message)).toString('hex')})).token;
    }
    await req('/quote', {}, 'creator', 404); await req('/activate', {}, 'creator', 404);
  });
  await t.test('upload remains private until Publish; platform covers publication with no creator debit', async () => {
    const before = await sdk.getBalance(actors.creator.address);
    const bytes = readFileSync(process.env.SHORTS_TEST_VIDEO);
    const session = await req('/uploads', {title: `Platform-funded test · ${randomUUID().slice(0,8)}`, topic:'Art', rights:true, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'), details:{language:'und', synthetic:true}}, 'creator');
    await req(`/uploads/${session.id}`, undefined, 'viewer', 400);
    for(let i=0; i<Math.ceil(bytes.length/session.partSize); i++) {
      const part = new FormData(); part.set('file',new Blob([bytes.subarray(i*session.partSize,(i+1)*session.partSize)]),'part');
      await req(`/uploads/${session.id}/parts/${i}`,part,'creator');
    }
    video=await req(`/uploads/${session.id}/finish`,{},'creator');
    await req(`/playback/${video.id}`, undefined, undefined, 404);
    await req(`/${video.id}/hosting-prices`, undefined, 'creator', 404);
    await req(`/${video.id}/publish`, {}, 'viewer', 400);
    const result=await req(`/${video.id}/publish`,{},'creator');
    assert.equal(result.publicationStatus,'published'); assert.equal(result.until,undefined);
    assert.equal(await sdk.getBalance(actors.creator.address), before);
    const again=await req(`/${video.id}/publish`,{},'creator'); assert.equal(again.id,video.id);
    const chainVideo=await read('get_short',[video.id]); assert.equal(chainVideo.cid,video.cid); assert.equal(chainVideo.until,undefined);
    const streamBase=process.env.SHORTS_STREAM_URL || 'http://127.0.0.1:3335';
    assert.equal((await fetch(`${streamBase}/videos/${video.id}/video.mp4`)).status,410);
    let playback;
    for(let attempt=0;attempt<120;attempt++) {
      const response=await fetch(`${streamBase}/videos/${video.id}/playback`,{method:'POST'});
      if(response.status===202) { await response.arrayBuffer(); await new Promise(resolve=>setTimeout(resolve,2000)); continue; }
      assert.equal(response.status,200); playback=await response.json(); break;
    }
    assert.ok(playback?.manifest,'HLS preparation completed');
    const manifest=await fetch(streamBase+playback.manifest);
    assert.equal(manifest.status,200);
    const playlist=await manifest.text();
    assert.match(playlist,/#EXT-X-ENDLIST/);
    const segment=playlist.split('\n').find(line=>line.startsWith('segment-'));
    assert.ok(segment);
    const media=await fetch(`${streamBase}/videos/${video.id}/${segment}`,{headers:{Range:'bytes=0-63'}});
    assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,64);
    assert.equal((await req(`/shared/${video.id}`)).publicationStatus,'published');
    if(cfg.moderationMode==='demo') assert.ok((await req('')).some(v=>v.id===video.id));
    console.log(JSON.stringify({videoId:video.id,cid:video.cid}));
  });
  await t.test('paid Like still splits 80/20 and rejects self and duplicate payments', async () => {
    const beforeC=await read('get_account',[actors.creator.address]);
    const beforeT=await read('get_account',[actors.operator.address]);
    await assert.rejects(call('creator','paid_like',[video.id],'100000000000000000'),/SELF_LIKE/);
    await assert.rejects(call('viewer','paid_like',[video.id],'1'),/WRONG_LIKE_FEE/);
    await call('viewer','paid_like',[video.id],'100000000000000000');
    await assert.rejects(call('viewer','paid_like',[video.id],'100000000000000000'),/ALREADY_LIKED/);
    assert.equal((await read('get_account',[actors.creator.address])).available-beforeC.available,80000000000000000n);
    assert.equal((await read('get_account',[actors.operator.address])).available-beforeT.available,20000000000000000n);
    await req(`/${video.id}/publish`,{},'creator');
    assert.equal((await read('get_short',[video.id])).likes,1n);await balanced();
  });
  await t.test('rewards remain claimable and creator withdrawal prevents further playback', async () => {
    for(const actor of ['creator','operator']) {
      const before=await read('get_account',[actors[actor].address]);await call(actor,'claim');
      const after=await read('get_account',[actors[actor].address]);
      assert.equal(after.available,0n);assert.equal(after.claimed-before.claimed,before.available);
      await assert.rejects(call(actor,'claim'),/NO_REWARDS/);
    }
    await balanced();
    await assert.rejects(call('viewer','withdraw',[video.id]),/ONLY_CREATOR/);
    await call('creator','withdraw',[video.id]);
    await req(`/shared/${video.id}`,undefined,undefined,400);
    await req(`/${video.id}/publish`,{},'creator',400);
  });
});
