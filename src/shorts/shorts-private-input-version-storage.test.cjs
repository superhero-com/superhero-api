require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, scope, candidate, current } = require('./testing/private-version-http.cjs');
const { ShortsPrivateVersionStorageService } = require('./shorts-private-version-storage.service');
const { ShortsPrivateInputVersionStorageService } = require('./shorts-private-input-version-storage.service');

async function setup(t) {
  const f = await fixture(t); f.state.allowCurrentRemoval = true;
  const config = { storage: f.config, objectPrefix: f.ref.key.split('/').slice(0, 2).join('/') + '/' };
  const storage = new ShortsPrivateVersionStorageService(config); t.after(() => storage.onModuleDestroy());
  return { ...f, storage, io: new ShortsPrivateInputVersionStorageService(f.service, storage), signal: new AbortController().signal };
}

test('retired version removal authenticates exact bytes before requesting authority and rechecks before sending', async t => {
  const f = await setup(t); let issued = 0, checked = 0;
  const authority = async (scope, ref, version) => { issued++; return { scope, ref, version, issuedAt: new Date(), assertCurrent: async () => { checked++; } }; };
  const encrypted = Buffer.from(f.state.versions.get(current));
  f.state.versions.get(current)[40] ^= 1;
  await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, authority), /verified/);
  assert.equal(issued, 0); f.state.versions.set(current, encrypted);
  await assert.rejects(f.io.remove(scope, f.ref, 'null', f.signal, authority), /immutable/);
  for (const field of ['wrongVersionHead', 'versionMarker', 'hideAbsence']) {
    f.state[field] = true;
    await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, authority));
    f.state[field] = false;
  }
  assert.equal(issued, 0);
  for (const change of [grant => { grant.version = candidate; }, grant => { grant.ref = { ...grant.ref, bytes: 1 }; },
    grant => { grant.scope = { ...grant.scope, network: 'ae_mainnet' }; }]) {
    await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, async (scope, ref, version) => {
      const grant = { scope, ref, version, issuedAt: new Date(), assertCurrent: async () => {} }; change(grant); return grant;
    }), /authority identity/);
  }
  await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, async () => { throw new Error('durability proof failed'); }), /durability proof/);
  await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, async (scope, ref, version) => ({ scope, ref, version, issuedAt: new Date(),
    assertCurrent: async () => { throw new Error('policy changed'); } })), /policy changed/);
  for (const age of [-6000, 6000, NaN])
    await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, async (scope, ref, version) => ({ scope, ref, version, issuedAt: new Date(Date.now() - age), assertCurrent: async () => {} })), /clock/);
  assert.equal(f.state.deletes, undefined);
  assert.deepEqual(await f.io.remove(scope, f.ref, current, f.signal, authority), { key: f.ref.key, version: current, removed: true });
  assert.equal(issued, 1); assert.equal(checked, 1); assert.equal(f.state.current, candidate);
  assert.equal(f.state.versions.has(candidate), true); assert.equal(f.state.deletes, 1);
});

test('caller mutation during authority cannot redirect the authenticated deletion', async t => {
  const f = await setup(t), key = f.ref.key;
  const result = await f.io.remove(scope, f.ref, current, f.signal, async (scope, ref, version) => {
    f.ref.key = key.replace('/job/', '/different-job/');
    assert.ok(Object.isFrozen(ref)); assert.ok(Object.isFrozen(scope));
    return { scope, ref, version, issuedAt: new Date(), assertCurrent: async () => {} };
  });
  assert.equal(result.key, key); assert.equal(result.version, current);
});

test('signed deletion cannot outlive the database durability proof deadline', async t => {
  const f = await setup(t);
  for (const remaining of [-1, 0, 999, NaN]) {
    await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, async (scope, ref, version) => {
      const issuedAt = new Date();
      return { scope, ref, version, issuedAt, expiresAt: new Date(issuedAt.getTime() + remaining), assertCurrent: async () => {} };
    }), /clock/);
  }
  assert.equal(f.state.deletes, undefined);
  f.state.expectedExpires = 4;
  await f.io.remove(scope, f.ref, current, f.signal, async (scope, ref, version) => {
    const issuedAt = new Date();
    return { scope, ref, version, issuedAt, expiresAt: new Date(issuedAt.getTime() + 4500), assertCurrent: async () => {} };
  });
  assert.equal(f.state.deletes, 1);
});

test('recovery snapshots the observed identity before asynchronous provider checks', async t => {
  const f = await setup(t), key = f.ref.key, ready = f.storage.ready.bind(f.storage), absent = f.storage.retiredVersionAbsent.bind(f.storage);
  f.storage.ready = async signal => { await ready(signal); f.ref.key = key.replace('/job/', '/other-job/'); };
  f.storage.retiredVersionAbsent = async (observed, ...args) => { assert.equal(observed, key); return absent(observed, ...args); };
  assert.equal(await f.io.absent(scope, f.ref, current, f.signal), false);
});

test('batch preparation authenticates once and its one-use handle preserves identity through later dispatch', async t => {
  const f=await setup(t),key=f.ref.key;
  const remove=await f.io.prepare(scope,f.ref,current,f.signal);
  const reads=f.state.requests.filter(row=>row.method==='GET'&&row.version===current).length;
  assert.equal(reads,1);assert.equal(f.state.deletes,undefined);
  f.ref.key=key.replace('/job/','/other/');
  const result=await remove(async(scope,ref,version)=>({scope,ref,version,issuedAt:new Date(),assertCurrent:async()=>{}}));
  assert.equal(result.key,key);assert.equal(result.version,current);
  assert.equal(f.state.requests.filter(row=>row.method==='GET'&&row.version===current).length,reads);
  await assert.rejects(remove(async()=>assert.fail('one-use handle cannot issue twice')),/consumed/);assert.equal(f.state.deletes,1);
});

test('current and final copies are removed individually; newer writes do not change an old-version receipt', async t => {
  const f = await setup(t), ciphertext = Buffer.from(f.state.versions.get(current));
  const authority = async (scope, ref, version) => ({ scope, ref, version, issuedAt: new Date(), assertCurrent: async () => {} });
  await f.io.remove(scope, f.ref, current, f.signal, authority);
  assert.equal(await f.io.absent(scope, f.ref, current, f.signal), true);
  assert.equal(await f.io.absent(scope, f.ref, candidate, f.signal), false);
  await f.io.remove(scope, f.ref, candidate, f.signal, authority);
  assert.equal(f.state.versions.size, 0); assert.equal(f.state.deletes, 2);
  f.state.versions.set('late-write', ciphertext); f.state.current = 'late-write';
  assert.equal(await f.io.absent(scope, f.ref, current, f.signal), true);
  assert.equal(await f.io.absent(scope, f.ref, candidate, f.signal), true);
  assert.equal(await f.io.absent(scope, f.ref, 'late-write', f.signal), false);
  assert.equal(f.state.deletes, 2, 'observing old-version absence must not delete a newer version');
});

test('lost acknowledgements, refused deletion and false success remain distinguishable on fresh observation', async t => {
  const f = await setup(t), authority = async (scope, ref, version) => ({ scope, ref, version, issuedAt: new Date(), assertCurrent: async () => {} });
  f.state.denyDelete = true;
  await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, authority), /uncertain/);
  assert.equal(await f.io.absent(scope, f.ref, current, f.signal), false); f.state.denyDelete = false;
  f.state.keepCandidate = true;
  await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, authority), /not confirmed/);
  assert.equal(await f.io.absent(scope, f.ref, current, f.signal), false); f.state.keepCandidate = false;
  f.state.loseDelete = true;
  await assert.rejects(f.io.remove(scope, f.ref, current, f.signal, authority));
  const count = f.state.deletes, restarted = new ShortsPrivateInputVersionStorageService(f.service, f.storage);
  assert.equal(await restarted.absent(scope, f.ref, current, f.signal), true);
  await assert.rejects(restarted.remove(scope, f.ref, current, f.signal, async () => assert.fail('absent ciphertext cannot mint new authority')));
  assert.equal(f.state.deletes, count);
  f.state.hideAbsence = true; await assert.rejects(restarted.absent(scope, f.ref, current, f.signal));
});

test('cancellation before or during authority does not send a destructive request', async t => {
  const f = await setup(t), parent = new AbortController();
  await assert.rejects(f.io.remove(scope, f.ref, current, AbortSignal.abort(), async () => assert.fail('cancelled before authority')));
  await assert.rejects(f.io.remove(scope, f.ref, current, parent.signal, async (scope, ref, version) => {
    parent.abort(); return { scope, ref, version, issuedAt: new Date(), assertCurrent: async () => assert.fail('cancelled before dispatch') };
  }), { name: 'AbortError' });
  assert.equal(f.state.deletes, undefined); assert.equal(f.state.versions.has(current), true);
});
