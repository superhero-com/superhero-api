require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ShortsPlaybackEvidenceService } = require('./shorts-playback-evidence.service');
const { LocalShortsAnalyticsService, playbackStart, ANALYTICS_DAY } = require('./shorts-analytics.service');
const { ShortsController } = require('./shorts.controller');
const { playbackProof } = require('./testing/playback-proof.cjs');
const { sourceKey } = require('./hls-protocol/hls-package');

function fixture(t) {
  const key = randomBytes(32), contract = 'ct_fixture';
  const short = { id: randomUUID(), cid: 'bafyfixture', duration: 10 };
  const verifier = new ShortsPlaybackEvidenceService({ release: { network: 'ae_uat', contract }, state: { contract } }); verifier.key = key;
  const event = { id: randomUUID(), session: randomUUID(), seconds: 10, source: 'for-you' };
  const sign = (changes = {}, browser = event.session) => playbackProof(key, short, browser, contract, changes);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const analytics = new LocalShortsAnalyticsService({ db });
  const shorts = { ensurePlayable: async () => short, analytics };
  const controller = new ShortsController(shorts, {}, {}, undefined, undefined, verifier);
  return { key, contract, short, event, sign, verifier, db, analytics, controller, shorts };
}

function sourceFixture(f) {
  const descriptor = { ...structuredClone(require('./testing/hls-v3.json').descriptor), id: f.short.id, contract: f.contract };
  f.short.cid = descriptor.cid;
  const key = sourceKey(descriptor);
  const sign = (changes = {}, browser = f.event.session) => {
    const base = JSON.parse(Buffer.from(f.sign({}, browser).split('.')[1], 'base64url').toString());
    const payload = Buffer.from(JSON.stringify({ ...base, v: 2, cid: descriptor.cid, sourceKey: key, ...changes })).toString('base64url');
    return `m2.${payload}.${createHmac('sha256', f.key).update(`shorts-measurement:v2\0${payload}`).digest('base64url')}`;
  };
  return { descriptor, key, sign };
}

test('shared streaming m2 compatibility vector validates against its authorized delivery while preserving the published CID', async () => {
  const vector=require('./testing/measurement-v2.json'), descriptor=require('./testing/hls-v3.json').descriptor;
  const verifier=new ShortsPlaybackEvidenceService({ release:{ network:descriptor.network,contract:descriptor.contract },state:{ contract:descriptor.contract } });
  verifier.key=Buffer.from(vector.testKeyHex,'hex');
  const canonical={ id:descriptor.id,cid:descriptor.cid }, clock=Date.now;
  try {
    Date.now=()=>vector.now;
    const result=await verifier.validate(canonical,{ id:randomUUID(),session:vector.session,seconds:10,source:'shared',proof:vector.proof },async key=>{
      assert.equal(key,sourceKey(descriptor)); return descriptor;
    });
    assert.equal(result.seconds,2); assert.equal(result.startedAt,vector.evidence.startedAt);
    assert.equal(descriptor.cid,canonical.cid);
  } finally { Date.now=clock; }
});

test('versioned evidence binds the adaptive delivery to its canonical post and preserves deduplication', async t => {
  const f = fixture(t), source = sourceFixture(f), canonical = structuredClone(f.short);
  let lookups = 0;
  f.shorts.playbackVersion = async (id, key) => { lookups++; assert.equal(id, f.short.id); assert.equal(key, source.key); return source.descriptor; };
  assert.equal(source.descriptor.cid, f.short.cid);
  assert.equal((await f.controller.playback(f.short.id, { ...f.event, proof: f.sign() })).views, 1);
  assert.equal(lookups, 0);
  assert.equal((await f.controller.playback(f.short.id, { ...f.event, id: randomUUID(), proof: source.sign() })).views, 1);
  assert.equal(lookups, 1); assert.deepEqual(f.short, canonical);
  const rows = f.db.prepare('SELECT * FROM shorts_plays').all(); assert.equal(rows.length, 1); assert.equal(rows[0].short_id, f.short.id);
  for (const secret of [source.key, source.descriptor.cid, f.event.session, 'm2.']) assert.ok(!JSON.stringify(rows).includes(secret));
  f.analytics.forget(f.event.session);
  assert.equal((await f.controller.playback(f.short.id, { ...f.event, proof: source.sign() })).accepted, false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
});

test('versioned receipt authentication and browser/time checks run before source resolution', async t => {
  const f = fixture(t), source = sourceFixture(f); let lookups = 0;
  f.shorts.playbackVersion = async () => { lookups++; return source.descriptor; };
  for (const proof of [source.sign().replace(/^m2/, 'm1'), source.sign({ v: 1 }), source.sign({ sourceKey: 'bad' }),
    source.sign({ sourceKey: undefined }), source.sign({ id: randomUUID() }), source.sign({ network: 'ae_mainnet' }),
    source.sign({ contract: 'ct_other' }), source.sign({ admittedMs: 61001 }), source.sign({ expiresAt: Date.now()-1 }),
    source.sign({}, randomUUID()), source.sign().slice(0,-4)+'AAAA'])
    await assert.rejects(f.controller.playback(f.short.id, { ...f.event, proof }), { status: 401 });
  assert.equal(lookups, 0);
  assert.throws(() => f.verifier.validate(f.short, { ...f.event, proof: source.sign() }), { status: 401 });
  await assert.rejects(f.controller.playback(f.short.id, { ...f.event, proof: f.sign({ cid: 'other-source' }) }), { status: 401 });
  assert.equal(lookups, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
});

test('only a currently authorized exact source can validate versioned evidence, including retained delivery sessions', async t => {
  const f = fixture(t), source = sourceFixture(f);
  for (const mutate of [d => { d.id = 'other'; }, d => { d.cid = 'b'+'z'.repeat(50); }, d => { d.network = 'ae_mainnet'; },
    d => { d.contract = 'ct_other'; }, d => { d.derivatives.generation.fence = '99'; }]) {
    const changed = structuredClone(source.descriptor); mutate(changed);
    f.shorts.playbackVersion = async () => changed;
    await assert.rejects(f.controller.playback(f.short.id, { ...f.event, proof: source.sign() }), { status: 401 });
  }
  // Withdrawal, expiry of retained history and a merely prepared candidate all deny lookup.
  f.shorts.playbackVersion = async () => { throw new (require('@nestjs/common').NotFoundException)(); };
  await assert.rejects(f.controller.playback(f.short.id, { ...f.event, proof: source.sign() }), { status: 404 });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
  f.shorts.playbackVersion = async (_id, key) => { assert.equal(key, source.key); return source.descriptor; };
  const accepted = await f.verifier.validate(f.short, { ...f.event, proof: source.sign({ admittedMs: 2000 }) }, key => f.shorts.playbackVersion(f.short.id,key));
  assert.equal(accepted.seconds, 2); assert.deepEqual(Object.keys(accepted).sort(), ['id','seconds','session','source','startedAt']);
});

test('a receipt that expires while permission is being resolved never reaches analytics', async t => {
  const f = fixture(t), source = sourceFixture(f), now = Date.now(), proof = source.sign({ expiresAt: now+1000 });
  const clock = Date.now;
  try {
    f.shorts.playbackVersion = async () => { Date.now = () => now+1001; return source.descriptor; };
    await assert.rejects(f.controller.playback(f.short.id, { ...f.event, proof }), { status: 401 });
  } finally { Date.now = clock; }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
});

test('watch progress needs signed evidence for this browser, video, CID and deployment', async t => {
  const f = fixture(t), now = Date.now();
  const invalid = [undefined, '', 'm1.e30.' + 'a'.repeat(43), 'a'.repeat(2049), f.sign({ v: 2 }),
    f.sign({ id: randomUUID() }), f.sign({ cid: 'other' }), f.sign({ contract: 'ct_other' }), f.sign({ network: 'ae_mainnet' }),
    f.sign({}, randomUUID()), f.sign({ nonce: 'bad' }), f.sign({ expiresAt: now - 1 }),
    f.sign({ issuedAt: now + 5000 }), f.sign({ startedAt: now + 1, issuedAt: now }),
    f.sign({ startedAt: now - 200000 }), f.sign({ admittedMs: -1 }), f.sign({ admittedMs: 61001 }),
    f.sign({ admittedMs: 1.2 }), playbackProof(randomBytes(32), f.short, f.event.session, f.contract)];
  for (const proof of invalid) {
    await assert.rejects(f.controller.playback(f.short.id, { ...f.event, proof }), { status: 401 });
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
  assert.equal(f.verifier.validate(f.short, { ...f.event, proof: f.sign() }).seconds, 10);
  const unsigned = new ShortsController({ ensurePlayable: async () => f.short, analytics: f.analytics });
  await assert.rejects(unsigned.playback(f.short.id, f.event), { status: 503 });
  f.verifier.key = undefined;
  await assert.rejects(f.controller.playback(f.short.id, { ...f.event, proof: f.sign() }), { status: 503 });
});

test('authorized segment duration and elapsed time cap claims without storing receipts', t => {
  const f = fixture(t);
  assert.equal(f.verifier.validate(f.short, { ...f.event, proof: f.sign({ admittedMs: 0 }) }).seconds, 0);
  assert.equal(f.verifier.validate(f.short, { ...f.event, proof: f.sign({ admittedMs: 2000 }) }).seconds, 2);
  const now = Date.now();
  const verified = f.verifier.validate(f.short, { ...f.event, proof: f.sign({ startedAt: now, issuedAt: now }) });
  assert.equal(verified.seconds, 0.5);
  assert.deepEqual(Object.keys(verified).sort(), ['id', 'seconds', 'session', 'source', 'startedAt']);
  for (const changes of [{ id: '..' }, { session: 'bad' }, { seconds: -1 }, { seconds: '5' }, { seconds: 66 }, { source: 'unknown' }])
    assert.throws(() => f.verifier.validate(f.short, { ...f.event, ...changes, proof: f.sign() }), { status: 400 });
});

test('zero-media and sub-two-second sessions never allocate persistent playback records', async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) {
    const event = { ...f.event, id: randomUUID(), session: randomUUID(), seconds: 60 };
    const proof = f.sign({ admittedMs: i % 2 ? 1500 : 0 }, event.session);
    const result = await f.controller.playback(f.short.id, { ...event, proof });
    assert.equal(result.accepted, true); assert.equal(result.views, 0);
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
});

test('valid receipts still deduplicate event and browser/day replays; forgetting prevents resurrection', async t => {
  const f = fixture(t), proof = f.sign();
  let result = await f.controller.playback(f.short.id, { ...f.event, seconds: 0, proof }); assert.equal(result.views, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
  result = await f.controller.playback(f.short.id, { ...f.event, seconds: 5, proof }); assert.equal(result.views, 1);
  for (let i = 0; i < 10; i++) {
    result = await f.controller.playback(f.short.id, { ...f.event, proof: f.sign() }); assert.equal(result.views, 1);
    result = await f.controller.playback(f.short.id, { ...f.event, id: randomUUID(), proof }); assert.equal(result.views, 1);
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 1);
  f.analytics.forget(f.event.session);
  result = await f.controller.playback(f.short.id, { ...f.event, proof: f.sign() });
  assert.equal(result.accepted, false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
});

test('a first qualifying update uses its signed clock; request timestamps cannot backdate it', async t => {
  const f = fixture(t);
  const proof = f.sign({ admittedMs: 2000 });
  const result = await f.controller.playback(f.short.id, { ...f.event, seconds: 2, startedAt: 0, proof });
  assert.equal(result.views, 1);
  const row = f.db.prepare('SELECT * FROM shorts_plays').get();
  assert.ok(row.started > Date.now() - 12000);
  assert.equal(row.seconds, 2);
  const other = randomUUID();
  const instant = f.sign({ startedAt: Date.now(), issuedAt: Date.now() }, other);
  await f.controller.playback(f.short.id, { ...f.event, session: other, id: randomUUID(), startedAt: 0, proof: instant });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 1);
});

test('signed clock is bounded and cannot carry elapsed time across UTC midnight', t => {
  const f = fixture(t), midnight = 100 * ANALYTICS_DAY, now = midnight + 1000;
  assert.equal(playbackStart(now, midnight - 4000), midnight);
  assert.equal(playbackStart(now, now + 1000), now);
  assert.throws(() => playbackStart(now, now - 125001));
  assert.throws(() => playbackStart(now, now + 2001));
  const original = Date.now; Date.now = () => now;
  try {
    const result = f.analytics.record(f.short, { ...f.event, seconds: 5 }, midnight - 4000);
    assert.equal(result.views, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM shorts_plays').get().n, 0);
  } finally { Date.now = original; }
});
