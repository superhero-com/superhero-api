require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { AccountMemory } = require('@aeternity/aepp-sdk');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsSessionsService } = require('./shorts-sessions.service');
const { ShortsSessions1791763201000 } = require('../migrations/1791763201000-ShortsSessions');

test('shared wallet sessions: real signatures, atomic admission, replay and revocation', { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 45000 }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_sessions_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 },
    migrations: [ShortsSessions1791763201000], synchronize: false };
  const first = new DataSource(options), second = new DataSource(options);
  await first.initialize(); await second.initialize(); await first.runMigrations({ transaction: 'all' });
  const saved = { ...process.env };
  process.env.SHORTS_WEB_ORIGIN = 'https://studio.example.com';
  process.env.NODE_ENV = 'test'; process.env.SHORTS_DEMO_CONNECTED_WALLET = '1'; process.env.SHORTS_TESTNET_MVP = '1';
  t.after(async () => { process.env = saved; await first.destroy(); await second.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  const repoA = new ShortsSessionsService(first), repoB = new ShortsSessionsService(second);
  const hash = value => createHash('sha256').update(value).digest('hex');
  function setup() {
    const creator = AccountMemory.generate(), operator = AccountMemory.generate();
    const contract = `ct_${randomUUID().replaceAll('-', '')}`;
  const chain = { release: { network: 'ae_uat', contract }, state: { contract }, operator,
      address: value => { if (!value?.startsWith('ak_')) throw new Error('Invalid address'); return value; } };
    const store = { get db() { assert.fail('Hosted authentication cannot read SQLite'); } };
    const a = new ShortsAuthService(store, chain, repoA), b = new ShortsAuthService(store, chain, repoB);
    const scope = { network: 'ae_uat', contract: chain.state.contract, origin: process.env.SHORTS_WEB_ORIGIN };
    return { a, b, scope, creator, operator, chain, store };
  }
  const sign = async (wallet, message) => Buffer.from(await wallet.signMessage(message)).toString('hex');
  async function login(auth, wallet) {
    const challenge = await auth.challenge(wallet.address);
    return auth.verify(challenge.id, await sign(wallet, challenge.message));
  }
  const params = s => [s.network, s.contract, s.origin];

  await t.test('API session adapters isolate the same wallet and contract across network releases', async () => {
    const f = setup();
    const mainChain = { ...f.chain, release: { ...f.chain.release, network: 'ae_mainnet' } };
    const main = new ShortsAuthService(f.store, mainChain, repoB);
    const testChallenge = await f.a.challenge(f.creator.address);
    const signature = await sign(f.creator, testChallenge.message);
    await assert.rejects(main.verify(testChallenge.id, signature), { status: 401 });
    const testSession = await f.b.verify(testChallenge.id, signature);
    const mainChallenge = await main.challenge(f.creator.address);
    assert.match(mainChallenge.message, /Network: ae_mainnet/);
    const mainSession = await main.verify(mainChallenge.id, await sign(f.creator, mainChallenge.message));
    await assert.rejects(main.authenticate(`Bearer ${testSession.token}`), { status: 401 });
    await assert.rejects(f.a.authenticate(`Bearer ${mainSession.token}`), { status: 401 });
    await f.a.logout(`Bearer ${mainSession.token}`);
    assert.equal(await main.authenticate(`Bearer ${mainSession.token}`), f.creator.address);
    await main.logoutAll(`Bearer ${mainSession.token}`);
    await assert.rejects(main.authenticate(`Bearer ${mainSession.token}`), { status: 401 });
    assert.equal(await f.a.authenticate(`Bearer ${testSession.token}`), f.creator.address);
  });
  await t.test('a challenge issued on one API can be verified once on another and tokens are hashed', async () => {
    const f = setup(); assert.equal(f.a.shared, true); assert.equal(f.a.connectedWalletAccess, false);
    await assert.rejects(f.a.connect(f.creator.address), { status: 403 });
    const challenge = await f.a.challenge(f.creator.address), signature = await sign(f.creator, challenge.message);
    assert.ok(challenge.message.includes(`Origin: ${f.scope.origin}`)); assert.ok(challenge.message.includes(f.scope.contract));
    assert.ok(challenge.message.includes(new Date(challenge.expiresAt).toISOString()));
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? f.a : f.b).verify(challenge.id, signature)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 401));
    const session = results.find(r => r.status === 'fulfilled').value;
    assert.equal(await f.b.authenticate(`Bearer ${session.token}`), f.creator.address);
    const [stored] = await first.query('SELECT token_hash,expires_at FROM shorts_auth_sessions WHERE contract=$1', [f.scope.contract]);
    assert.equal(stored.token_hash, hash(session.token)); assert.notEqual(stored.token_hash, session.token);
    assert.equal(new Date(stored.expires_at).getTime(), session.expiresAt);
    await assert.rejects(f.a.operator(`Bearer ${session.token}`), { status: 403 });
    const operator = await login(f.b, f.operator);
    assert.equal(await f.a.operator(`Bearer ${operator.token}`), f.operator.address);
  });
  await t.test('invalid signatures consume the nonce and no scope can authenticate or revoke another', async () => {
    const f = setup(), challenge = await f.a.challenge(f.creator.address);
    const signature = await sign(f.creator, challenge.message);
    for (const scope of [{ ...f.scope, network: 'ae_mainnet' }, { ...f.scope, contract: 'ct_other' }, { ...f.scope, origin: 'https://other.example.com' }])
      assert.equal(await repoB.verify(scope, challenge.id, hash(randomUUID()), () => true), undefined);
    await assert.rejects(f.b.verify(challenge.id, await sign(f.operator, challenge.message)), { status: 401 });
    await assert.rejects(f.a.verify(challenge.id, signature), { status: 401 });
    const session = await login(f.a, f.creator);
    for (const scope of [{ ...f.scope, network: 'ae_mainnet' }, { ...f.scope, contract: 'ct_other' }, { ...f.scope, origin: 'https://other.example.com' }]) {
      assert.equal(await repoB.authenticate(scope, hash(session.token)), undefined);
      await repoB.revoke(scope, hash(session.token));
      assert.equal(await repoB.revokeAll(scope, hash(session.token)), false);
    }
    assert.equal(await f.b.authenticate(`Bearer ${session.token}`), f.creator.address);
  });
  await t.test('concurrent challenge requests cannot exceed wallet or deployment bounds', async () => {
    const f = setup();
    let results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.a : f.b).challenge(f.creator.address)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
    results = await Promise.allSettled(Array.from({ length: 110 }, (_, i) => (i % 2 ? f.a : f.b).challenge(`ak_test${i}`)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 97);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 403));
    await first.query("UPDATE shorts_auth_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE contract=$1", [f.scope.contract]);
    await f.b.challenge(f.creator.address);
    const [{ n }] = await second.query('SELECT count(*)::integer AS n FROM shorts_auth_challenges WHERE contract=$1', [f.scope.contract]);
    assert.equal(n, 1);
  });
  await t.test('session limits are checked atomically and expired sessions do not consume capacity', async () => {
    const f = setup();
    for (let i = 0; i < 29; i++) await login(i % 2 ? f.a : f.b, f.creator);
    const challenges = await Promise.all([f.a.challenge(f.creator.address), f.b.challenge(f.creator.address)]);
    const results = await Promise.allSettled(challenges.map(async challenge => f.b.verify(challenge.id, await sign(f.creator, challenge.message))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 403);
    await first.query("UPDATE shorts_auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE contract=$1", [f.scope.contract]);
    const session = results.find(r => r.status === 'fulfilled').value;
    await assert.rejects(f.a.authenticate(`Bearer ${session.token}`), { status: 401 });
    await login(f.b, f.creator);
    const [{ n }] = await second.query('SELECT count(*)::integer AS n FROM shorts_auth_sessions WHERE contract=$1', [f.scope.contract]);
    assert.equal(n, 1);
  });
  await t.test('a challenge that expires while verification waits for a database lock cannot issue a token', async () => {
    const f = setup(), challenge = await f.a.challenge(f.creator.address), signature = await sign(f.creator, challenge.message);
    await first.query("UPDATE shorts_auth_challenges SET expires_at=clock_timestamp()+interval '0.3 second' WHERE contract=$1", [f.scope.contract]);
    const runner = first.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    let verified;
    try {
      await runner.query('SELECT * FROM shorts_auth_scopes WHERE network=$1 AND contract=$2 AND origin=$3 FOR UPDATE', params(f.scope));
      verified = assert.rejects(f.b.verify(challenge.id, signature), { status: 401 });
      await new Promise(resolve => setTimeout(resolve, 400)); await runner.commitTransaction();
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
    await verified;
  });
  await t.test('global session capacity rejects issuance and consumes its challenge without retaining plaintext tokens', async () => {
    const f = setup(), challenge = await f.a.challenge(f.creator.address), signature = await sign(f.creator, challenge.message);
    await first.query(`INSERT INTO shorts_auth_sessions
      SELECT $1,$2,$3,md5(i::text)||md5('other'||i::text),'ak_fixture'||i::text,clock_timestamp()+interval '10 minutes'
      FROM generate_series(1,3000) i`, params(f.scope));
    await assert.rejects(f.b.verify(challenge.id, signature), { status: 403 });
    await assert.rejects(f.a.verify(challenge.id, signature), { status: 401 });
  });
  await t.test('single-token logout is idempotent and account revocation cancels outstanding challenges', async () => {
    const f = setup(), one = await login(f.a, f.creator), two = await login(f.b, f.creator), other = await login(f.b, f.operator);
    const challenge = await f.a.challenge(f.creator.address), signature = await sign(f.creator, challenge.message);
    await f.b.logout(`Bearer ${one.token}`); await f.a.logout(`Bearer ${one.token}`);
    await assert.rejects(f.a.authenticate(`Bearer ${one.token}`), { status: 401 });
    assert.equal(await f.a.authenticate(`Bearer ${two.token}`), f.creator.address);
    await f.a.logoutAll(`Bearer ${two.token}`);
    await assert.rejects(f.b.authenticate(`Bearer ${two.token}`), { status: 401 });
    await assert.rejects(f.b.verify(challenge.id, signature), { status: 401 });
    assert.equal(await f.a.operator(`Bearer ${other.token}`), f.operator.address);
  });
  await t.test('revoking an account and verifying its pending signature cannot leave a late valid session', async () => {
    for (let i = 0; i < 5; i++) {
      const f = setup(), session = await login(f.a, f.creator), challenge = await f.b.challenge(f.creator.address);
      const signature = await sign(f.creator, challenge.message);
      const results = await Promise.allSettled([f.a.logoutAll(`Bearer ${session.token}`), f.b.verify(challenge.id, signature)]);
      assert.equal(results[0].status, 'fulfilled');
      if (results[1].status === 'fulfilled') await assert.rejects(f.a.authenticate(`Bearer ${results[1].value.token}`), { status: 401 });
      else assert.equal(results[1].reason.status, 401);
    }
  });
  await t.test('shared authentication fails closed on database errors without consulting local sessions', async () => {
    const f = setup();
    const broken = new ShortsAuthService({ get db() { assert.fail('No SQLite fallback'); } },
      { release: { network: 'ae_uat', contract: f.scope.contract  }, state: { contract: f.scope.contract } }, new ShortsSessionsService({ query: async () => { throw new Error('Database unavailable'); } }));
    await assert.rejects(broken.authenticate(`Bearer ${'a'.repeat(64)}`), /Database unavailable/);
  });
  await t.test('HTTP sign-in and revocation work across independent API apps with unchanged response shapes', async t => {
    const { NestFactory } = require('@nestjs/core');
    const { ShortsController } = require('./shorts.controller');
    const { ShortsService } = require('./shorts.service');
    const { ShortsUploadsService } = require('./shorts-uploads.service');
    const { ShortsAuthGuard } = require('./shorts-auth.guard');
    const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
    const f = setup(), bases = [];
    for (const auth of [f.a, f.b]) {
      const app = await NestFactory.create({ module: class AuthHttpTestModule {}, controllers: [ShortsController], providers: [
        ShortsAuthGuard, ShortsUploadInterceptor,
        // Isolate session semantics; shared Redis policy is covered by shorts-rates.test.cjs.
        { provide: require('./shorts-rate.service').ShortsRateService, useValue: {
          config: { client: req => req.socket.remoteAddress }, request: async () => {}, actor: async () => {},
        } },
        { provide: ShortsAuthService, useValue: auth },
        { provide: ShortsService, useValue: { dashboard: async address => ({ address }) } },
        { provide: ShortsUploadsService, useValue: {} },
      ] }, { logger: false });
      await app.listen(0, '127.0.0.1'); t.after(() => app.close()); bases.push(await app.getUrl());
    }
    const post = (base, path, body, token) => fetch(`${base}/shorts${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const response = await post(bases[0], '/auth/challenge', { address: f.creator.address });
    assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
    const challenge = await response.json();
    const verification = await post(bases[1], '/auth/verify', { id: challenge.id, signature: await sign(f.creator, challenge.message) });
    assert.equal(verification.status, 201); assert.equal(verification.headers.get('cache-control'), 'no-store');
    const session = await verification.json();
    assert.equal(session.kind, 'wallet-signature'); assert.equal(session.address, f.creator.address);
    const dashboard = await fetch(`${bases[0]}/shorts/dashboard`, { headers: { Authorization: `Bearer ${session.token}` } });
    assert.deepEqual(await dashboard.json(), { address: f.creator.address });
    const logout = await post(bases[1], '/auth/logout', {}, session.token);
    assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { revoked: true });
    const revoked = await fetch(`${bases[0]}/shorts/dashboard`, { headers: { Authorization: `Bearer ${session.token}` } });
    assert.equal(revoked.status, 401); await revoked.arrayBuffer();
    const invalid = await post(bases[1], '/auth/challenge', {});
    assert.equal(invalid.status, 400); await invalid.arrayBuffer();
  });
});
