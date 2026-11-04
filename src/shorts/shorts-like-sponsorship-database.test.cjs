require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const { join } = require('node:path');
const { DataSource } = require('typeorm');
const { AccountMemory, buildTx, buildTxHash, encode, Encoding, Tag, unpackTx } = require('@aeternity/aepp-sdk');
const { AciContractCallEncoder } = require('@aeternity/aepp-calldata');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsLikeSponsorship1792454400000 } = require('../migrations/1792454400000-ShortsLikeSponsorship');
const { ShortsLikeSponsorshipRepository } = require('./shorts-like-sponsorship-repository.service');
const { ShortsLikeSponsorWorker } = require('./shorts-like-sponsor-worker.service');
const { PublisherAttempt } = require('./shorts-publisher-attempt');

const address = kind => encode(randomBytes(32), kind);
const defaultPolicy = {
  gasLimit: 100000, gasPrice: '1000000000', maxFee: '1000000000000000',
  maxTransactionCost: '3000000000000000', rollingCostLimit: '30000000000000000',
  maxPending: 10, maxActorPerDay: 20, maxRequestsPerDay: 100, ttlBlocks: 20,
};

// Opt-in and loopback-only: this suite owns a random schema and random QA roles.
// It never connects to a chain, funds an account, or changes an existing schema.
test('Like sponsorship PostgreSQL authority, concurrency and durable recovery', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 120000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_like_sponsor_${randomUUID().replaceAll('-', '')}`;
  const admin = await new DataSource({ type: 'postgres', url: url.href, logging: false }).initialize();
  const roles = [], pools = [];
  let owner;
  t.after(async () => {
    for (const pool of pools) if (pool.isInitialized) await pool.destroy();
    if (owner?.isInitialized) await owner.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of roles) {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
    await admin.destroy();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  owner = await new DataSource({ type: 'postgres', url: url.href, schema,
    extra: { options: `-c search_path=${schema}`, max: 12, statement_timeout: 10000 }, logging: false,
    migrations: [ShortsMetadata1791763200000, ShortsLikeSponsorship1792454400000],
  }).initialize();
  await owner.runMigrations({ transaction: 'all' });

  async function role(binding, kind, enroll = true) {
    const name = `shlike_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    roles.push(name);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION ${schema}.shorts_like_sponsorship(text,jsonb) TO ${name}`);
    if (enroll) await owner.query(`INSERT INTO shorts_like_sponsor_principals(role_oid,role_name,kind,network,contract)
      SELECT oid,rolname,$2,$3,$4 FROM pg_roles WHERE rolname=$1`, [name, kind, binding.network, binding.contract]);
    const endpoint = new URL(url); endpoint.username = name; endpoint.password = password;
    const db = await new DataSource({ type: 'postgres', url: endpoint.href,
      extra: { options: `-c search_path=${schema}`, max: 8, statement_timeout: 10000 }, logging: false,
    }).initialize();
    pools.push(db);
    const config = { enabled: true, release: binding, policy: binding.policy, payer: binding.payer };
    const repository = new ShortsLikeSponsorshipRepository(config);
    repository.db = db;
    return { name, db, repository, config };
  }
  async function fixture(overrides = {}, shared, payerAccount) {
    const policy = shared?.policy ?? { ...defaultPolicy, ...overrides };
    const payer = shared?.payer ?? payerAccount?.address ?? AccountMemory.generate().address;
    const binding = { network: 'ae_uat', contract: address(Encoding.ContractAddress), sourceHash: 'a'.repeat(64), payer, policy };
    await owner.query('INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,100,10)',
      [binding.network, binding.contract, binding.sourceHash]);
    if (!shared) await owner.query('INSERT INTO shorts_like_sponsor_accounts(network,payer,policy,paused) VALUES($1,$2,$3,false)',
      [binding.network, payer, policy]);
    await owner.query('INSERT INTO shorts_like_sponsor_deployments(network,contract,source_hash,payer) VALUES($1,$2,$3,$4)',
      [binding.network, binding.contract, binding.sourceHash, payer]);
    return { binding, policy, payer, api: await role(binding, 'api'), signer: await role(binding, 'signer') };
  }
  async function call(p, binding, action, data = {}) {
    const [anchor] = await owner.query('SELECT anchor_version FROM shorts_like_sponsor_accounts WHERE network=$1 AND payer=$2', [binding.network, binding.payer]);
    const [row] = await p.db.query('SELECT shorts_like_sponsorship($1,$2::jsonb) AS result',
      [action, JSON.stringify({ ...binding, admissionEnabled: true, anchorVersion: Number(anchor?.anchor_version ?? 0), ...data })]);
    return row.result;
  }
  const request = (data = {}) => ({ id: randomUUID(), innerHash: address(Encoding.TxHash),
    actor: AccountMemory.generate().address, videoId: randomUUID(), rawInner: 'tx_test_inner',
    intent: { nonce: 1, ttl: 110, version: '3' }, ...data });
  const identity = job => ({ innerHash: job.inner_hash, token: job.lease_token, fence: job.fence });
  const get = async (f, hash) => (await owner.query('SELECT * FROM shorts_like_sponsorship_jobs WHERE network=$1 AND contract=$2 AND inner_hash=$3',
    [f.binding.network, f.binding.contract, hash]))[0];
  async function enqueue(f, req = request()) { await call(f.api, f.binding, 'enqueue', req); return req; }
  const claim = (f, signer = f.signer) => call(signer, f.binding, 'claim', { token: randomUUID() });
  async function reserve(f, job, nonce = 1, cost = '100', unsignedOuter = 'tx_unsigned_outer') {
    return call(f.signer, f.binding, 'reserve', { ...identity(job), unsignedOuter, nonce, cost });
  }
  async function persist(f, job, nonce = 1, cost = '100') {
    const reserved = await reserve(f, job, nonce, cost);
    return call(f.signer, f.binding, 'persist', { ...identity(reserved), nonce, cost,
      unsignedOuter: reserved.prepared_outer, rawOuter: 'tx_signed_outer', outerHash: address(Encoding.TxHash) });
  }
  const settle = (f, job, result = 'ok') => call(f.signer, f.binding, 'settle', { ...identity(job),
    outerHash: job.outer_hash, blockHash: address(Encoding.MicroBlockHash), height: 100, result });
  const expireLease = (f, hash) => owner.query(`UPDATE shorts_like_sponsorship_jobs SET lease_until=clock_timestamp()-interval '1 second'
    WHERE network=$1 AND contract=$2 AND inner_hash=$3`, [f.binding.network, f.binding.contract, hash]);
  const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

  await t.test('migration has no enrolled principal, payer or public execution grant', async () => {
    for (const table of ['shorts_like_sponsor_principals', 'shorts_like_sponsor_accounts', 'shorts_like_sponsorship_jobs'])
      assert.equal((await owner.query(`SELECT count(*)::integer AS count FROM ${table}`))[0].count, 0);
    const [{ granted }] = await owner.query(`SELECT EXISTS(SELECT FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      WHERE p.oid='${schema}.shorts_like_sponsorship(text,jsonb)'::regprocedure AND x.grantee=0 AND x.privilege_type='EXECUTE') AS granted`);
    assert.equal(granted, false);
  });

  await t.test('restricted API and signer roles cannot cross actions or directly mutate state', async () => {
    const f = await fixture();
    assert.deepEqual(await call(f.api, f.binding, 'verify'), { kind: 'api', paused: false, quarantined: false });
    assert.deepEqual(await call(f.signer, f.binding, 'verify'), { kind: 'signer', paused: false, quarantined: false });
    for (const p of [f.api, f.signer]) for (const sql of [
      'SELECT * FROM shorts_like_sponsorship_jobs', 'SELECT raw_inner FROM shorts_like_sponsorship_jobs',
      'UPDATE shorts_like_sponsor_accounts SET paused=false', 'DELETE FROM shorts_like_sponsorship_jobs',
      'TRUNCATE shorts_like_sponsorship_jobs', 'CREATE TABLE forbidden(value text)',
    ]) await rejects(p.db.query(sql), '42501');
    for (const action of ['claim', 'reserve', 'persist', 'authorize', 'settle', 'release', 'reject', 'expire'])
      await rejects(call(f.api, f.binding, action), 'SH401');
    for (const action of ['enqueue', 'status']) await rejects(call(f.signer, f.binding, action), 'SH401');
    await rejects(call(f.api, f.binding, null), 'SH400');
    for (const data of [{ sourceHash: 'b'.repeat(64) }, { contract: address(Encoding.ContractAddress) },
      { payer: AccountMemory.generate().address }, { network: 'ae_mainnet' }, { policy: { ...f.policy, maxPending: 11 } }])
      await rejects(call(f.api, f.binding, 'verify', data), 'SH401');
    await owner.query('UPDATE shorts_runtime SET source_hash=$1 WHERE contract=$2', ['b'.repeat(64), f.binding.contract]);
    await rejects(call(f.api, f.binding, 'verify'), 'SH401');
  });

  await t.test('enrollment rejects missing, revoked, renamed, inherited or overprivileged logins', async () => {
    const f = await fixture(), unregistered = await role(f.binding, 'api', false);
    await rejects(call(unregistered, f.binding, 'verify'), 'SH401');
    const verify = () => call(f.api, f.binding, 'verify');
    for (const [grant, revoke] of [
      [`GRANT SELECT(raw_inner) ON ${schema}.shorts_like_sponsorship_jobs TO ${f.api.name}`, `REVOKE SELECT(raw_inner) ON ${schema}.shorts_like_sponsorship_jobs FROM ${f.api.name}`],
      [`GRANT SELECT ON ${schema}.shorts_content TO ${f.api.name}`, `REVOKE SELECT ON ${schema}.shorts_content FROM ${f.api.name}`],
      [`GRANT CREATE ON SCHEMA ${schema} TO ${f.api.name}`, `REVOKE CREATE ON SCHEMA ${schema} FROM ${f.api.name}`],
      [`GRANT ${unregistered.name} TO ${f.api.name}`, `REVOKE ${unregistered.name} FROM ${f.api.name}`],
      [`ALTER ROLE ${f.api.name} CREATEDB`, `ALTER ROLE ${f.api.name} NOCREATEDB`],
      [`ALTER ROLE ${f.api.name} BYPASSRLS`, `ALTER ROLE ${f.api.name} NOBYPASSRLS`],
    ]) { await admin.query(grant); await rejects(verify(), 'SH401'); await admin.query(revoke); await verify(); }
    await owner.query(`CREATE FUNCTION ${schema}.unrelated_privilege() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
    await rejects(verify(), 'SH401');
    await owner.query(`DROP FUNCTION ${schema}.unrelated_privilege()`);
    await owner.query('UPDATE shorts_like_sponsor_principals SET role_name=$1 WHERE role_name=$2', ['renamed', f.api.name]);
    await rejects(verify(), 'SH401');
    await owner.query('UPDATE shorts_like_sponsor_principals SET role_name=$1 WHERE role_name=$2', [f.api.name, 'renamed']);
    await owner.query('UPDATE shorts_like_sponsor_principals SET role_oid=0 WHERE role_name=$1', [f.api.name]);
    await rejects(verify(), 'SH401');
    await owner.query('UPDATE shorts_like_sponsor_principals SET role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1),enabled=false WHERE role_name=$1', [f.api.name]);
    await rejects(verify(), 'SH401');
  });

  await t.test('temporary shadow tables cannot alter binding and public status omits signed bytes', async () => {
    const f = await fixture();
    await f.api.db.query('CREATE TEMP TABLE shorts_like_sponsor_accounts(paused boolean)');
    await f.api.db.query('CREATE TEMP TABLE shorts_like_sponsorship_jobs(raw_inner text)');
    await call(f.api, f.binding, 'verify');
    const req = await enqueue(f), job = await persist(f, await claim(f));
    const status = await call(f.api, f.binding, 'status', req);
    assert.equal(status.status, 'signed'); assert.equal(status.outerHash, job.outer_hash);
    for (const key of ['raw_inner', 'rawInner', 'raw_outer', 'rawOuter', 'prepared_outer', 'lease_token', 'lease_principal'])
      assert.equal(Object.hasOwn(status, key), false);
  });

  await t.test('concurrent identical retries create one immutable request and enforce membership and actor identity', async () => {
    const f = await fixture(), req = request();
    const responses = await Promise.all(Array.from({ length: 8 }, () => call(f.api, f.binding, 'enqueue', req)));
    assert.ok(responses.every(row => row.innerHash === req.innerHash));
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM shorts_like_sponsorship_jobs WHERE contract=$1', [f.binding.contract]))[0].count, 1);
    for (const data of [{ rawInner: 'tx_different' }, { videoId: 'different' }, { id: randomUUID() }, { intent: { ...req.intent, nonce: 2 } }])
      await rejects(call(f.api, f.binding, 'enqueue', { ...req, ...data }), 'SH409');
    await rejects(call(f.api, f.binding, 'status', { ...req, actor: AccountMemory.generate().address }), 'SH401');
    await rejects(call(f.api, f.binding, 'enqueue', { ...req, innerHash: address(Encoding.TxHash) }), 'SH409');
    await rejects(call(f.api, f.binding, 'enqueue', { ...req, id: randomUUID(), innerHash: address(Encoding.TxHash) }), 'SH409');
  });

  await t.test('pending admission is atomic across deployments sharing the same payer', async () => {
    const f = await fixture({ maxPending: 3 }), other = await fixture({}, f);
    const responses = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => enqueue(i % 2 ? f : other)));
    assert.equal(responses.filter(row => row.status === 'fulfilled').length, 3);
    assert.ok(responses.filter(row => row.status === 'rejected').every(row => row.reason.code === 'SH503'));
    assert.equal((await owner.query("SELECT count(*)::integer AS count FROM shorts_like_sponsorship_jobs WHERE payer=$1 AND status='queued'", [f.payer]))[0].count, 3);
  });

  await t.test('daily request and actor limits count rejected attempts across contracts', async () => {
    const f = await fixture({ maxActorPerDay: 2, maxRequestsPerDay: 3 }), other = await fixture({}, f);
    const actor = AccountMemory.generate().address;
    for (const target of [f, other]) {
      const req = request({ actor });
      assert.equal((await call(target.api, target.binding, 'enqueue', { ...req, admissionEnabled: false })).status, 'rejected');
    }
    await rejects(enqueue(f, request({ actor })), 'SH503');
    await call(other.api, other.binding, 'enqueue', { ...request(), admissionEnabled: false });
    await rejects(enqueue(f), 'SH503');
  });

  await t.test('many distinct actors cannot exceed the shared global request budget during concurrent rejection', async () => {
    const f = await fixture({ maxPending: 6, maxActorPerDay: 1, maxRequestsPerDay: 20 });
    const other = await fixture({}, f);
    const requests = Array.from({ length: 64 }, () => request());
    assert.equal(new Set(requests.map(r => r.actor)).size, 64);
    const results = await Promise.allSettled(requests.map((req, i) => call(i % 2 ? other.api : f.api,
      i % 2 ? other.binding : f.binding, 'enqueue', { ...req, admissionEnabled: false })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 20);
    assert.ok(results.filter(r => r.status === 'fulfilled').every(r => r.value.status === 'rejected'));
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'SH503'));
    const [totals] = await owner.query(`SELECT count(*)::int AS requests,count(DISTINCT actor)::int AS actors,
      count(raw_outer)::int AS signed,count(prepared_outer)::int AS reserved,coalesce(sum(broadcast_attempts),0)::int AS broadcasts
      FROM shorts_like_sponsorship_jobs WHERE payer=$1`, [f.payer]);
    assert.deepEqual(totals, { requests: 20, actors: 20, signed: 0, reserved: 0, broadcasts: 0 });
    const [account] = await owner.query('SELECT policy FROM shorts_like_sponsor_accounts WHERE payer=$1', [f.payer]);
    assert.deepEqual(account.policy, f.policy);
  });

  await t.test('one concurrent lease wins, expires safely and fences a stale or different signer', async () => {
    const f = await fixture(), other = await role(f.binding, 'signer');
    await enqueue(f); await enqueue(f);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(f, i % 2 ? f.signer : other)));
    const old = claims.find(Boolean);
    assert.equal(claims.filter(Boolean).length, 1);
    const oldSigner = String(old.lease_principal) === String((await owner.query('SELECT oid FROM pg_roles WHERE rolname=$1', [f.signer.name]))[0].oid) ? f.signer : other;
    const replacement = oldSigner === f.signer ? other : f.signer;
    await rejects(call(replacement, f.binding, 'release', identity(old)), 'SH409');
    await expireLease(f, old.inner_hash);
    await rejects(call(oldSigner, f.binding, 'reserve', { ...identity(old), unsignedOuter: 'tx_unsigned', nonce: 1, cost: '100' }), 'SH409');
    const fresh = await claim(f, replacement);
    assert.equal(fresh.inner_hash, old.inner_hash); assert.equal(Number(fresh.fence), Number(old.fence) + 1);
    await rejects(call(oldSigner, f.binding, 'reject', identity(old)), 'SH409');
    await call(replacement, f.binding, 'release', identity(fresh));
    assert.equal((await get(f, fresh.inner_hash)).status, 'queued');
  });

  await t.test('exact reservation, payer nonce and budget persist before broadcast authorization', async () => {
    const f = await fixture(); await enqueue(f); const job = await claim(f);
    await rejects(call(f.signer, f.binding, 'authorize', identity(job)), 'SH409');
    await rejects(call(f.signer, f.binding, 'persist', { ...identity(job), unsignedOuter: 'tx_no_reservation',
      rawOuter: 'tx_no_reservation', outerHash: address(Encoding.TxHash), nonce: 1, cost: '100' }), 'SH409');
    const reservation = await reserve(f, job);
    assert.equal(reservation.prepared_cost, '100'); assert.equal(reservation.raw_outer, null);
    assert.equal((await reserve(f, job)).prepared_outer, reservation.prepared_outer);
    for (const change of [{ unsignedOuter: 'tx_other' }, { nonce: 2 }, { cost: '101' }])
      await rejects(call(f.signer, f.binding, 'reserve', { ...identity(job), unsignedOuter: reservation.prepared_outer, nonce: 1, cost: '100', ...change }), 'SH409');
    const signed = await persist(f, job);
    assert.equal(signed.prepared_outer, reservation.prepared_outer);
    assert.equal(signed.reserved_cost, reservation.prepared_cost);
    assert.equal(await call(f.signer, f.binding, 'authorize', identity(signed)), true);
    assert.equal(await call(f.signer, f.binding, 'authorize', identity(signed)), false);
    assert.equal((await get(f, signed.inner_hash)).broadcast_attempts, 1);
    await rejects(call(f.signer, f.binding, 'reject', identity(signed)), 'SH409');
    await call(f.signer, f.binding, 'release', identity(signed));
    const recovered = await claim(f);
    assert.equal(recovered.raw_inner, signed.raw_inner); assert.equal(recovered.raw_outer, signed.raw_outer);
    assert.equal(recovered.payer_nonce, signed.payer_nonce); assert.equal(recovered.reserved_cost, signed.reserved_cost);
  });

  await t.test('pause blocks new reservations and broadcast while preserving observation and settlement', async () => {
    const f = await fixture(), req = await enqueue(f); const signed = await persist(f, await claim(f));
    await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=true WHERE payer=$1', [f.payer]);
    assert.equal(await call(f.signer, f.binding, 'authorize', identity(signed)), false);
    assert.equal((await call(f.api, f.binding, 'status', req)).status, 'signed');
    const paused = await enqueue(f); assert.equal((await get(f, paused.innerHash)).status, 'rejected');
    await settle(f, signed);
    assert.equal((await get(f, signed.inner_hash)).status, 'confirmed');
    assert.equal(await claim(f), null);
    await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=false WHERE payer=$1', [f.payer]);
    await enqueue(f); const next = await claim(f);
    await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=true WHERE payer=$1', [f.payer]);
    await rejects(reserve(f, next, 2), 'SH409');
  });

  await t.test('canonical settlement fields are mandatory and settled nonces cannot be reused', async () => {
    const f = await fixture(); await enqueue(f); const signed = await persist(f, await claim(f));
    const valid = { ...identity(signed), outerHash: signed.outer_hash, blockHash: address(Encoding.MicroBlockHash), height: 100, result: 'ok' };
    for (const key of ['outerHash', 'blockHash', 'height', 'result']) {
      const invalid = { ...valid }; delete invalid[key];
      await rejects(call(f.signer, f.binding, 'settle', invalid), 'SH400');
    }
    await settle(f, signed, 'revert');
    const repeated = request({ actor: signed.actor, videoId: signed.video_id });
    await enqueue(f, repeated); const next = await claim(f);
    await rejects(reserve(f, next, 1), 'SH409');
    assert.equal(Number((await reserve(f, next, 2)).prepared_nonce), 2);
  });

  await t.test('expiry frees a proven unused nonce and membership but retains signed bytes and spend reservation', async () => {
    const f = await fixture({ rollingCostLimit: '150' }); await enqueue(f);
    const signed = await persist(f, await claim(f));
    const proof = { ttl: 110, height: 113, blockHash: address(Encoding.KeyBlockHash), payerNonce: 0 };
    for (const change of [{ ttl: 109 }, { height: 112 }, { payerNonce: 1 }, { blockHash: address(Encoding.MicroBlockHash) }])
      await rejects(call(f.signer, f.binding, 'expire', { ...identity(signed), expiryProof: { ...proof, ...change } }), 'SH400');
    await call(f.signer, f.binding, 'expire', { ...identity(signed), expiryProof: proof });
    const expired = await get(f, signed.inner_hash);
    assert.equal(expired.status, 'expired'); assert.equal(expired.raw_outer, signed.raw_outer);
    assert.equal(expired.raw_inner, signed.raw_inner); assert.equal(expired.reserved_cost, '100');
    const retry = request({ actor: signed.actor, videoId: signed.video_id }); await enqueue(f, retry);
    const next = await claim(f);
    await rejects(reserve(f, next, 1, '100'), 'SH503');
    assert.equal(Number((await reserve(f, next, 1, '50')).prepared_nonce), 1);
    assert.equal((await get(f, next.inner_hash)).prepared_cost, '50');
  });

  await t.test('rejected unsigned reservations retain rolling cost and shared-payer settlement retains nonce history', async () => {
    const f = await fixture({ rollingCostLimit: '150' }), other = await fixture({}, f);
    await enqueue(f); const first = await reserve(f, await claim(f), 1, '100');
    await call(f.signer, f.binding, 'reject', identity(first));
    await enqueue(other); const next = await claim(other);
    await rejects(reserve(other, next, 1, '100'), 'SH503');
    const signed = await persist(other, next, 1, '50');
    await settle(other, signed);
    await enqueue(f); const another = await claim(f);
    await rejects(reserve(f, another, 1, '1'), 'SH409');
    await rejects(reserve(f, another, 2, '1'), 'SH503');
  });

  await t.test('worker recovery uses actual database commit before broadcast after a lost persistence acknowledgement', async () => {
    const actor = AccountMemory.generate(), payer = AccountMemory.generate();
    const live = await fixture();
    const oldPayer = live.payer;
    await owner.query('INSERT INTO shorts_like_sponsor_accounts(network,payer,policy,paused) VALUES($1,$2,$3,false)', ['ae_uat', payer.address, live.policy]);
    await owner.query('UPDATE shorts_like_sponsor_deployments SET payer=$1 WHERE contract=$2', [payer.address, live.binding.contract]);
    live.binding.payer = payer.address; live.payer = payer.address;
    for (const principal of [live.api, live.signer]) { principal.config.payer = payer.address; }
    assert.notEqual(oldPayer, live.payer);
    const coder = new AciContractCallEncoder([{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
      { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'version', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true },
    ] } }]);
    const unsigned = buildTx({ tag: Tag.ContractCallTx, callerId: actor.address, contractId: live.binding.contract,
      abiVersion: 3, amount: 0, nonce: 1, ttl: 110, gasLimit: 100000, gasPrice: defaultPolicy.gasPrice,
      fee: '300000000000000', callData: coder.encodeCall('Shorts', 'like', ['video-id', 3]) });
    const inner = await actor.signTransaction(unsigned, { networkId: 'ae_uat', innerTx: true });
    const req = request({ actor: actor.address, innerHash: buildTxHash(inner), rawInner: inner, videoId: 'video-id' });
    await live.api.repository.call('enqueue', req);
    let signatures = 0, broadcast = 0, loseAcknowledgement = true;
    const actual = live.signer.repository;
    const repository = { call: async (action, args) => {
      const response = await actual.call(action, args);
      if (action === 'persist' && loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Simulated lost acknowledgement after commit'); }
      return response;
    } };
    const worker = new ShortsLikeSponsorWorker(live.signer.config, repository);
    worker.verify = async () => ({ likesEnabled: true, version: '3' });
    worker.contract = { $call: async () => ({ decodedResult: { importing: false, frozen: false, abandoned: false } }) };
    worker.account = { signTransaction: async raw => {
      signatures++; const saved = await get(live, req.innerHash);
      assert.equal(saved.prepared_outer, raw); assert.equal(saved.raw_outer, null);
      return payer.signTransaction(raw, { networkId: 'ae_uat' });
    } };
    const top = { height: 100, hash: address(Encoding.MicroBlockHash) };
    const key = { height: 100, hash: address(Encoding.KeyBlockHash) };
    worker.node = {
      getStatus: async () => ({ networkId: 'ae_uat' }), getTopHeader: async () => top,
      getCurrentKeyBlock: async () => key,
      getAccountByPubkeyAndHash: async () => ({ kind: 'basic', nonce: 0 }),
      getAccountByPubkey: async () => ({ kind: 'basic', nonce: 0, balance: 1000000000000000000n }),
      getRecentGasPrices: async () => [{ minGasPrice: 1000000000n, utilization: 0 }],
      protectedDryRunTxs: async () => ({ results: [{ result: 'ok', callObj: { returnType: 'ok', callerId: actor.address,
        callerNonce: 1, contractId: live.binding.contract } }] }),
      getTransactionByHash: async () => { throw { statusCode: 404 }; },
      postTransaction: async ({ tx }) => {
        broadcast++; const saved = await get(live, req.innerHash);
        assert.equal(saved.status, 'signed'); assert.equal(saved.raw_outer, tx); assert.equal(saved.outer_hash, buildTxHash(tx));
        assert.equal(saved.broadcast_attempts, broadcast);
        return { txHash: buildTxHash(tx) };
      },
    };
    const run = async () => { const attempt = new PublisherAttempt(new AbortController().signal, 10000);
      try { return await attempt.run(() => worker.process(attempt)); } finally { attempt.close(); } };
    await assert.rejects(run(), /lost acknowledgement/);
    const saved = await get(live, req.innerHash);
    assert.equal(saved.status, 'signed'); assert.equal(signatures, 1); assert.equal(broadcast, 0);
    await run();
    assert.equal(signatures, 1); assert.equal(broadcast, 1);
    const restored = await get(live, req.innerHash);
    assert.equal(restored.raw_outer, saved.raw_outer); assert.equal(restored.raw_inner, inner);
    assert.equal(unpackTx(restored.raw_outer).encodedTx.payerId, payer.address);
  });

  await t.test('killed signer processes recover the same durable intent across claim, reserve, sign, persist and broadcast', async t => {
    const run = (input, kill = false) => new Promise((resolve, reject) => {
      const child = fork(join(__dirname, 'shorts-like-sponsor-process.fixture.cjs'), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, SHORTS_TEST_PG_URL: '', DOTENV_CONFIG_PATH: '/dev/null' },
      });
      // Capture only protocol metadata. SDK diagnostics can contain signed bytes.
      child.stdout.resume(); child.stderr.resume();
      let result;
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child fixture deadline')); }, 20000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('message', message => {
        if (message.type === 'error') return;
        result = message;
        if (kill && message.type === 'boundary') child.kill('SIGKILL');
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        if ((kill && signal === 'SIGKILL' && result?.type === 'boundary')
          || (!kill && code === 0 && result?.type === 'done')) resolve(result);
        else reject(new Error('Child fixture did not reach its expected boundary'));
      });
      child.send(input);
    });
    for (const stage of ['claim', 'reserve', 'sign', 'persist', 'broadcast']) {
      const actor = AccountMemory.generate(), payer = AccountMemory.generate();
      const f = await fixture({}, undefined, payer);
      const coder = new AciContractCallEncoder([{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
        { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'version', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true },
      ] } }]);
      const inner = await actor.signTransaction(buildTx({ tag: Tag.ContractCallTx, callerId: actor.address,
        contractId: f.binding.contract, abiVersion: 3, amount: 0, nonce: 1, ttl: 110, gasLimit: 100000,
        gasPrice: defaultPolicy.gasPrice, fee: '300000000000000', callData: coder.encodeCall('Shorts', 'like', ['crash-qa', 3]) }),
      { networkId: 'ae_uat', innerTx: true });
      const req = request({ actor: actor.address, innerHash: buildTxHash(inner), rawInner: inner, videoId: 'crash-qa' });
      await f.api.repository.call('enqueue', req);
      const input = { url: f.signer.db.options.url, schema, config: f.signer.config, payerSecret: payer.secretKey,
        actor: actor.address, microHash: address(Encoding.MicroBlockHash), keyHash: address(Encoding.KeyBlockHash) };
      const killed = await run({ ...input, stop: stage }, true);
      const before = await get(f, req.innerHash);
      assert.ok(before.raw_inner === inner, 'Original inner bytes must survive process death');
      assert.equal(before.broadcast_attempts, stage === 'broadcast' ? 1 : 0);
      assert.equal(!!before.prepared_outer, stage !== 'claim');
      assert.equal(!!before.raw_outer, ['persist', 'broadcast'].includes(stage));
      // Accelerate only this isolated schema's lease clock; public worker timings are unchanged.
      await expireLease(f, req.innerHash);
      if (stage === 'persist') {
        // Admission-off drains existing signed work; the durable payer pause is
        // the emergency broadcast stop. Test both configurations while paused.
        await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=true WHERE payer=$1', [f.payer]);
        const disabled = await run({ ...input, config: { ...input.config, enabled: false } });
        assert.equal(disabled.signatures, 0); assert.equal(disabled.broadcasts, 0);
        const paused = await run(input);
        assert.equal(paused.signatures, 0); assert.equal(paused.broadcasts, 0);
        const retained = await get(f, req.innerHash);
        assert.ok(retained.raw_outer === before.raw_outer, 'Paused restart must retain signed bytes');
        assert.equal(retained.reserved_cost, before.reserved_cost);
        assert.equal(retained.broadcast_attempts, 0);
        // Resume only this fixture's explicit test authorization after pause coverage.
        await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=false WHERE payer=$1', [f.payer]);
      }
      const resumed = await run({ ...input,
        config: stage === 'persist' ? { ...input.config, enabled: false } : input.config,
        observedOuter: stage === 'broadcast' ? before.raw_outer : undefined });
      assert.notEqual(killed.pid, resumed.pid);
      let after = await get(f, req.innerHash);
      assert.ok(after.raw_inner === inner, 'Recovery must retain the exact inner envelope');
      if (before.prepared_outer) assert.ok(after.prepared_outer === before.prepared_outer, 'Prepared bytes changed');
      if (before.raw_outer) assert.ok(after.raw_outer === before.raw_outer, 'Signed outer bytes changed');
      if (killed.signedHash) assert.equal(after.outer_hash, killed.signedHash, 'Pre-persist deterministic signature changed');
      if (killed.broadcastHash) assert.equal(after.outer_hash, killed.broadcastHash);
      assert.equal(resumed.signatures, ['persist', 'broadcast'].includes(stage) ? 0 : 1);
      assert.equal(resumed.broadcasts, stage === 'broadcast' ? 0 : 1);
      assert.equal(after.broadcast_attempts, 1);
      if (stage !== 'broadcast') {
        const settled = await run({ ...input, observedOuter: after.raw_outer });
        assert.equal(settled.signatures, 0); assert.equal(settled.broadcasts, 0);
        after = await get(f, req.innerHash);
      }
      assert.equal(after.status, 'confirmed');
      assert.equal(Number(after.payer_nonce), 1);
      assert.equal(after.reserved_cost, after.prepared_cost);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM shorts_like_sponsorship_jobs WHERE contract=$1', [f.binding.contract]))[0].n, 1);
      t.diagnostic(JSON.stringify({ stage, killedPid: killed.pid, resumedPid: resumed.pid,
        signaturesBeforeCrash: killed.signatures, signaturesAfterRestart: resumed.signatures,
        outerHash: after.outer_hash, broadcastAttempts: after.broadcast_attempts, reservedCost: after.reserved_cost,
        status: after.status, admissionEnabledAtRestart: stage !== 'persist',
        durablePauseBlocksBroadcastChecked: stage === 'persist',
        chainEvidence: 'simulated canonical node response', lease: 'test-owned expiry accelerated' }));
    }
  });


  await t.test('payer quarantine fences every binding and enforces explicit recovery with admission disabled', async () => {
    const f = await fixture(), other = await fixture({}, f);
    await enqueue(f); const first = await persist(f, await claim(f)); await settle(f, first);
    await enqueue(other); const claimed = await claim(other);
    const previous = await call(f.signer, f.binding, 'anchor');
    for (const data of [{}, { recovery: true }, { admissionEnabled: false }])
      await rejects(call(f.signer, f.binding, 'quarantine', { reason: 'bootstrap', ...data }), 'SH401');
    await call(f.signer, f.binding, 'quarantine', { reason: 'anchor_changed' });
    await rejects(call(other.signer, other.binding, 'reserve', { ...identity(claimed), nonce: 2, cost: '100', unsignedOuter: 'tx_qa' }), 'SH409');
    assert.equal((await get(other, claimed.inner_hash)).status, 'rejected');
    assert.equal(await claim(other), null);
    assert.equal((await call(other.api, other.binding, 'enqueue', request())).status, 'rejected');
    for (const data of [{}, { recovery: true }, { admissionEnabled: false }]) {
      await rejects(call(f.signer, f.binding, 'claim_recovery', { token: randomUUID(), ...data }), 'SH401');
      await rejects(call(f.signer, f.binding, 'recovery_finish', data), 'SH401');
    }
    const mode = { recovery: true, admissionEnabled: false };
    await rejects(call(f.signer, f.binding, 'claim_recovery', { ...mode, token: randomUUID(), anchorVersion: previous.version }), 'SH409');
    await rejects(call(f.signer, f.binding, 'recovery_finish', mode), 'SH409');
    const restored = await call(f.signer, f.binding, 'claim_recovery', { ...mode, token: randomUUID() });
    assert.equal(restored.status, 'recovering');
    assert.equal(restored.raw_outer, first.raw_outer); assert.equal(restored.reserved_cost, first.reserved_cost);
    assert.equal(restored.settlement_history[0].status, 'confirmed');
    for (const data of [{}, { recovery: true }, { admissionEnabled: false }])
      assert.equal(await call(f.signer, f.binding, 'authorize', { ...identity(restored), ...data }), false);
    await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=true WHERE payer=$1', [f.payer]);
    assert.equal(await call(f.signer, f.binding, 'authorize', { ...identity(restored), ...mode }), false);
    await call(f.signer, f.binding, 'settle', { ...identity(restored), ...mode, outerHash: restored.outer_hash,
      blockHash: first.block_hash || address(Encoding.MicroBlockHash), height: 100, result: 'ok' });
    await call(f.signer, f.binding, 'recovery_finish', mode);
    const state = await call(f.signer, f.binding, 'recovery_status');
    assert.equal(state.quarantined, false); assert.equal(state.paused, true); assert.equal(state.remaining, 0);
  });

  await t.test('orphan recovery preserves expiry across nonce reuse then reconciles exact later envelopes in order', async () => {
    const payer = AccountMemory.generate(), f = await fixture({}, undefined, payer);
    const { sponsoredLikeTransaction } = require('./shorts-like-sponsorship-transaction');
    const coder = new AciContractCallEncoder([{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
      { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'version', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true },
    ] } }]);
    async function signed(id, nonce, ttl) {
      const actor = AccountMemory.generate();
      const rawInner = await actor.signTransaction(buildTx({ tag: Tag.ContractCallTx, callerId: actor.address,
        contractId: f.binding.contract, abiVersion: 3, amount: 0, nonce: 1, ttl, gasLimit: 100000,
        gasPrice: defaultPolicy.gasPrice, fee: '300000000000000', callData: coder.encodeCall('Shorts', 'like', [id, 3]) }), { networkId: 'ae_uat', innerTx: true });
      await enqueue(f, request({ actor: actor.address, rawInner, innerHash: buildTxHash(rawInner), videoId: id, intent: { nonce: 1, ttl, version: '3' } }));
      const job = await claim(f);
      const unsignedOuter = buildTx({ tag: Tag.PayingForTx, payerId: payer.address, nonce, fee: '300000000000000', tx: rawInner });
      const rawOuter = await payer.signTransaction(unsignedOuter, { networkId: 'ae_uat' });
      const cost = sponsoredLikeTransaction(rawOuter, rawInner, { actor: actor.address, contract: f.binding.contract, network: 'ae_uat', payer: payer.address, policy: f.policy }).cost;
      const reserved = await reserve(f, job, nonce, cost, unsignedOuter);
      return call(f.signer, f.binding, 'persist', { ...identity(reserved), unsignedOuter, nonce, cost, rawOuter, outerHash: buildTxHash(rawOuter) });
    }
    const expiryKey = { hash: address(Encoding.KeyBlockHash), height: 113 };
    const a = await signed('expired-a', 1, 110);
    const expiry = { ttl: 110, height: 113, blockHash: expiryKey.hash, payerNonce: 0 };
    await call(f.signer, f.binding, 'expire', { ...identity(a), expiryProof: expiry });
    const b = await signed('replacement-b', 1, 140), oldBlock = address(Encoding.MicroBlockHash);
    await call(f.signer, f.binding, 'settle', { ...identity(b), outerHash: b.outer_hash, blockHash: oldBlock, height: 120, result: 'ok' });
    const c = await signed('later-c', 2, 150);
    await call(f.signer, f.binding, 'release', identity(c));
    const records = new Map(), generations = new Map(), key = { height: 123, hash: address(Encoding.KeyBlockHash) };
    let payerNonce = 1, broadcasts = 0;
    function envelope(raw) {
      const value = unpackTx(raw), tx = value.encodedTx;
      return { signatures: value.signatures.map(sig => encode(sig, Encoding.Signature)), tx: tx.tag === Tag.PayingForTx
        ? { type: 'PayingForTx', version: 1, payerId: tx.payerId, nonce: tx.nonce, fee: tx.fee,
          tx: envelope(buildTx({ tag: Tag.SignedTx, encodedTx: buildTx(tx.tx.encodedTx), signatures: tx.tx.signatures })) }
        : { ...tx, type: 'ContractCallTx', gas: tx.gasLimit } };
    }
    function mined(job, height, blockHash) {
      records.set(job.outer_hash, { ...envelope(job.raw_outer), hash: job.outer_hash, blockHeight: height, blockHash });
      generations.set(height, { keyBlock: { height, hash: address(Encoding.KeyBlockHash) }, microBlocks: [blockHash] });
    }
    mined(b, 120, oldBlock); generations.get(120).microBlocks = []; // settled B is no longer canonical
    const worker = new ShortsLikeSponsorWorker(f.signer.config, f.signer.repository);
    worker.verify = async () => ({ likesEnabled: true, version: '3' });
    worker.account = { signTransaction: () => assert.fail('Recovery must never sign replacement bytes') };
    worker.node = {
      getStatus: async () => ({ networkId: 'ae_uat' }), getCurrentKeyBlock: async () => key,
      getKeyBlockByHeight: async height => height === 113 ? expiryKey : { hash: key.hash, height },
      getAccountByPubkeyAndHash: async (_, hash) => { assert.equal(hash, expiryKey.hash); return { kind: 'basic', nonce: 0 }; },
      getAccountByPubkey: async () => ({ kind: 'basic', nonce: payerNonce }),
      getTransactionByHash: async hash => { if (!records.has(hash)) throw { statusCode: 404 }; return records.get(hash); },
      getGenerationByHeight: async height => generations.get(height),
      getTransactionInfoByHash: async hash => { const job = [b,c].find(row => row.outer_hash === hash), tx = records.get(hash);
        return { callInfo: { callerId: job.actor, callerNonce: 1, contractId: f.binding.contract, height: tx.blockHeight, returnType: 'ok' } }; },
      postTransaction: async ({ tx }) => { broadcasts++; assert.equal(tx, c.raw_outer); return { txHash: c.outer_hash }; },
    };
    const run = async () => { const attempt = new PublisherAttempt(new AbortController().signal, 10000);
      try { return await attempt.run(() => worker.process(attempt)); } finally { attempt.close(); } };
    await assert.rejects(run(), /canonical prefix/);
    assert.equal((await call(f.signer, f.binding, 'recovery_status')).quarantined, true);
    assert.equal(broadcasts, 0);
    await run(); assert.equal(broadcasts, 0); // normal process remains blocked
    f.signer.config.enabled = false; f.signer.config.recovery = true;
    await run(); // expired A is proven at its original anchor, even though B consumed nonce 1
    assert.equal((await get(f, a.inner_hash)).status, 'expired');
    assert.deepEqual((await get(f, a.inner_hash)).expiry_proof, expiry);
    const newBlock = address(Encoding.MicroBlockHash); mined(b, 121, newBlock);
    await run(); assert.equal((await get(f, b.inner_hash)).block_hash, newBlock);
    await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=true WHERE payer=$1', [f.payer]);
    await run(); assert.equal(broadcasts, 0); // emergency pause still gates exact-byte recovery
    await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=false WHERE payer=$1', [f.payer]);
    await run(); assert.equal(broadcasts, 1);
    key.height = 125; key.hash = address(Encoding.KeyBlockHash);
    mined(c, 123, address(Encoding.MicroBlockHash)); payerNonce = 2;
    await run(); assert.equal((await get(f, c.inner_hash)).status, 'confirmed');
    await worker.finishRecovery();
    const recoveredState = await call(f.signer, f.binding, 'recovery_status');
    assert.equal(recoveredState.quarantined, false); assert.equal(recoveredState.paused, true);
    assert.equal((await call(f.api, f.binding, 'enqueue', request())).status, 'rejected');
    for (const original of [a,b,c]) {
      const restored = await get(f, original.inner_hash);
      assert.equal(restored.raw_inner, original.raw_inner); assert.equal(restored.raw_outer, original.raw_outer);
      assert.equal(restored.reserved_cost, original.reserved_cost); assert.equal(restored.settlement_history.length, 1);
    }
    assert.equal((await get(f, b.inner_hash)).settlement_history[0].blockHash, oldBlock);
  });
  await t.test('same-nonce recovery candidates remain inspectable without weakening canonical nonce uniqueness', async () => {
    const f = await fixture(); await enqueue(f); const a = await persist(f, await claim(f));
    await call(f.signer, f.binding, 'expire', { ...identity(a), expiryProof: { ttl: 110, height: 113,
      blockHash: address(Encoding.KeyBlockHash), payerNonce: 0 } });
    await enqueue(f); const b = await persist(f, await claim(f)); await settle(f, b);
    const mode = { recovery: true, admissionEnabled: false };
    await call(f.signer, f.binding, 'quarantine', { ...mode, reason: 'bootstrap' });
    const first = await call(f.signer, f.binding, 'claim_recovery', { ...mode, token: randomUUID() });
    assert.equal(first.inner_hash, a.inner_hash);
    await settle(f, first); // a formerly expired envelope became canonical on the new branch
    const second = await call(f.signer, f.binding, 'claim_recovery', { ...mode, token: randomUUID() });
    assert.equal(second.inner_hash, b.inner_hash); assert.equal(second.status, 'recovering');
    await rejects(settle(f, second), 'SH409'); // both cannot become canonical at one payer nonce
    await call(f.signer, f.binding, 'release', identity(second));
    assert.equal((await get(f, b.inner_hash)).status, 'recovering');
    await rejects(call(f.signer, f.binding, 'recovery_finish', mode), 'SH409');
  });

  await t.test('administrative setup is idempotent, preserves budgets and pause, and rejects role or policy drift', async () => {
    const { ShortsLikeSponsorSetupService } = require('./shorts-like-sponsor-setup.service');
    const service = new ShortsLikeSponsorSetupService(owner);
    const config = { enabled: false, payer: AccountMemory.generate().address, policy: defaultPolicy,
      release: { network: 'ae_uat', contract: address(Encoding.ContractAddress), sourceHash: 'a'.repeat(64),
        operator: AccountMemory.generate().address, treasury: AccountMemory.generate().address } };
    await owner.query('INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,100,10)',
      [config.release.network, config.release.contract, config.release.sourceHash]);
    const credentials = Object.fromEntries(['api','signer'].map(kind => [kind, { role: `shlike_${randomUUID().replaceAll('-', '')}`, password: randomBytes(32).toString('base64url') }]));
    roles.push(credentials.api.role, credentials.signer.role);
    credentials.api.kind = 'signer'; // unrecognized secret-file fields cannot change privilege separation
    const first = await service.enroll(config, credentials);
    assert.equal(first.paused, true); assert.equal(first.quarantined, false);
    assert.deepEqual(await service.enroll(config, credentials), first);
    for (const kind of ['api','signer']) {
      const endpoint = new URL(url); endpoint.username = credentials[kind].role; endpoint.password = credentials[kind].password;
      const db = await new DataSource({ type: 'postgres', url: endpoint.href, logging: false,
        extra: { options: `-c search_path=${schema}`, max: 1 } }).initialize(); pools.push(db);
      const binding = { ...config.release, payer: config.payer, policy: config.policy };
      assert.equal((await call({db}, binding, 'verify')).kind, kind);
      await rejects(db.query('SELECT * FROM shorts_like_sponsorship_jobs'), '42501');
    }
    await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=false,anchor_version=7 WHERE payer=$1', [config.payer]);
    assert.equal((await service.enroll(config, credentials)).paused, false);
    assert.equal((await owner.query('SELECT anchor_version FROM shorts_like_sponsor_accounts WHERE payer=$1', [config.payer]))[0].anchor_version, '7');
    await assert.rejects(service.enroll({ ...config, policy: { ...config.policy, maxRequestsPerDay: 101 } }, credentials), /immutable/);
    await assert.rejects(service.enroll(config, { ...credentials, signer: credentials.api }), /distinct/);
    await owner.query('UPDATE shorts_like_sponsor_principals SET enabled=false WHERE role_name=$1', [credentials.signer.role]);
    await assert.rejects(service.enroll(config, credentials), /exact enabled/);
    service.configuration = async () => config;
    assert.equal((await service.setPaused(true)).paused, true);
    await owner.query('UPDATE shorts_like_sponsor_principals SET enabled=true WHERE role_name=$1', [credentials.signer.role]);
    await admin.query(`GRANT SELECT ON ${schema}.shorts_content TO ${credentials.signer.role}`);
    await assert.rejects(service.enroll(config, credentials), /unrelated authority/);
    await admin.query(`REVOKE SELECT ON ${schema}.shorts_content FROM ${credentials.signer.role}`);
    service.setup = async () => ({ ...first, paused: false });
    assert.equal((await service.setPaused(true)).paused, true);
    await owner.query('UPDATE shorts_like_sponsor_accounts SET quarantined=true WHERE payer=$1', [config.payer]);
    await assert.rejects(service.setPaused(false), /quarantine/);
    assert.equal((await service.setPaused(true)).paused, true);
  });

});
