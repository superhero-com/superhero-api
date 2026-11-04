require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { resolve } = require('node:path');
const { DataSource } = require('typeorm');
const { AccountMemory, encode, Encoding, buildTx, buildTxHash, Tag } = require('@aeternity/aepp-sdk');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsPublications1791763209000 } = require('../migrations/1791763209000-ShortsPublications');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsPublicationsService } = require('./shorts-publications.service');
const { publicationCalldata, publicationTransaction } = require('./shorts-publication-transaction');

const policy = { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000',
  maxPending: 8, maxCreatorPending: 4, leaseMs: 1000, maxTtlBlocks: 20, confirmations: 3 };
const contract = () => encode(randomBytes(32), Encoding.ContractAddress);
const block = () => encode(randomBytes(32), Encoding.MicroBlockHash);
function unsigned(account, scope, intent, overrides = {}) {
  return buildTx({ tag: Tag.ContractCallTx, callerId: account.address, contractId: scope.contract,
    abiVersion: 3, amount: 0, callData: publicationCalldata(intent), nonce: 1, ttl: 110,
    gasLimit: 100000, gasPrice: 1000000000, fee: '1000000000000000', ...overrides });
}
const sign = (account, scope, intent, overrides, networkId = 'ae_uat') =>
  account.signTransaction(unsigned(account, scope, intent, overrides), { networkId });

test('publication signatures are valid only for their explicit network domain', async t => {
  const account = AccountMemory.generate(), creator = AccountMemory.generate();
  const intent = { id: randomUUID(), creator: creator.address, cid: 'bafy' + 'b'.repeat(50), bytes: 800 };
  const scope = { contract: contract() };
  for (const network of ['ae_uat', 'ae_mainnet']) await t.test(network, async () => {
    const raw = await sign(account, scope, intent, {}, network);
    const check = domain => publicationTransaction(raw, intent, scope.contract, account.address, 0, 100, policy, domain);
    assert.equal(check(network).hash, buildTxHash(raw));
    for (const domain of [network === 'ae_uat' ? 'ae_mainnet' : 'ae_uat', undefined, '', 'custom', network + '-inner_tx'])
      assert.throws(() => check(domain), { status: 400 });
  });
});

test('publication authority validates real offline signatures and an exact zero-value call', async () => {
  const account = AccountMemory.generate(), alien = AccountMemory.generate(), scope = { network: 'ae_uat', contract: contract() };
  const intent = { id: randomUUID(), creator: alien.address, cid: 'bafy' + 'a'.repeat(50), bytes: 800 };
  const valid = await sign(account, scope, intent);
  const check = raw => publicationTransaction(raw, intent, scope.contract, account.address, 0, 100, policy, scope.network);
  assert.equal(check(valid).hash, buildTxHash(valid)); assert.equal(check(valid).cost, '1100000000000000');
  const wrong = [await sign(account, scope, intent, {}, 'ae_mainnet'), await sign(alien, scope, intent),
    await sign(account, scope, { ...intent, creator: account.address }), await sign(account, scope, { ...intent, bytes: 801 }),
    await sign(account, scope, { ...intent, id: randomUUID() }), await sign(account, scope, { ...intent, cid: 'bafywrong' }),
    ...await Promise.all([{ contractId: contract() }, { amount: 1 }, { nonce: 2 }, { ttl: 0 }, { ttl: 100 }, { ttl: 121 },
      { fee: '2000000000000001' }].map(o => sign(account, scope, intent, o))),
    await account.signTransaction(buildTx({ tag: Tag.SpendTx, senderId: account.address, recipientId: alien.address, amount: 0, nonce: 1 }), { networkId: 'ae_uat' }),
    unsigned(account, scope, intent), 'tx_bad', valid.slice(0, -5) + 'aaaaa', 'x'.repeat(33000)];
  for (const raw of wrong) assert.throws(() => check(raw), { status: 400 });
  assert.throws(() => publicationTransaction(valid, intent, scope.contract, account.address, NaN, 100, policy, scope.network), { status: 400 });
});

test('durable publisher journal serializes account authority and preserves uncertain signed transactions', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_publications_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 },
    migrations: [ShortsMetadata1791763200000, ShortsPublications1791763209000] };
  const one = new DataSource(options), two = new DataSource(options); await one.initialize(); await two.initialize();
  t.after(async () => { await two.destroy(); await one.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await one.runMigrations({ transaction: 'all' });
  const a = new ShortsPublicationsService(one), b = new ShortsPublicationsService(two), meta = new ShortsMetadataService(one);
  const creator = AccountMemory.generate().address, sourceHash = 'a'.repeat(64), pairs = s => [s.network, s.contract];
  async function fixture(account = AccountMemory.generate(), limits = policy) {
    const scope = { network: 'ae_uat', contract: contract() }; await meta.initialize(scope, sourceHash);
    await a.initialize(scope, sourceHash, account.address, limits);
    return { scope, account, limits };
  }
  async function content(f, owner = creator) {
    const record = { id: randomUUID(), creator: owner, title: 'Owned fixture', topic: 'Art', cid: 'bafy' + 'a'.repeat(50), bytes: 800,
      duration: 3, createdAt: Date.now(), moderation: 'approved', publication: 'pending', safety: { status: 'no_flags' }, files: [], reports: 0, views: [] };
    await one.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [...pairs(f.scope), record.id, owner, record.createdAt, JSON.stringify(record)]);
    return record;
  }
  const get = async (f, id) => (await one.query('SELECT * FROM shorts_publication_jobs WHERE network=$1 AND contract=$2 AND id=$3', [...pairs(f.scope), id]))[0];
  const expire = (f, id) => one.query("UPDATE shorts_publication_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE network=$1 AND contract=$2 AND id=$3", [...pairs(f.scope), id]);
  async function prepared(f) {
    const r = await content(f); await a.enqueue(f.scope, r.id, creator); const claim = await a.claim(f.scope);
    const raw = await sign(f.account, f.scope, claim.intent); await a.persistSigned(f.scope, claim, raw, 0, 100); return { r, claim, raw };
  }
  const proof = (raw, result = 'ok') => ({ transactionHash: buildTxHash(raw), blockHash: block(), height: 101, tipHeight: 104, result });

  await t.test('scope, source, limits and operator binding fail closed', async () => {
    const f = await fixture(); await b.initialize(f.scope, sourceHash, f.account.address, policy);
    await assert.rejects(a.initialize(f.scope, 'b'.repeat(64), f.account.address, policy), { status: 409 });
    await assert.rejects(a.initialize(f.scope, sourceHash, AccountMemory.generate().address, policy), { status: 409 });
    await assert.rejects(a.initialize(f.scope, sourceHash, f.account.address, { ...policy, maxPending: 9 }), { status: 409 });
    await assert.rejects(a.initialize({ ...f.scope, network: 'ae_mainnet' }, sourceHash, f.account.address, policy), { status: 400 });
    await assert.rejects(a.initialize(f.scope, sourceHash, f.account.address, { ...policy, maxTransactionCost: '1e3' }), { status: 400 });
    await assert.rejects(a.claim({ ...f.scope, contract: contract() }), { status: 503 });
  });
  await t.test('creator admission is idempotent, scoped and bounded across simultaneous requests', async () => {
    const f = await fixture(undefined, { ...policy, maxPending: 2, maxCreatorPending: 1 }); const r = await content(f);
    const values = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).enqueue(f.scope, r.id, creator)));
    assert.ok(values.every(v => v.status === 'queued' && v.rawTransaction === undefined));
    await assert.rejects(b.enqueue(f.scope, r.id, f.account.address), { status: 403 });
    const another = await content(f); await assert.rejects(a.enqueue(f.scope, another.id, creator), { status: 503 });
    const r2 = await content(f, f.account.address); await b.enqueue(f.scope, r2.id, f.account.address);
    const r3 = await content(f, AccountMemory.generate().address); await assert.rejects(a.enqueue(f.scope, r3.id, r3.creator), { status: 503 });
    await one.query("UPDATE shorts_content SET body=jsonb_set(body,'{bytes}','801') WHERE id=$1", [r.id]);
    await assert.rejects(b.enqueue(f.scope, r.id, creator), { status: 409 });
  });
  await t.test('one operator serializes across contracts while independent operators can work', async () => {
    const f = await fixture(), other = await fixture(f.account), independent = await fixture();
    for (const target of [f, other, independent]) { const r = await content(target); await a.enqueue(target.scope, r.id, creator); }
    const claims = await Promise.all([a.claim(f.scope), b.claim(other.scope)]); assert.equal(claims.filter(Boolean).length, 1);
    assert.ok(await b.claim(independent.scope));
    const owner = claims[0] ? f : other, waiting = claims[0] ? other : f, claim = claims.find(Boolean);
    await expire(owner, claim.id); assert.equal(await b.claim(waiting.scope), undefined);
    const replacement = await b.claim(owner.scope); assert.notEqual(replacement.token, claim.token);
    await assert.rejects(a.renew(owner.scope, claim), { status: 409 });
    await assert.rejects(a.release(owner.scope, claim), { status: 409 });
    await b.release(owner.scope, replacement); assert.ok(await a.claim(waiting.scope));
  });
  await t.test('approval loss cancels unsigned work and rejects a new signature after claiming', async () => {
    const f = await fixture(), r = await content(f); await a.enqueue(f.scope, r.id, creator);
    await one.query("UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"rejected\"') WHERE id=$1", [r.id]);
    assert.equal(await a.claim(f.scope), undefined); assert.equal((await get(f, r.id)).status, 'cancelled');
    const r2 = await content(f); await a.enqueue(f.scope, r2.id, creator); const claim = await a.claim(f.scope);
    await one.query("UPDATE shorts_content SET body=jsonb_set(body,'{publication}','\"withdrawn\"') WHERE id=$1", [r2.id]);
    await assert.rejects(a.persistSigned(f.scope, claim, await sign(f.account, f.scope, claim.intent), 0, 100), { status: 403 });
    assert.equal((await get(f, r2.id)).raw_tx, null);
  });
  await t.test('signed bytes commit once and ambiguous broadcasts only return that same payload', async () => {
    const f = await fixture(), { r, claim, raw } = await prepared(f);
    await b.persistSigned(f.scope, claim, raw, 0, 100);
    await assert.rejects(b.persistSigned(f.scope, claim, await sign(f.account, f.scope, claim.intent, { ttl: 111 }), 0, 100), { status: 409 });
    const first = await a.authorizeBroadcast(f.scope, claim); assert.equal(first.rawTransaction, raw);
    await a.release(f.scope, claim); const recovered = await b.claim(f.scope);
    assert.equal(recovered.rawTransaction, raw); assert.equal(recovered.transactionHash, buildTxHash(raw));
    assert.deepEqual(await b.authorizeBroadcast(f.scope, recovered), first);
    assert.equal((await get(f, r.id)).broadcast_attempts, 2);
    await assert.rejects(a.authorizeBroadcast(f.scope, claim), { status: 409 });
  });
  await t.test('database failure cannot acknowledge a signature that was not committed', async () => {
    const f = await fixture(), r = await content(f); await a.enqueue(f.scope, r.id, creator); const claim = await a.claim(f.scope);
    await one.query(`CREATE FUNCTION fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${r.id}' AND NEW.raw_tx IS NOT NULL THEN RAISE EXCEPTION 'fixture journal outage'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_publication BEFORE UPDATE ON shorts_publication_jobs FOR EACH ROW EXECUTE FUNCTION fail_publication()`);
    const raw = await sign(f.account, f.scope, claim.intent);
    try { await assert.rejects(a.persistSigned(f.scope, claim, raw, 0, 100), /fixture journal outage/); }
    finally { await one.query('DROP TRIGGER fail_publication ON shorts_publication_jobs; DROP FUNCTION fail_publication()'); }
    assert.equal((await get(f, r.id)).raw_tx, null);
    await assert.rejects(a.authorizeBroadcast(f.scope, claim), { status: 409 });
    await b.persistSigned(f.scope, claim, raw, 0, 100);
  });
  await t.test('revoked signed work stops rebroadcast without freeing an uncertain nonce', async () => {
    const f = await fixture(), { r, claim, raw } = await prepared(f); const waiting = await content(f); await a.enqueue(f.scope, waiting.id, creator);
    await one.query("UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"rejected\"') WHERE id=$1", [r.id]);
    assert.equal(await a.authorizeBroadcast(f.scope, claim), undefined);
    await one.query("UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"approved\"') WHERE id=$1", [r.id]);
    assert.equal(await b.authorizeBroadcast(f.scope, claim), undefined);
    await a.release(f.scope, claim); const again = await b.claim(f.scope); assert.equal(again.id, r.id);
    assert.equal(again.rawTransaction, raw); assert.equal((await get(f, waiting.id)).status, 'queued');
    assert.equal((await get(f, r.id)).broadcast_attempts, 0);
    await b.settle(f.scope, again, proof(raw)); assert.equal((await get(f, r.id)).status, 'confirmed');
    // A chain observation does not approve or publish metadata.
    const [contentRow] = await one.query('SELECT body FROM shorts_content WHERE id=$1', [r.id]); assert.equal(contentRow.body.publication, 'pending');
  });
  await t.test('pause stops new work and sending, but permits outcome reconciliation', async () => {
    const f = await fixture(), { claim, raw } = await prepared(f);
    await one.query('UPDATE shorts_publishing_accounts SET paused=true WHERE operator=$1', [f.account.address]);
    assert.equal(await a.authorizeBroadcast(f.scope, claim), undefined);
    assert.equal((await get(f, claim.id)).broadcast_blocked, false);
    const r = await content(f); await assert.rejects(a.enqueue(f.scope, r.id, creator), { status: 503 });
    await a.settle(f.scope, claim, proof(raw)); assert.equal(await b.claim(f.scope), undefined);
  });
  await t.test('confirmation threshold, durable nonce and rolling reserved cost survive a failed call', async () => {
    const f = await fixture(undefined, { ...policy, rollingCostLimit: '2000000000000000' }), { claim, raw } = await prepared(f);
    await assert.rejects(a.settle(f.scope, claim, { ...proof(raw), tipHeight: 103 }), { status: 409 });
    await a.settle(f.scope, claim, proof(raw, 'revert')); assert.equal((await get(f, claim.id)).status, 'reverted');
    const r = await content(f); await a.enqueue(f.scope, r.id, creator); const next = await b.claim(f.scope);
    await assert.rejects(b.persistSigned(f.scope, next, await sign(f.account, f.scope, next.intent), 0, 100), { status: 409 });
    await assert.rejects(b.persistSigned(f.scope, next, await sign(f.account, f.scope, next.intent, { nonce: 2 }), 1, 100), { status: 503 });
    assert.equal((await get(f, r.id)).raw_tx, null);
  });
  await t.test('actual killed process leaves committed signed bytes recoverable by another pool', async () => {
    const f = await fixture(), r = await content(f); await a.enqueue(f.scope, r.id, creator);
    const raw = await sign(f.account, f.scope, r);
    const child = fork(resolve(__dirname, 'testing/publication-worker.cjs'), [], {
      execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, SHORTS_TEST_PG_SCHEMA: schema, SHORTS_TEST_PG_SCOPE: JSON.stringify(f.scope), SHORTS_TEST_SIGNED_TRANSACTION: raw },
    });
    let errors = ''; child.stderr.on('data', d => { errors += d; });
    try {
      const message = await Promise.race([once(child, 'message').then(([m]) => m), once(child, 'exit').then(() => { throw new Error(errors || 'worker exited before commit'); })]);
      assert.equal(message.committed, true); const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
      assert.equal((await get(f, r.id)).raw_tx, raw); await expire(f, r.id);
      const recovered = await b.claim(f.scope); assert.equal(recovered.rawTransaction, raw);
      await assert.rejects(a.authorizeBroadcast(f.scope, message.claim), { status: 409 });
      assert.equal((await b.authorizeBroadcast(f.scope, recovered)).transactionHash, buildTxHash(raw));
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
  await t.test('lease expiry during a content lock prevents late signed-byte admission', async () => {
    const f = await fixture(), r = await content(f); await a.enqueue(f.scope, r.id, creator); const claim = await a.claim(f.scope);
    const raw = await sign(f.account, f.scope, claim.intent), blocker = two.createQueryRunner(); await blocker.connect();
    await blocker.startTransaction(); await blocker.query('SELECT id FROM shorts_content WHERE id=$1 FOR UPDATE', [r.id]);
    try {
      const pending = assert.rejects(a.persistSigned(f.scope, claim, raw, 0, 100), { status: 409 });
      await new Promise(resolve => setTimeout(resolve, 1150)); await blocker.commitTransaction(); await pending;
      assert.equal((await get(f, r.id)).raw_tx, null);
      const replacement = await b.claim(f.scope); assert.notEqual(replacement.token, claim.token);
    } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); await blocker.release(); }
  });
  await t.test('lost confirmation acknowledgements retry without rewriting a sealed observation', async () => {
    const f = await fixture(), { claim, raw } = await prepared(f), observation = proof(raw);
    await a.settle(f.scope, claim, observation); await b.settle(f.scope, claim, observation);
    assert.equal((await get(f, claim.id)).block_hash, observation.blockHash);
    await assert.rejects(b.settle(f.scope, claim, { ...observation, blockHash: block() }), { status: 409 });
    await assert.rejects(b.settle(f.scope, claim, { ...observation, result: 'revert' }), { status: 409 });
  });
  await t.test('Nest journal module has no API core, key or decoder dependency', async () => {
    const { Module, Global } = require('@nestjs/common'), { Test } = require('@nestjs/testing');
    const { ShortsPublicationsModule } = require('./shorts-publications.module');
    class Database {} Global()(Database); Module({ providers: [{ provide: DataSource, useValue: one }], exports: [DataSource] })(Database);
    const module = await Test.createTestingModule({ imports: [Database, ShortsPublicationsModule] }).compile();
    try { assert.ok(module.get(ShortsPublicationsService)); } finally { await module.close(); }
  });
  await t.test('schema rollback refuses to erase initialized signing authority', async () => {
    await assert.rejects(new ShortsPublications1791763209000().down(one.createQueryRunner()), /preserve the signed publication journal/);
  });
});
