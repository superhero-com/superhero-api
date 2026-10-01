const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { AeSdk, AccountMemory, Node, Contract } = require('@aeternity/aepp-sdk');

// Opt-in public testnet integration. Use disposable faucet-funded accounts only.
test('wallet-signed Shorts lifecycle on ae_uat with local API and IPFS', {
  skip: process.env.SHORTS_TESTNET_E2E !== '1', timeout: 900000,
}, async t => {
  for (const name of ['SHORTS_TEST_KEYS_FILE', 'SHORTS_TEST_VIDEO']) assert.ok(process.env[name], `Set ${name}`);
  const keys = JSON.parse(readFileSync(process.env.SHORTS_TEST_KEYS_FILE));
  const actors = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, new AccountMemory(v.secretKey)]));
  const api = 'http://127.0.0.1:3334/api/shorts';
  const tokens = {};
  async function req(path, body, actor, expected = 200) {
    const form = body instanceof FormData;
    const response = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'X-Shorts-Local': '1', ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
      ...(tokens[actor] ? { Authorization: `Bearer ${tokens[actor]}` } : {}),
    }, body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const data = await response.json();
    if (expected >= 400) assert.equal(response.status, expected, JSON.stringify(data));
    else assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const cfg = await req('/config'); assert.equal(cfg.network, 'ae_uat'); assert.equal(cfg.ipfs, true); assert.equal(cfg.visualModeration, true); assert.equal(cfg.replicas, 2);
  const sdk = new AeSdk({ accounts: Object.values(actors), nodes: [{ name: 'testnet', instance: new Node('https://testnet.aeternity.io') }], interval: 1500 });
  assert.equal((await sdk.getNodeInfo()).nodeNetworkId, 'ae_uat');
  assert.equal(cfg.operator, actors.operator.address);
  const code = await sdk.api.getContractCode(cfg.contract);
  assert.equal(createHash('sha256').update(code.bytecode).digest('hex'), cfg.bytecodeHash);
  const contract = await Contract.initialize({ ...sdk.getContext(), aci: cfg.aci, address: cfg.contract });
  const read = async (method, args = []) => (await contract.$call(method, args, { callStatic: true })).decodedResult;
  const write = async (who, method, args = [], amount) => {
    const result = await contract.$call(method, args, { onAccount: actors[who], ...(amount === undefined ? {} : { amount }) });
    const tx = await sdk.api.getTransactionByHash(result.hash); assert.ok(tx.blockHeight > 0);
    console.log(JSON.stringify({ action: method, tx: result.hash, height: tx.blockHeight }));
    await req('/receipt', { tx: result.hash }, who);
    return result;
  };
  const reject = (who, method, args, pattern, amount) => assert.rejects(contract.$call(method, args, { onAccount: actors[who], ...(amount === undefined ? {} : { amount }) }), pattern);
  const balanced = async () => { const [rewards, hosting, balance] = await read('get_liabilities'); assert.equal(rewards + hosting, balance); };
  let video, first, until, topup, withdrawn;
  await t.test('signed authentication rejects impersonation, replay and anonymous operator access', async () => {
    await req('/dashboard', undefined, undefined, 401);
    await req('/review', undefined, undefined, 401);
    const wrong = await req('/auth/challenge', { address: actors.creator.address });
    await req('/auth/verify', { id: wrong.id, signature: Buffer.from(await actors.viewer.signMessage(wrong.message)).toString('hex') }, undefined, 401);
    for (const [name, account] of Object.entries(actors)) {
      const c = await req('/auth/challenge', { address: account.address });
      const signature = Buffer.from(await account.signMessage(c.message)).toString('hex');
      const session = await req('/auth/verify', { id: c.id, signature });
      tokens[name] = session.token; assert.equal(session.address, account.address);
      await req('/auth/verify', { id: c.id, signature }, undefined, 401);
    }
    await req('/review', undefined, 'creator', 403);
    await req('/action', { actor: 'creator', action: 'claim' }, 'creator', 404);
  });
  await t.test('uploads keep inspection evidence operator-only and activate after wallet funding', async () => {
    const bytes = readFileSync(process.env.SHORTS_TEST_VIDEO);
    const session = await req('/uploads', { title: `${process.env.SHORTS_TEST_RUN_LABEL || 'Captioned fractal'} · ${new Date().toISOString().slice(0,16)}`, topic:'Art', rights:true, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'), details:{ language:'en', description:'Owned procedural video for local flow validation', captions:'WEBVTT\n\n00:00.000 --> 00:03.000\nA journey through colour.\n', synthetic:true, sponsored:false } }, 'creator');
    await req(`/uploads/${session.id}`, undefined, 'viewer', 400);
    for (let i=0; i<Math.ceil(bytes.length/session.partSize); i++) {
      const part = new FormData(); part.set('file', new Blob([bytes.subarray(i*session.partSize,(i+1)*session.partSize)]), 'part');
      await req(`/uploads/${session.id}/parts/${i}`, part, 'creator');
      assert.ok((await req(`/uploads/${session.id}`, undefined, 'creator')).parts.includes(i));
    }
    video = await req(`/uploads/${session.id}/finish`, {}, 'creator');
    assert.equal(video.safety, undefined);
    const inspected = (await req('/review', undefined, 'operator')).find(v => v.id === video.id);
    assert.equal(inspected.safety.status, 'no_flags'); assert.ok(inspected.safety.frameCount >= 16); assert.equal(inspected.safety.labels[0].topic, 'Art');
    assert.equal((await req(`/uploads/${session.id}/finish`, {}, 'creator')).id, video.id);
    assert.equal(video.classification, undefined);
    assert.equal(inspected.classification.status, 'manual');
    assert.ok(video.cid.startsWith('bafy')); assert.ok(video.bytes > 0);
    await req(`/media/${video.id}/manifest.json`, undefined, undefined, 400);
    await req(`/review/${video.id}`, { approved: true }, 'creator', 403);
    await req(`/review/${video.id}`, { approved: true }, 'operator');
    await req('/quote', { shortId: video.id, budget: '0.03', source: 'wallet' }, 'viewer', 400);
    first = await req('/quote', { shortId: video.id, budget: '0.03', source: 'wallet' }, 'creator');
    await req('/activate', { quoteId: first.id }, 'creator', 400);
    await reject('viewer', 'fund_wallet', [BigInt(first.id)], /ONLY_CREATOR/, first.amountAettos);
    await reject('creator', 'fund_wallet', [BigInt(first.id)], /WRONG_AMOUNT_OR_SOURCE/, '1');
    await write('creator', 'fund_wallet', [BigInt(first.id)], first.amountAettos);
    await req('/activate', { quoteId: first.id }, 'creator');
    const chainVideo = await read('get_short', [video.id]); until = chainVideo.until;
    assert.equal(chainVideo.cid, video.cid);
    const tranche = await read('get_tranche', [BigInt(first.id)]);
    assert.equal(tranche.ends - tranche.starts, BigInt(first.days) * 86400000n);
    assert.ok((await req('')).some(v => v.id === video.id));
    const media = await fetch(`${api}/media/${video.id}/video.mp4`, { headers: { Range: 'bytes=0-63' } });
    assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 64);
    const captions = await fetch(`${api}/media/${video.id}/captions.vtt`); assert.match(captions.headers.get('content-type'), /text\/vtt/); assert.match(await captions.text(), /A journey through colour/);
    const stored = await fetch(`http://127.0.0.1:38081/ipfs/${video.cid}/video.mp4`);
    const storedBytes = Buffer.from(await stored.arrayBuffer()); assert.ok(stored.ok);
    const played = await fetch(`${api}/media/${video.id}/video.mp4`);
    assert.equal(createHash('sha256').update(storedBytes).digest('hex'), createHash('sha256').update(Buffer.from(await played.arrayBuffer())).digest('hex'));
    const legacySession = randomUUID(); await req(`/${video.id}/view`, { session:legacySession }); await req(`/${video.id}/view`, { session:legacySession });
    assert.equal((await req('')).find(v => v.id === video.id).views, 1);
    await balanced();
    console.log(JSON.stringify({ videoId: video.id, cid: video.cid, days: first.days, amount: first.charge }));
  });
  await t.test('paid Like validates the fee and credits exactly 80/20 without draining hosting escrow', async () => {
    const beforeC = await read('get_account', [actors.creator.address]);
    const beforeT = await read('get_account', [actors.operator.address]);
    const hosting = (await read('get_liabilities'))[1];
    await reject('creator', 'paid_like', [video.id], /SELF_LIKE/, '100000000000000000');
    await reject('viewer', 'paid_like', [video.id], /WRONG_LIKE_FEE/, '1');
    await write('viewer', 'paid_like', [video.id], '100000000000000000');
    await reject('viewer', 'paid_like', [video.id], /ALREADY_LIKED/, '100000000000000000');
    assert.equal((await read('get_account', [actors.creator.address])).available - beforeC.available, 80000000000000000n);
    assert.equal((await read('get_account', [actors.operator.address])).available - beforeT.available, 20000000000000000n);
    assert.equal((await read('get_liabilities'))[1], hosting);
    assert.equal((await req(`?address=${actors.viewer.address}`)).find(v => v.id === video.id).liked, true);
    await balanced();
  });
  await t.test('earned rewards buy additional protected hosting days', async () => {
    const before = await read('get_account', [actors.creator.address]);
    topup = await req('/quote', { shortId: video.id, budget: '0.02', source: 'rewards' }, 'creator');
    await write('creator', 'fund_rewards', [BigInt(topup.id)]);
    await req('/activate', { quoteId: topup.id }, 'creator');
    assert.equal((await read('get_account', [actors.creator.address])).available, before.available - BigInt(topup.amountAettos));
    assert.equal((await read('get_short', [video.id])).until, until + BigInt(topup.days) * 86400000n);
    assert.equal((await read('get_tranche', [BigInt(first.id)])).ends, until);
    await balanced();
  });
  await t.test('creator and deployer claim rewards while hosting funds remain in escrow', async () => {
    const hosting = (await read('get_liabilities'))[1];
    for (const who of ['creator', 'operator']) {
      const before = await read('get_account', [actors[who].address]);
      await write(who, 'claim');
      const after = await read('get_account', [actors[who].address]);
      assert.equal(after.available, 0n); assert.equal(after.claimed - before.claimed, before.available);
      await reject(who, 'claim', [], /NO_REWARDS/);
    }
    assert.equal((await read('get_liabilities'))[1], hosting); await balanced();
  });
  await t.test('measured analytics, anonymous reason reports and creator appeals', async () => {
    const playback = { id:randomUUID(), session:randomUUID(), seconds:0, source:'for-you' };
    await req(`/${video.id}/playback`, playback);
    await new Promise(resolve => setTimeout(resolve, 2200));
    await req(`/${video.id}/playback`, { ...playback, seconds:2 });
    const p = await req(`/performance?days=7&short=${video.id}`, undefined, 'creator'); assert.equal(p.summary.views, 1); assert.equal(p.summary.reach, 1); assert.equal(p.summary.watchSeconds, 2);
    await req(`/performance?days=7&short=${video.id}`, undefined, 'viewer', 400);
    await req('/analytics/forget', {session:playback.session});
    assert.equal((await req(`/performance?days=7&short=${video.id}`, undefined, 'creator')).summary.views, 0);
    const report = {id:randomUUID(), reason:'Other', detail:'Owned fixture: review workflow test'};
    await req(`/${video.id}/report`, report); await req(`/${video.id}/report`, report);
    assert.equal((await req('/review', undefined, 'operator')).find(v => v.id === video.id).reports, 1);
    await req(`/review/${video.id}`, {approved:false, reason:'Test restriction'}, 'operator');
    await req(`/${video.id}/appeal`, {message:'Please review this owned test fixture again.'}, 'viewer', 400);
    await req(`/${video.id}/appeal`, {message:'Please review this owned test fixture again.'}, 'creator');
    await req(`/review/${video.id}`, {approved:true, reason:'Appeal accepted: owned fixture', topic:'Art'}, 'operator');
    assert.equal((await req('/dashboard', undefined, 'creator')).shorts.find(v => v.id === video.id).appeal.status, 'resolved');
  });
  await t.test('moderation excludes the feed while keeping paid shared playback with a content warning', async () => {
    const before = (await read('get_short', [video.id])).until;
    await req(`/review/${video.id}`, { approved: false }, 'operator');
    assert.ok(!(await req('')).some(v => v.id === video.id));
    await req(`/media/${video.id}/manifest.json`);
    assert.equal((await req(`/shared/${video.id}`)).contentWarning, 'feed-excluded');
    assert.equal((await read('get_short', [video.id])).until, before);
    await req(`/review/${video.id}`, { approved: true }, 'operator');
  });
  await t.test('withdrawal prevents further Likes and removes official playback', async () => {
    const form = new FormData(); form.set('title', 'Withdrawal test'); form.set('topic', 'Learning'); form.set('rights', 'true');
    form.set('file', new Blob([readFileSync(process.env.SHORTS_TEST_VIDEO)], { type: 'video/mp4' }), 'test.mp4');
    withdrawn = await req('/upload', form, 'creator'); await req(`/review/${withdrawn.id}`, { approved: true }, 'operator');
    const q = await req('/quote', { shortId: withdrawn.id, budget: '0.02', source: 'wallet' }, 'creator');
    await write('creator', 'fund_wallet', [BigInt(q.id)], q.amountAettos);
    await req('/activate', { quoteId: q.id }, 'creator');
    await reject('viewer', 'withdraw', [withdrawn.id], /ONLY_CREATOR/);
    await write('creator', 'withdraw', [withdrawn.id]);
    await reject('viewer2', 'paid_like', [withdrawn.id], /VIDEO_UNAVAILABLE/, '100000000000000000');
    await req(`/media/${withdrawn.id}/manifest.json`, undefined, undefined, 400);
    assert.ok(!(await req('')).some(v => v.id === withdrawn.id)); await balanced();
  });
});
