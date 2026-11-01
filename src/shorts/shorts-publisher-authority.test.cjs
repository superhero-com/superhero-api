const { ShortsPublicationAdmission1791763223000 } = require('../migrations/1791763223000-ShortsPublicationAdmission');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { DataSource } = require('typeorm');
const { AccountMemory, encode, Encoding, buildTx, buildTxHash, Tag } = require('@aeternity/aepp-sdk');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsPublications1791763209000 } = require('../migrations/1791763209000-ShortsPublications');
const { ShortsPublisherAuthority1791763210000 } = require('../migrations/1791763210000-ShortsPublisherAuthority');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsPublicationsService } = require('./shorts-publications.service');
const { ShortsPublicationBoundaryService } = require('./shorts-publication-boundary.service');
const { publicationCalldata } = require('./shorts-publication-transaction');
const { publisherRole } = require('./testing/publisher-role.cjs');

test('publication database boundary separates creator admission from isolated signer authority', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_publisher_authority_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 2 },
    migrations: [ShortsMetadata1791763200000, ShortsPublications1791763209000, ShortsPublisherAuthority1791763210000, ShortsPublicationAdmission1791763223000] };
  const owner = new DataSource(options); await owner.initialize(); await owner.runMigrations({ transaction: 'all' }).catch(error => { const at = Number(error.position || error.driverError?.position); console.error({ position: at, where: error.driverError?.where, context: error.query?.slice(Math.max(0, at - 150), at + 150) }); throw error; });
  const principals = [], meta = new ShortsMetadataService(owner), journal = new ShortsPublicationsService(owner);
  t.after(async () => { for (const p of principals) { await p.db.destroy(); await p.dispose(); } await owner.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  const creator = AccountMemory.generate().address, sourceHash = 'a'.repeat(64);
  const policy = { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000', maxPending: 8,
    maxCreatorPending: 4, leaseMs: 3000, maxTtlBlocks: 20, confirmations: 3 };
  async function role(scope, kind) {
    const p = await publisherRole(admin, { url: url.href, schema, scope, kind });
    p.db = new DataSource({ ...options, url: p.url, migrations: [] }); await p.db.initialize(); p.repo = new ShortsPublicationBoundaryService(p.db);
    principals.push(p); return p;
  }
  async function fixture(limits = policy) {
    const account = AccountMemory.generate(), scope = { network: 'ae_uat', contract: encode(randomBytes(32), Encoding.ContractAddress) };
    await meta.initialize(scope, sourceHash); await journal.initialize(scope, sourceHash, account.address, limits);
    const deployment = { scope, sourceHash, operator: account.address, policy: limits };
    return { account, deployment, api: await role(scope, 'api'), signer: await role(scope, 'publisher'), other: await role(scope, 'publisher') };
  }
  async function content(f, extra = {}) {
    const r = { id: randomUUID(), creator, title: 'Owned fixture', cid: 'bafy' + 'a'.repeat(50), bytes: 800,
      publication: 'pending', moderation: 'approved', safety: { status: 'no_flags' }, ...extra };
    await owner.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,0,$5::jsonb)',
      [f.deployment.scope.network, f.deployment.scope.contract, r.id, r.creator, JSON.stringify(r)]); return r;
  }
  const rpc = (p, deployment, action, extra = {}) => p.db.query('SELECT shorts_publication($1,$2::jsonb) AS result',
    [action, JSON.stringify({ ...deployment.scope, sourceHash: deployment.sourceHash, operator: deployment.operator, policy: deployment.policy, ...extra })]);
  async function pending(f) { const r = await content(f); await f.api.repo.enqueue(f.deployment, r.id, r.creator); return f.signer.repo.claim(f.deployment); }
  async function signed(f, claim, changes = {}) {
    const raw = await f.account.signTransaction(buildTx({ tag: Tag.ContractCallTx, callerId: f.account.address,
      contractId: f.deployment.scope.contract, abiVersion: 3, amount: 0, callData: publicationCalldata(claim.intent),
      nonce: 1, ttl: 110, gasLimit: 100000, gasPrice: 1000000000, fee: '1000000000000000', ...changes }), { networkId: 'ae_uat' });
    return f.signer.repo.persistSigned(f.deployment, claim, raw, Number(changes.nonce || 1) - 1, 100);
  }
  const proof = claim => ({ transactionHash: claim.transactionHash, blockHash: encode(randomBytes(32), Encoding.MicroBlockHash), height: 101, tipHeight: 104, result: 'ok' });
  const get = async id => (await owner.query('SELECT * FROM shorts_publication_jobs WHERE id=$1', [id]))[0];
  const identity = claim => ({ id: claim.id, token: claim.token, fence: claim.fence });

  await t.test('dedicated API and publisher roles verify scope but receive no journal-table access', async () => {
    const f = await fixture(); await f.api.repo.verify(f.deployment, 'api'); await f.signer.repo.verify(f.deployment, 'publisher');
    await assert.rejects(f.api.repo.verify(f.deployment, 'publisher'), { status: 403 });
    await assert.rejects(f.signer.repo.verify({ ...f.deployment, sourceHash: 'b'.repeat(64) }, 'publisher'), { status: 403 });
    await assert.rejects(f.signer.repo.verify({ ...f.deployment, policy: { ...policy, maxPending: 9 } }, 'publisher'), { status: 403 });
    for (const p of [f.api, f.signer]) for (const sql of [
      'SELECT * FROM shorts_publication_jobs', 'SELECT * FROM shorts_publishing_accounts', 'SELECT * FROM shorts_publisher_principals',
      'UPDATE shorts_publishing_accounts SET paused=false', 'DELETE FROM shorts_publication_jobs', 'TRUNCATE shorts_publication_jobs CASCADE',
      "UPDATE shorts_publication_jobs SET status='confirmed'", 'CREATE TABLE unauthorized(value text)',
    ]) await assert.rejects(p.db.query(sql), { code: '42501' });
    await assert.rejects(f.signer.db.query('SELECT * FROM shorts_content'), { code: '42501' });
    await assert.rejects(f.signer.db.query("UPDATE shorts_content SET body='{}'"), { code: '42501' });
    await owner.query(`GRANT SELECT,UPDATE ON shorts_content TO ${f.api.role}`); await f.api.repo.verify(f.deployment, 'api');
    const [{ publicExecute }] = await owner.query(`SELECT EXISTS(SELECT FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      WHERE p.oid='${schema}.shorts_publication(text,jsonb)'::regprocedure AND x.grantee=0 AND x.privilege_type='EXECUTE') AS "publicExecute"`);
    assert.equal(publicExecute, false);
  });
  await t.test('API cannot claim, persist, send or settle, and publisher cannot enqueue', async () => {
    const f = await fixture(), claim = await pending(f);
    for (const action of ['claim','persist','authorize','renew','release','settle'])
      await assert.rejects(rpc(f.api, f.deployment, action, identity(claim)), { code: 'SH401' });
    await assert.rejects(rpc(f.signer, f.deployment, 'enqueue', { id: claim.id, creator }), { code: 'SH401' });
    await assert.rejects(rpc(f.signer, f.deployment, 'approve', identity(claim)), { code: 'SH400' });
    await assert.rejects(rpc(f.signer, f.deployment, null, identity(claim)), { code: 'SH400' });
    await assert.rejects(f.other.repo.renew(f.deployment, claim), { status: 409 });
    await assert.rejects(rpc(f.signer, f.deployment, 'verify', { contract: encode(randomBytes(32), Encoding.ContractAddress) }), { code: 'SH401' });
  });
  await t.test('enrollment rejects accidental table or column grants, inherited roles and replaced names', async () => {
    const f = await fixture();
    await owner.query(`GRANT SELECT(raw_tx) ON shorts_publication_jobs TO ${f.api.role}`);
    await assert.rejects(f.api.repo.verify(f.deployment, 'api'), { status: 403 }); await owner.query(`REVOKE SELECT(raw_tx) ON shorts_publication_jobs FROM ${f.api.role}`);
    await owner.query(`GRANT SELECT ON shorts_content TO ${f.signer.role}`);
    await assert.rejects(f.signer.repo.verify(f.deployment, 'publisher'), { status: 403 }); await owner.query(`REVOKE SELECT ON shorts_content FROM ${f.signer.role}`);
    await admin.query(`GRANT ${f.other.role} TO ${f.signer.role}`); await assert.rejects(f.signer.repo.verify(f.deployment, 'publisher'), { status: 403 });
    await admin.query(`REVOKE ${f.other.role} FROM ${f.signer.role}`);
    await owner.query("UPDATE shorts_publisher_principals SET role_name='replaced' WHERE role_name=$1", [f.signer.role]);
    await assert.rejects(f.signer.repo.verify(f.deployment, 'publisher'), { status: 403 });
    await owner.query("UPDATE shorts_publisher_principals SET role_name=$1 WHERE role_name='replaced'", [f.signer.role]);
    await owner.query('UPDATE shorts_publisher_principals SET enabled=false WHERE role_name=$1', [f.signer.role]);
    await assert.rejects(f.signer.repo.verify(f.deployment, 'publisher'), { status: 403 });
  });
  await t.test('temporary objects cannot shadow journal state and API status never returns signed bytes', async () => {
    const f = await fixture(); await f.signer.db.query('CREATE TEMP TABLE shorts_publisher_principals(enabled boolean)');
    await f.signer.db.query('CREATE TEMP TABLE shorts_publication_jobs(raw_tx text)');
    await f.signer.repo.verify(f.deployment, 'publisher'); const claim = await signed(f, await pending(f));
    const status = await f.api.repo.status(f.deployment, claim.id, creator);
    assert.deepEqual(Object.keys(status).sort(), ['blockHash','height','id','status','transactionHash']); assert.equal(status.transactionHash, claim.transactionHash);
    assert.equal(JSON.stringify(status).includes(claim.rawTransaction), false);
    await assert.rejects(f.api.repo.status(f.deployment, claim.id, f.account.address), { status: 403 });
    const send = await f.signer.repo.authorizeBroadcast(f.deployment, claim); assert.equal(send.rawTransaction, claim.rawTransaction);
  });
  await t.test('indirect view and foreign definer grants fail the role check', async () => {
    const f = await fixture();
    await owner.query('CREATE VIEW publication_leak AS SELECT raw_tx FROM shorts_publication_jobs; CREATE VIEW publication_leak_nested AS SELECT * FROM publication_leak');
    try {
      await owner.query(`GRANT SELECT ON publication_leak_nested TO ${f.api.role}`);
      await assert.rejects(f.api.repo.verify(f.deployment, 'api'), { status: 403 });
    } finally { await owner.query('DROP VIEW publication_leak_nested; DROP VIEW publication_leak'); }
    await owner.query("CREATE FUNCTION publication_other_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; REVOKE ALL ON FUNCTION publication_other_definer() FROM PUBLIC");
    try {
      await owner.query(`GRANT EXECUTE ON FUNCTION publication_other_definer() TO ${f.signer.role}`);
      await assert.rejects(f.signer.repo.verify(f.deployment, 'publisher'), { status: 403 });
    } finally { await owner.query('DROP FUNCTION publication_other_definer()'); }
    await f.api.repo.verify(f.deployment, 'api'); await f.signer.repo.verify(f.deployment, 'publisher');
  });
  await t.test('configuration is checked again after an earlier successful verify', async () => {
    const f = await fixture(), claim = await pending(f); await f.signer.repo.verify(f.deployment, 'publisher');
    await owner.query("UPDATE shorts_publishing_accounts SET policy=jsonb_set(policy,'{rollingCostLimit}','\"20000000000000000\"') WHERE operator=$1", [f.account.address]);
    await assert.rejects(signed(f, claim), { status: 403 }); assert.equal((await get(claim.id)).raw_tx, null);
    await assert.rejects(f.api.repo.status(f.deployment, claim.id, creator), { status: 403 });
  });
  await t.test('lost worker claims recover the same signed bytes and reject the former principal', async () => {
    const f = await fixture(), first = await signed(f, await pending(f));
    await owner.query("UPDATE shorts_publication_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    const recovered = await f.other.repo.claim(f.deployment); assert.equal(recovered.rawTransaction, first.rawTransaction);
    assert.notEqual(recovered.token, first.token); assert.equal((await get(first.id)).lease_principal > 0, true);
    await assert.rejects(f.signer.repo.renew(f.deployment, recovered), { status: 409 });
    await assert.rejects(f.signer.repo.authorizeBroadcast(f.deployment, first), { status: 409 });
    assert.equal((await f.other.repo.authorizeBroadcast(f.deployment, recovered)).transactionHash, first.transactionHash);
    const observation = proof(recovered); await f.other.repo.settle(f.deployment, recovered, observation);
    await f.other.repo.settle(f.deployment, recovered, observation); assert.equal((await get(first.id)).status, 'confirmed');
    const [r] = await owner.query('SELECT body FROM shorts_content WHERE id=$1', [first.id]); assert.equal(r.body.publication, 'pending');
  });
  await t.test('pending or changed policy is rejected before admission, signing and rebroadcast', async () => {
    const f = await fixture();
    for (const extra of [{ moderation: 'pending' }, { publication: 'withdrawn' }, { safety: { status: 'blocked' } },
      { safety: { status: 'review', evidenceHash: 'e' } }, { safety: { status: 'error' } }]) {
      const r = await content(f, extra); await assert.rejects(f.api.repo.enqueue(f.deployment, r.id, creator), { status: 403 });
    }
    const r = await content(f, { safety: { status: 'review', evidenceHash: 'e' }, visualReviewHash: 'e' });
    await f.api.repo.enqueue(f.deployment, r.id, creator); const claim = await signed(f, await f.signer.repo.claim(f.deployment));
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{safety,status}','\"blocked\"') WHERE id=$1", [r.id]);
    assert.equal(await f.signer.repo.authorizeBroadcast(f.deployment, claim), undefined);
    assert.equal((await get(r.id)).broadcast_blocked, true); assert.equal((await get(r.id)).raw_tx, claim.rawTransaction);
    const next = await content(f); await f.api.repo.enqueue(f.deployment, next.id, creator); assert.equal(await f.other.repo.claim(f.deployment), undefined);
  });
  await t.test('caller intent tampering and poisoned stored bytes are caught before broadcast', async () => {
    const f = await fixture(), claim = await pending(f), forged = { ...claim, intent: { ...claim.intent, bytes: 801 } };
    await assert.rejects(signed(f, forged), { status: 409 }); assert.equal((await get(claim.id)).raw_tx, null);
    const saved = await signed(f, claim);
    await owner.query("UPDATE shorts_publication_jobs SET raw_tx='tx_AAAA',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.id]);
    await assert.rejects(f.other.repo.claim(f.deployment), { status: 400 });
    assert.equal((await get(claim.id)).broadcast_attempts, 0); assert.equal(saved.transactionHash, buildTxHash(saved.rawTransaction));
  });
  await t.test('preparation capacity is scoped and cannot reserve or overfill the signing queue', async () => {
    const f = await fixture({ ...policy, maxPending: 1, maxCreatorPending: 1 });
    const first = await content(f), second = await content(f);
    for (const r of [first, second]) assert.equal(await f.api.repo.capacity(f.deployment, r.id, creator), true);
    const count = async () => Number((await owner.query('SELECT count(*) FROM shorts_publication_jobs WHERE operator=$1', [f.account.address]))[0].count);
    assert.equal(await count(), 0, 'preflight must not reserve a slot');
    await assert.rejects(f.api.repo.capacity(f.deployment, first.id, f.account.address), { status: 403 });
    await assert.rejects(rpc(f.signer, f.deployment, 'capacity', { id: first.id, creator }), { code: 'SH401' });
    await assert.rejects(f.api.repo.capacity({ ...f.deployment, sourceHash: 'b'.repeat(64) }, first.id, creator), { status: 403 });
    const results = await Promise.allSettled([first, second].map(r => f.api.repo.enqueue(f.deployment, r.id, creator)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 503); assert.equal(await count(), 1);
    for (const r of [first, second]) assert.equal(await f.api.repo.capacity(f.deployment, r.id, creator), false);
    const claim = await signed(f, await f.signer.repo.claim(f.deployment));
    const waiting = claim.id === first.id ? second : first;
    assert.equal(await f.api.repo.capacity(f.deployment, waiting.id, creator), false);
    await f.signer.repo.settle(f.deployment, claim, proof(claim));
    assert.equal(await f.api.repo.capacity(f.deployment, waiting.id, creator), true);
    await owner.query('UPDATE shorts_publishing_accounts SET paused=true WHERE operator=$1', [f.account.address]);
    assert.equal(await f.api.repo.capacity(f.deployment, waiting.id, creator), false);
    await owner.query('UPDATE shorts_publishing_accounts SET paused=false WHERE operator=$1', [f.account.address]);
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"rejected\"') WHERE id=$1", [waiting.id]);
    await assert.rejects(f.api.repo.capacity(f.deployment, waiting.id, creator), { status: 403 });
  });
  await t.test('capacity preserves creator limits while the operator queue has room', async () => {
    const f = await fixture({ ...policy, maxPending: 3, maxCreatorPending: 1 });
    const first = await content(f), sameCreator = await content(f), otherCreator = await content(f, { creator: f.account.address });
    await f.api.repo.enqueue(f.deployment, first.id, creator);
    assert.equal(await f.api.repo.capacity(f.deployment, sameCreator.id, creator), false);
    assert.equal(await f.api.repo.capacity(f.deployment, otherCreator.id, otherCreator.creator), true);
  });
  await t.test('admission migration preserves grants and signed state and requires its capability at startup', async () => {
    const f = await fixture(), claim = await signed(f, await pending(f));
    const before = await get(claim.id);
    const functionIdentity = async () => (await owner.query("SELECT oid,proowner,proacl,proconfig FROM pg_proc WHERE oid='shorts_publication(text,jsonb)'::regprocedure"))[0];
    const identityBefore = await functionIdentity();
    const migration = new ShortsPublicationAdmission1791763223000();
    await owner.transaction(db => migration.down(db));
    await assert.rejects(f.api.repo.verify(f.deployment, 'api'), { status: 403 });
    assert.deepEqual(await get(claim.id), before);
    await owner.transaction(db => migration.up(db));
    await f.api.repo.verify(f.deployment, 'api'); await f.signer.repo.verify(f.deployment, 'publisher');
    assert.deepEqual(await functionIdentity(), identityBefore); assert.deepEqual(await get(claim.id), before);
    assert.equal(JSON.stringify(await f.api.repo.status(f.deployment, claim.id, creator)).includes(claim.rawTransaction), false);
    await assert.rejects(owner.transaction(db => migration.up(db)), /Unexpected Shorts publication migration predecessor/);
    assert.deepEqual(await get(claim.id), before);
  });
  await t.test('queue and fee reservations use shared account limits', async () => {
    const f = await fixture({ ...policy, maxPending: 2, maxCreatorPending: 1, rollingCostLimit: '2000000000000000' });
    const claim = await signed(f, await pending(f)), extra = await content(f);
    await assert.rejects(f.api.repo.enqueue(f.deployment, extra.id, creator), { status: 503 });
    await f.signer.repo.settle(f.deployment, claim, proof(claim)); await f.api.repo.enqueue(f.deployment, extra.id, creator);
    const next = await f.signer.repo.claim(f.deployment);
    await assert.rejects(signed(f, next, { nonce: 2 }), { status: 503 }); assert.equal((await get(next.id)).raw_tx, null);
    await assert.rejects(signed(f, next), { status: 409 });
  });
  await t.test('downgrade cannot silently remove active principal protection', async () => {
    await assert.rejects(new ShortsPublisherAuthority1791763210000().down(owner.createQueryRunner()), /reconcile publication principals/);
  });
  await t.test('runtime Nest module resolves only the boundary client with a restricted connection', async () => {
    const f = await fixture(), { Module, Global } = require('@nestjs/common'), { Test } = require('@nestjs/testing');
    const { ShortsPublicationBoundaryModule } = require('./shorts-publication-boundary.module');
    class Database {} Global()(Database); Module({ providers: [{ provide: DataSource, useValue: f.signer.db }], exports: [DataSource] })(Database);
    const module = await Test.createTestingModule({ imports: [Database, ShortsPublicationBoundaryModule] }).compile();
    try { await module.init(); await module.get(ShortsPublicationBoundaryService).verify(f.deployment, 'publisher'); assert.throws(() => module.get(ShortsPublicationsService)); }
    finally { await module.close(); }
  });
});
