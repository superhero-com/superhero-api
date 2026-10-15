const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { releaseFixture, digest } = require('./shorts-release.fixture.cjs');
const { ShortsPublicationAdmission1791763223000 } = require('../migrations/1791763223000-ShortsPublicationAdmission');
const { ShortsLifecycle1791763213000 } = require('../migrations/1791763213000-ShortsLifecycle');
const { ShortsLifecycleJobsService } = require('./shorts-lifecycle-jobs.service');
const { ShortsHostedHostingService } = require('./shorts-hosted-hosting.service');
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
const { ShortsPublisherService } = require('./shorts-publisher.service');
const { ShortsPublisherNodeService, publisherTransport } = require('./shorts-publisher-node.service');
const { ShortsDatabaseService } = require('./shorts-database.service');
const { ShortsApiPublicationService } = require('./shorts-api-publication.service');
const { ShortsPublisherSetupService } = require('./shorts-publisher-setup.service');
const { ShortsRecordsService } = require('./shorts-records.service');
const { ShortsService } = require('./shorts.service');
const { ShortsChainService } = require('./shorts-chain.service');
const { publisherJson, shortsPublisherConfig } = require('./shorts-publisher.config');
const { publisherRole } = require('./testing/publisher-role.cjs');

test('isolated publisher runtime preserves transactions and gates publication', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_publisher_authority_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 2 },
    migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsPublications1791763209000, ShortsPublisherAuthority1791763210000, ShortsLifecycle1791763213000, ShortsPublicationAdmission1791763223000, ShortsUploadBudget1791763224000] };
  const owner = new DataSource(options); await owner.initialize(); await owner.runMigrations({ transaction: 'all' }).catch(error => { const at = Number(error.position || error.driverError?.position); console.error({ position: at, where: error.driverError?.where, context: error.query?.slice(Math.max(0, at - 150), at + 150) }); throw error; });
  const principals = [], meta = new ShortsMetadataService(owner), journal = new ShortsPublicationsService(owner);
  t.after(async () => { for (const p of principals) { await p.db.destroy(); await p.dispose(); } await owner.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  const creator = AccountMemory.generate().address, sourceHash = 'a'.repeat(64);
  const policy = { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000', maxPending: 8,
    maxCreatorPending: 4, leaseMs: 3000, maxTtlBlocks: 20, confirmations: 3 };
  async function role(scope, kind) {
    const p = await publisherRole(admin, { url: url.href, schema, scope, kind });
    p.db = new ShortsDatabaseService(new DataSource({ ...options, url: p.url, migrations: [] })); await p.db.onModuleInit(); p.repo = new ShortsPublicationBoundaryService(p.db);
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
      createdAt: 0, publication: 'pending', moderation: 'approved', safety: { status: 'no_flags' }, ...extra };
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

  function runtime(f, overrides = {}) {
    let prepares = 0; const sends = [];
    const node = {
      async verify() {}, async existing() {},
      async prepare(intent) {
        prepares++;
        return { rawTransaction: await f.account.signTransaction(buildTx({ tag: Tag.ContractCallTx, callerId: f.account.address,
          contractId: f.deployment.scope.contract, abiVersion: 3, amount: 0, callData: publicationCalldata(intent),
          nonce: 1, ttl: 110, gasLimit: 100000, gasPrice: 1000000000, fee: '1000000000000000' }), { networkId: 'ae_uat' }), accountNonce: 0, height: 100 };
      },
      async observe() { return { state: 'absent' }; }, async canBroadcast() { return true; },
      async broadcast(raw, hash) { sends.push({ raw, hash }); }, ...overrides,
    };
    const service = new ShortsPublisherService({ ...f.deployment, pollMs: 1000 }, f.signer.repo, node);
    return { service, node, sends, get prepares() { return prepares; } };
  }
  async function queue(f) { const r = await content(f); await f.api.repo.enqueue(f.deployment, r.id, creator); return r; }
  await t.test('Nest setup enrolls distinct pre-created roles idempotently without re-enabling a disabled principal', async () => {
    const { mkdtemp, writeFile, rm } = require('node:fs/promises'); const { join } = require('node:path'); const { tmpdir } = require('node:os');
    const f = await fixture(), dir = await mkdtemp(join(tmpdir(), 'publisher-setup-'));
    const env = { AE_NETWORK_ID: 'ae_uat', ENABLE_SHORTS: 'true', SHORTS_TESTNET_MVP: '1', SHORTS_DEPLOYMENT_FILE: join(dir, 'deployment.json'), SHORTS_PUBLISHING_POLICY_FILE: join(dir, 'policy.json'), SHORTS_PUBLISHER_API_ROLE: f.api.role, SHORTS_PUBLISHER_DB_ROLE: f.signer.role };
    try {
      await writeFile(env.SHORTS_DEPLOYMENT_FILE, JSON.stringify(releaseFixture({ ...f.deployment.scope, sourceHash, operator: f.account.address }).release));
      await writeFile(env.SHORTS_PUBLISHING_POLICY_FILE, JSON.stringify(policy));
      await owner.query('DELETE FROM shorts_publisher_principals WHERE role_name=ANY($1)', [[f.api.role, f.signer.role]]);
      const setup = new ShortsPublisherSetupService(owner, meta, journal); await setup.setup(env); await setup.setup(env);
      await f.api.repo.verify(f.deployment, 'api'); await f.signer.repo.verify(f.deployment, 'publisher');
      await owner.query('UPDATE shorts_publisher_principals SET enabled=false WHERE role_name=$1', [f.api.role]);
      await assert.rejects(setup.setup(env), /disabled/); await assert.rejects(f.api.repo.verify(f.deployment, 'api'), { status: 403 });
      await assert.rejects(setup.setup({ ...env, SHORTS_OPERATOR_KEY_FILE: '/not-read' }), /without a signing key/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  await t.test('persist precedes submission and an ambiguous response only retries identical bytes', async () => {
    const f = await fixture(), r = await queue(f);
    const run = runtime(f, { async broadcast(raw, hash) { const saved = await get(r.id); assert.equal(saved.raw_tx, raw); assert.equal(saved.tx_hash, hash); throw new Error('response lost'); } });
    await run.service.tick(); const before = await get(r.id); assert.equal(before.status, 'signed'); assert.equal(before.broadcast_attempts, 1);
    await run.service.tick(); const after = await get(r.id); assert.equal(run.prepares, 1); assert.equal(after.raw_tx, before.raw_tx); assert.equal(after.broadcast_attempts, 2);
    run.node.observe = async claim => ({ state: 'settled', proof: proof(claim) });
    await run.service.tick(); assert.equal((await get(r.id)).status, 'confirmed'); assert.equal(run.prepares, 1);
  });
  await t.test('replacement process identity resumes the same pending transaction, including expired TTL', async () => {
    const f = await fixture(), r = await queue(f); const run = runtime(f); await run.service.tick();
    const first = await get(r.id); f.signer = f.other;
    const next = runtime(f, { async prepare() { throw new Error('must not sign twice'); }, async canBroadcast() { return false; } });
    await next.service.tick(); assert.equal((await get(r.id)).raw_tx, first.raw_tx); assert.equal(next.sends.length, 0);
    assert.equal((await get(r.id)).status, 'signed');
    const extra = await queue(f); await next.service.tick(); assert.equal((await get(extra.id)).status, 'queued');
  });
  await t.test('known publication is adopted with no signature and API status carries its confirmation anchor', async () => {
    const f = await fixture(), r = await queue(f), anchor = { blockHash: encode(randomBytes(32), Encoding.KeyBlockHash), height: 100, tipHeight: 103 };
    const run = runtime(f, { async existing() { return anchor; } }); await run.service.tick();
    const saved = await get(r.id); assert.equal(saved.status, 'reconciled'); assert.equal(saved.raw_tx, null); assert.equal(run.prepares, 0); assert.equal(run.sends.length, 0);
    const status = await f.api.repo.status(f.deployment, r.id, creator); assert.equal(status.blockHash, anchor.blockHash); assert.equal(status.height, 100);
    await assert.rejects(rpc(f.api, f.deployment, 'reconcile', anchor), { code: 'SH401' });
  });
  await t.test('revocation after preparation prevents any signature from being persisted or submitted', async () => {
    const f = await fixture(), r = await queue(f), run = runtime(f), prepare = run.node.prepare;
    run.node.prepare = async intent => { const result = await prepare(intent); await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"rejected\"') WHERE id=$1", [r.id]); return result; };
    await run.service.tick(); assert.equal((await get(r.id)).raw_tx, null); assert.equal(run.sends.length, 0);
    await run.service.tick(); assert.equal((await get(r.id)).status, 'cancelled');
  });
  await t.test('saved signatures become observation-only when policy is revoked', async () => {
    const f = await fixture(), r = await queue(f), run = runtime(f); await run.service.tick();
    await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"rejected\"') WHERE id=$1", [r.id]);
    await run.service.tick(); assert.equal(run.sends.length, 1); assert.equal((await get(r.id)).broadcast_blocked, true);
    run.node.observe = async claim => ({ state: 'settled', proof: proof(claim) }); await run.service.tick();
    assert.equal((await get(r.id)).status, 'confirmed');
  });
  await t.test('overlapping ticks share one operation and shutdown cannot broadcast a prepared request', async () => {
    const f = await fixture(), r = await queue(f), run = runtime(f), original = run.node.prepare;
    let finish, entered; const ready = new Promise(resolve => { entered = resolve; });
    run.node.prepare = async intent => { const value = await original(intent); entered(); await new Promise(resolve => { finish = resolve; }); return value; };
    const tick = run.service.tick(); assert.equal(run.service.tick(), tick); await ready;
    const stop = run.service.onModuleDestroy(); finish(); await Promise.all([tick, stop]);
    assert.equal((await get(r.id)).raw_tx, null); assert.equal(run.sends.length, 0); await run.service.tick(); assert.equal(run.prepares, 1);
  });
  await t.test('shutdown cancels an accepted HTTP submission and another principal recovers its exact saved bytes', async () => {
    const { createServer } = require('node:http');
    const { createHttpHeaders } = require('@azure/core-rest-pipeline');
    const f = await fixture(), r = await queue(f), accepted = [];
    let entered, closed;
    const received = new Promise(resolve => { entered = resolve; });
    const disconnected = new Promise(resolve => { closed = resolve; });
    const server = createServer(async (req, res) => {
      res.on('close', closed);
      const chunks = []; for await (const part of req) chunks.push(part);
      accepted.push(JSON.parse(Buffer.concat(chunks)).tx);
      entered(); // Node accepted the bytes but never returns the acknowledgement.
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, transport = publisherTransport(origin);
    const run = runtime(f, { async broadcast(raw) {
      await transport.sendRequest({ url: origin + '/v3/transactions', method: 'POST',
        headers: createHttpHeaders(), body: JSON.stringify({ tx: raw }) });
    } });
    try {
      const tick = run.service.tick(); await received;
      await run.service.onModuleDestroy(); await tick; await disconnected;
      const saved = await get(r.id);
      assert.equal(saved.status, 'signed'); assert.deepEqual(accepted, [saved.raw_tx]);
      assert.equal(run.prepares, 1);
      // A normal shutdown leaves a fenced recoverable lease; advance only this fixture's lease.
      await owner.query("UPDATE shorts_publication_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [r.id]);
      f.signer = f.other;
      const replacement = runtime(f, { async prepare() { assert.fail('must not sign a replacement'); } });
      await replacement.service.tick();
      assert.deepEqual(replacement.sends, [{ raw: saved.raw_tx, hash: saved.tx_hash }]);
      assert.equal((await get(r.id)).raw_tx, saved.raw_tx);
    } finally { server.closeAllConnections(); server.close(); }
  });
  await t.test('SIGKILL during a lost broadcast acknowledgement is recovered by another real database principal', async () => {
    const { fork } = require('node:child_process'); const { once } = require('node:events'); const { join } = require('node:path');
    const f = await fixture(), r = await queue(f), run = runtime(f), prepared = await run.node.prepare(r);
    const child = fork(join(__dirname, 'testing/publisher-runtime.cjs'), [], { execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'],
      env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', SHORTS_TEST_PG_URL: f.signer.url, SHORTS_TEST_PG_SCHEMA: schema,
        SHORTS_TEST_PUBLISHER_CONFIG: JSON.stringify({ ...f.deployment, pollMs: 1000 }), SHORTS_TEST_SIGNED_TRANSACTION: prepared.rawTransaction }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000); let stderr = ''; child.stderr.on('data', d => { stderr += d; });
    try {
      const message = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error('Publisher exited: ' + stderr); })]);
      assert.equal(message.submitted, true); const persisted = await get(r.id); assert.equal(persisted.raw_tx, message.rawTransaction);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      await owner.query("UPDATE shorts_publication_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [r.id]);
      f.signer = f.other; const replacement = runtime(f, { async prepare() { throw new Error('must not create replacement transaction'); } });
      await replacement.service.tick(); assert.equal(replacement.sends.length, 1); assert.equal(replacement.sends[0].raw, message.rawTransaction); assert.equal(replacement.sends[0].hash, message.transactionHash);
    } finally { clearTimeout(timeout); child.kill('SIGKILL'); }
  });
  await t.test('hosted API queues without signing and keeps an unconfirmed on-chain video unplayable', async () => {
    const f = await fixture(), r = await content(f, { publication: 'draft' });
    let projection, streams = 0, pins = 0;
    const blockHash = encode(randomBytes(32), Encoding.MicroBlockHash);
    const chain = { release: { ...f.deployment.scope }, state: { ...f.deployment.scope, shorts: [], sourceHash }, address: value => value,
      async write() { assert.fail('API must never sign'); }, async read(method) { return method === 'get_short' ? projection : false; },
      sdk: { api: { async getCurrentKeyBlock() { return { height: 104 }; }, async getGenerationByHeight(height) { return { keyBlock: { height, hash: encode(randomBytes(32), Encoding.KeyBlockHash) }, microBlocks: [blockHash] }; }, async getStatus() { return { networkId: 'ae_uat' }; } } } };
    const api = new ShortsApiPublicationService(chain, f.api.repo); api.deployment = f.deployment;
    const records = new ShortsRecordsService(chain, meta);
    const service = new ShortsService(chain, { async ensurePinned() { pins++; } }, { async counters() { return {}; } }, undefined, undefined, undefined,
      { async enqueue() { streams++; } }, undefined, records, api);
    const response = await service.publish(creator, r.id);
    assert.equal(response.publicationPending, true); assert.equal(response.publicationRequest, 'preparing'); assert.equal(response.publicationStatus, 'draft'); assert.equal(pins, 0);
    const hosting = new ShortsHostedHostingService(chain, service.media, service, records, new ShortsLifecycleJobsService(owner));
    await hosting.reconcile(); await hosting.onModuleDestroy();
    assert.equal(pins, 1); assert.equal((await service.publication(creator, r.id)).publicationRequest, 'queued');
    projection = { creator, cid: r.cid, size: BigInt(r.bytes), withdrawn: false, likes: 0n };
    await assert.rejects(service.ensurePlayable(r.id), { status: 404 });
    await assert.rejects(service.publication(f.account.address, r.id), { status: 403 });
    const run = runtime(f); await run.service.tick();
    assert.equal((await service.publication(creator, r.id)).publicationStatus, 'draft'); assert.equal(streams, 0);
    run.node.observe = async claim => ({ state: 'settled', proof: { ...proof(claim), blockHash } }); await run.service.tick();
    const complete = await service.publication(creator, r.id); assert.equal(complete.publicationStatus, 'published'); assert.equal(complete.publicationPending, false); assert.equal(streams, 1);
    assert.equal((await service.ensurePlayable(r.id)).id, r.id);
    chain.sdk.api.getGenerationByHeight = async height => ({ keyBlock: { height, hash: encode(randomBytes(32), Encoding.KeyBlockHash) }, microBlocks: [] });
    await assert.rejects(service.ensurePlayable(r.id), { status: 503 });
  });
  await t.test('durable preparation survives storage refusal, concurrent publish retries and lost enqueue acknowledgement', async () => {
    const f = await fixture(), r = await content(f, { publication: 'draft' });
    let denied = true, pins = 0, enqueues = 0;
    const chain = { release: { ...f.deployment.scope }, state: { ...f.deployment.scope, shorts: [], sourceHash }, address: value => value,
      serial() { assert.fail('Slow preparation must not use the local mutation queue'); },
      async read() { return undefined; }, async write() { assert.fail('API must not sign'); } };
    const api = new ShortsApiPublicationService(chain, f.api.repo); api.deployment = f.deployment;
    const records = new ShortsRecordsService(chain, meta), jobs = new ShortsLifecycleJobsService(owner);
    const media = { async ensurePinned() { pins++; if (denied) throw new Error('Storage full'); } };
    const service = new ShortsService(chain, media, { async counters() { return { views: 0 }; } }, undefined, undefined, undefined,
      undefined, undefined, records, api);
    const responses = await Promise.allSettled(Array.from({ length: 5 }, () => service.publish(creator, r.id)));
    assert.ok(responses.some(value => value.status === 'fulfilled'));
    assert.ok(responses.every(value => value.status === 'fulfilled'
      ? value.value.publicationRequest === 'preparing' : value.reason.status === 503), 'The bounded SQL pool may reject excess concurrent status reads');
    assert.equal(pins, 0); assert.equal(await get(r.id), undefined);
    const row = async () => (await owner.query('SELECT * FROM shorts_lifecycle_jobs WHERE id=$1', [r.id]))[0];
    const initial = await row();
    const worker = new ShortsHostedHostingService(chain, media, service, records, jobs);
    await worker.reconcile(); await worker.onModuleDestroy();
    assert.equal((await row()).result, 'failed'); assert.equal((await row()).attempts, 1);
    assert.equal((await records.get(r.id)).publication, 'pending'); assert.equal(await get(r.id), undefined);
    await service.publish(creator, r.id);
    assert.equal((await row()).generation, initial.generation, 'HTTP retries must preserve backoff and the claim generation');
    assert.equal((await row()).attempts, 1);
    denied = false;
    const enqueue = api.enqueue.bind(api);
    api.enqueue = async (...args) => { enqueues++; await enqueue(...args); throw new Error('Lost enqueue acknowledgement'); };
    const due = () => owner.query("UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.id]);
    await due();
    const replacement = new ShortsHostedHostingService(chain, media, service, records, new ShortsLifecycleJobsService(owner));
    await replacement.reconcile();
    assert.equal((await get(r.id)).status, 'queued'); assert.equal(enqueues, 1); assert.equal(pins, 2);
    await due(); await replacement.reconcile(); await replacement.onModuleDestroy();
    assert.equal(enqueues, 1); assert.equal(pins, 2, 'A saved journal request must not upload again');
    assert.equal((await row()).result, 'publication_pending');
    assert.equal((await service.publication(creator, r.id)).publicationRequest, 'queued');
  });
  await t.test('API checks a durable confirmation against the current chain before publishing metadata', async () => {
    const f = await fixture(), r = await queue(f), run = runtime(f); await run.service.tick();
    const blockHash = encode(randomBytes(32), Encoding.MicroBlockHash);
    run.node.observe = async claim => ({ state: 'settled', proof: { ...proof(claim), blockHash } }); await run.service.tick();
    const chain = { sdk: { api: { async getCurrentKeyBlock() { return { height: 104 }; }, async getGenerationByHeight(height) { return { keyBlock: { height, hash: encode(randomBytes(32), Encoding.KeyBlockHash) }, microBlocks: [blockHash] }; }, async getStatus() { return { networkId: 'ae_uat' }; } } } };
    const api = new ShortsApiPublicationService(chain, f.api.repo); api.deployment = f.deployment;
    assert.equal((await api.status(r.id, creator)).status, 'confirmed');
    chain.sdk.api.getGenerationByHeight = async height => ({ keyBlock: { height, hash: encode(randomBytes(32), Encoding.KeyBlockHash) }, microBlocks: [] }); await assert.rejects(api.status(r.id, creator), { status: 503 });
    chain.sdk.api.getGenerationByHeight = async height => ({ keyBlock: { height, hash: encode(randomBytes(32), Encoding.KeyBlockHash) }, microBlocks: [blockHash] }); chain.sdk.api.getCurrentKeyBlock = async () => ({ height: 102 });
    await assert.rejects(api.status(r.id, creator), { status: 503 });
  });
});

test('publisher node verifies canonical inclusion, call identity, depth and absent-only rebroadcast', async () => {
  const account = AccountMemory.generate(), scope = { network: 'ae_uat', contract: encode(randomBytes(32), Encoding.ContractAddress) };
  const blockHash = encode(randomBytes(32), Encoding.MicroBlockHash), keyHash = encode(randomBytes(32), Encoding.KeyBlockHash), txHash = encode(randomBytes(32), Encoding.TxHash);
  const intent = { id: randomUUID(), creator: AccountMemory.generate().address, cid: 'bafyfixture', bytes: 123 };
  const config = { operator: account.address, scope, release: releaseFixture({ ...scope, operator: account.address }).release, policy: { confirmations: 3 } };
  const service = new ShortsPublisherNodeService(config), claim = { intent, transactionHash: txHash, nonce: 1, ttl: 110 };
  let tip = 104, nonce = 0, missing = false, responseError, generationCalls = 0, changed = false;
  const tx = { hash: txHash, blockHeight: 101, blockHash, tx: { type: 'ContractCallTx', callerId: account.address, contractId: scope.contract, nonce: 1, amount: 0n, callData: publicationCalldata(intent) } };
  const call = { callerId: account.address, callerNonce: 1, contractId: scope.contract, height: 101, returnType: 'ok' };
  service.node = {
    async getStatus() { return { networkId: 'ae_uat' }; },
    async getCurrentKeyBlock() { return { height: tip, hash: keyHash }; },
    async getAccountByPubkey() { return { kind: 'basic', nonce }; },
    async getTransactionByHash() { if (responseError) throw responseError; if (missing) throw Object.assign(new Error('absent'), { statusCode: 404 }); return tx; },
    async getGenerationByHeight(height) { generationCalls++; return { keyBlock: { height, hash: changed && generationCalls > 1 ? encode(randomBytes(32), Encoding.KeyBlockHash) : keyHash }, microBlocks: [blockHash] }; },
    async getTransactionInfoByHash() { return { callInfo: call }; }, async getMicroBlockTransactionsByHash() { return { transactions: [{ hash: txHash }] }; },
  };
  assert.equal((await service.observe(claim)).state, 'settled'); tip = 103; assert.equal((await service.observe(claim)).state, 'pending'); tip = 104;
  call.callerNonce = 2; await assert.rejects(service.observe(claim), /not canonical/); call.callerNonce = 1;
  changed = true; generationCalls = 0; await assert.rejects(service.observe(claim), /confirmation changed/); changed = false;
  missing = true; assert.equal((await service.observe(claim)).state, 'absent'); responseError = Object.assign(new Error('outage'), { statusCode: 503 }); await assert.rejects(service.observe(claim), /outage/);
  assert.equal(await service.canBroadcast(claim), true); nonce = 1; assert.equal(await service.canBroadcast(claim), false); nonce = 0; tip = 110; assert.equal(await service.canBroadcast(claim), false);
  service.node.getStatus = async () => ({ networkId: 'ae_mainnet' }); await assert.rejects(service.canBroadcast(claim), /network changed/);
});

test('publisher node transport rejects redirects, oversized bodies, timeouts and other origins', async t => {
  const { createServer } = require('node:http'); const { createHttpHeaders } = require('@azure/core-rest-pipeline');
  const server = createServer((req, res) => {
    if (req.url === '/v3/redirect') { res.writeHead(302, { location: '/v3/ok' }); res.end(); }
    else if (req.url === '/v3/oversize') { res.writeHead(200, { 'content-length': 6000000 }); res.end(); }
    else if (req.url !== '/v3/slow') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, client = publisherTransport(origin, 80);
  const request = path => ({ url: origin + path, method: 'GET', headers: createHttpHeaders() });
  assert.equal((await client.sendRequest(request('/v3/ok'))).bodyAsText, '{"ok":true}');
  await assert.rejects(client.sendRequest(request('/v3/redirect'))); await assert.rejects(client.sendRequest(request('/v3/oversize')), /too large/);
  await assert.rejects(client.sendRequest(request('/v3/slow'))); await assert.rejects(client.sendRequest({ ...request('/v3/ok'), url: 'https://example.invalid/v3/ok' }), /authority/);
  await assert.rejects(client.sendRequest({ ...request('/v3/admin'), method: 'POST' }), /authority/);
});

test('publisher configuration rejects shared secrets, wrong deployments and insecure key files', async t => {
  const { mkdtemp, writeFile, chmod, symlink, rm } = require('node:fs/promises'); const { tmpdir } = require('node:os'); const { join } = require('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'shorts-publisher-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const account = AccountMemory.generate();
  const { artifact, release: manifest } = releaseFixture({ operator: account.address });
  const limits = { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000', maxPending: 8, maxCreatorPending: 2, leaseMs: 120000, maxTtlBlocks: 30, confirmations: 3 };
  const env = { ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1', SHORTS_DEPLOYMENT_FILE: join(dir, 'deployment.json'), SHORTS_CONTRACT_ARTIFACT: join(dir, 'artifact.json'), SHORTS_PUBLISHING_POLICY_FILE: join(dir, 'policy.json'), SHORTS_OPERATOR_KEY_FILE: join(dir, 'key.json') };
  for (const [path, data] of [[env.SHORTS_DEPLOYMENT_FILE, manifest], [env.SHORTS_CONTRACT_ARTIFACT, artifact], [env.SHORTS_PUBLISHING_POLICY_FILE, limits], [env.SHORTS_OPERATOR_KEY_FILE, { secretKey: account.secretKey }]]) await writeFile(path, JSON.stringify(data), { mode: 0o600 });
  assert.equal((await shortsPublisherConfig(env)).operator, account.address);
  for (const patch of [{ SHORTS_S3_SECRET_KEY_FILE: '/other-key' }, { SHORTS_IPFS_TOKEN_FILE: '/pin-key' }, { AE_NETWORK_ID: 'ae_mainnet' }, { SHORTS_PUBLISHER_NODE_URL: 'http://remote.invalid' }, { SHORTS_DEMO_AUTO_APPROVE: '1' }]) await assert.rejects(shortsPublisherConfig({ ...env, ...patch }));
  await chmod(env.SHORTS_OPERATOR_KEY_FILE, 0o644); await assert.rejects(publisherJson(env.SHORTS_OPERATOR_KEY_FILE, true), /permissions/);
  await chmod(env.SHORTS_OPERATOR_KEY_FILE, 0o600); await symlink(env.SHORTS_OPERATOR_KEY_FILE, join(dir, 'symlink.json')); await assert.rejects(publisherJson(join(dir, 'symlink.json'), true));
});


test('hosted chain refuses a signing key and direct write before accessing key material or the network', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { ENABLE_SHORTS: 'true', SHORTS_TESTNET_MVP: '1', AE_NETWORK_ID: 'ae_uat', NODE_ENV: 'test', SHORTS_OPERATOR_KEY_FILE: '/must-not-be-read' });
    const chain = new ShortsChainService(undefined, undefined, { shared: true });
    await assert.rejects(chain.onModuleInit(), /only in the isolated publisher/);
    await assert.rejects(chain.write('publish', []), /cannot sign/);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('real SDK and bounded HTTP transport build an absolute-TTL signature before any submission', async t => {
  const { createServer } = require('node:http'), { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { join } = require('node:path'), { tmpdir } = require('node:os'), { createHash } = require('node:crypto');
  const { unpackTx } = require('@aeternity/aepp-sdk'); const { AciContractCallEncoder, ContractByteArrayEncoder, TypeResolver } = require('@aeternity/aepp-calldata');
  const { publicationTransaction } = require('./shorts-publication-transaction');
  const account = AccountMemory.generate(), contract = encode(randomBytes(32), Encoding.ContractAddress), keyHash = encode(randomBytes(32), Encoding.KeyBlockHash);
  const previousContract = encode(randomBytes(32), Encoding.ContractAddress);
  const previousCode = encode(randomBytes(32), Encoding.ContractBytearray);
  let observedPreviousCode = previousCode;
  const bytecode = encode(randomBytes(32), Encoding.ContractBytearray), dir = await mkdtemp(join(tmpdir(), 'publisher-sdk-'));
  const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
    { name: 'get_config', arguments: [], returns: { tuple: ['address', 'address', 'int', 'int'] }, payable: false, stateful: false },
    { name: 'get_previous', arguments: [], returns: { option: ['contract_pubkey'] }, payable: false, stateful: false },
    { name: 'publish', arguments: [{ name: 'id', type: 'string' }, { name: 'creator', type: 'address' }, { name: 'cid', type: 'string' }, { name: 'size', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true },
  ] } }];
  const encoder = new AciContractCallEncoder(aci);
  const encodeResult = (method, value) => new ContractByteArrayEncoder().encodeWithType(value, new TypeResolver().resolveType(aci[0].contract.functions.find(fn => fn.name === method).returns));
  const requests = [], submitted = [];
  let observedNetwork = 'ae_uat', observedCode = bytecode, observedConfig = [account.address, account.address, 100000000000000000n, 2000], observedPrevious;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push(req.url); let result; res.setHeader('content-type', 'application/json');
    if (req.url === '/v3/status') result = { node_version: '7.2.0', network_id: observedNetwork, protocols: [{ version: 6, effective_at_height: 0 }], top_block_height: 100 };
    else if (req.url === '/v3/key-blocks/current') result = { hash: keyHash, height: 100 };
    else if (req.url === '/v3/key-blocks/current/height') result = { height: 100 };
    else if (req.url === '/v3/recent-gas-prices') result = [{ min_gas_price: 1000000000, utilization: 0, minutes: 1 }];
    else if (req.url.startsWith('/v3/accounts/')) result = { id: req.url.split('/')[3], balance: '100000000000000000000', nonce: 0, kind: 'basic' };
    else if (req.url === `/v3/contracts/${contract}`) result = { id: contract, active: true, owner_id: account.address, vm_version: 8, abi_version: 3, referrer_ids: [] };
    else if (req.url === `/v3/contracts/${previousContract}`) result = { id: previousContract, active: true, owner_id: account.address, vm_version: 8, abi_version: 3, referrer_ids: [] };
    else if (req.url === `/v3/contracts/${previousContract}/code`) result = { bytecode: observedPreviousCode };
    else if (req.url === `/v3/contracts/${contract}/code`) result = { bytecode: observedCode };
    else if (req.url === '/v3/dry-run') result = { results: body.txs.map(item => {
      const tx = unpackTx(item.tx, Tag.ContractCallTx), config = tx.callData === encoder.encodeCall('Shorts', 'get_config', []);
      return { type: 'contract_call', result: 'ok', call_obj: { caller_id: tx.callerId, caller_nonce: tx.nonce, contract_id: contract, height: 100, gas_price: 1000000000, gas_used: 1000, log: [], return_type: 'ok', return_value: config ? encodeResult('get_config', observedConfig) : tx.callData === encoder.encodeCall('Shorts', 'get_previous', []) ? encodeResult('get_previous', observedPrevious) : encodeResult('publish', []) } };
    }) };
    else if (req.url === '/v3/transactions') { submitted.push(body.tx); result = { tx_hash: buildTxHash(body.tx) }; }
    else { res.statusCode = 404; result = {}; }
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const keyFile = join(dir, 'operator.json'); await writeFile(keyFile, JSON.stringify({ secretKey: account.secretKey }), { mode: 0o600 });
  const config = { scope: { network: 'ae_uat', contract }, operator: account.address, keyFile, nodeUrl: `http://127.0.0.1:${server.address().port}`,
    artifact: { aci, bytecodeHash: createHash('sha256').update(bytecode).digest('hex') }, policy: { maxTransactionCost: '2000000000000000', maxTtlBlocks: 20, confirmations: 3 } };
  config.release = releaseFixture({ contract, operator: account.address, treasury: account.address, node: config.nodeUrl }, { aci, bytecode, bytecodeHash: digest(bytecode) }).release;
  const service = new ShortsPublisherNodeService(config); await service.onModuleInit();
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  const deploymentPath = join(dir, 'release.json'), artifactPath = join(dir, 'artifact.json');
  const artifact = { ...config.artifact, compiler: config.release.compiler, sourceHash: config.release.sourceHash, bytecode };
  await writeFile(deploymentPath, JSON.stringify(config.release)); await writeFile(artifactPath, JSON.stringify(artifact));
  Object.assign(process.env, { ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1', NODE_ENV: 'test', SHORTS_DEPLOYMENT_FILE: deploymentPath, SHORTS_CONTRACT_ARTIFACT: artifactPath });
  delete process.env.SHORTS_OPERATOR_KEY_FILE;
  const createChain = () => new ShortsChainService({ save() { assert.fail('Hosted startup cannot save local state'); } }, {}, { shared: true });
  const chain = createChain(); await chain.onModuleInit(); assert.deepEqual(chain.release, config.release);
  assert.equal(chain.state.contract, contract); assert.equal(chain.operator.address, account.address);
  const intent = { id: randomUUID(), creator: AccountMemory.generate().address, cid: 'bafyfixture', bytes: 123 };
  let signatures = 0; const sign = service.account.signTransaction.bind(service.account);
  service.account.signTransaction = (...args) => { signatures++; return sign(...args); };
  for (const mismatch of ['network', 'bytecode', 'operator', 'treasury', 'fee', 'split', 'previous']) {
    const originalConfig = [...observedConfig];
    if (mismatch === 'network') observedNetwork = 'ae_mainnet';
    if (mismatch === 'bytecode') observedCode = encode(randomBytes(32), Encoding.ContractBytearray);
    if (['operator', 'treasury', 'fee', 'split'].includes(mismatch)) { const i = ['operator', 'treasury', 'fee', 'split'].indexOf(mismatch); observedConfig[i] = i < 2 ? AccountMemory.generate().address : 1; }
    if (mismatch === 'previous') observedPrevious = previousContract;
    await assert.rejects(service.prepare(intent), /network|bytecode|configuration|previous/);
    await assert.rejects(createChain().onModuleInit(), /testnet|bytecode|configuration|Previous/);
    if (mismatch === 'network') await assert.rejects(chain.assertTestnet(), /testnet/);
    assert.equal(signatures, 0); assert.equal(submitted.length, 0);
    observedNetwork = 'ae_uat'; observedCode = bytecode; observedConfig = originalConfig; observedPrevious = undefined;
  }
  await t.test('hosted predecessor loading binds its receipt, ABI and deployed code to the manifest', async () => {
    const oldArtifact = { ...artifact, compiler: '7.0.0', sourceHash: 'b'.repeat(64), bytecode: previousCode, bytecodeHash: digest(previousCode) };
    const oldReceipt = { contract: previousContract, network: 'ae_uat', compiler: oldArtifact.compiler, sourceHash: oldArtifact.sourceHash, bytecodeHash: oldArtifact.bytecodeHash };
    const previousArtifact = { compiler: oldArtifact.compiler, sourceHash: oldArtifact.sourceHash, bytecodeHash: oldArtifact.bytecodeHash, aciHash: digest(JSON.stringify(oldArtifact.aci)) };
    const oldReceiptPath = join(dir, 'previous.json'), oldArtifactPath = join(dir, 'previous-artifact.json');
    Object.assign(process.env, { SHORTS_PREVIOUS_DEPLOYMENT_FILE: oldReceiptPath, SHORTS_PREVIOUS_CONTRACT_ARTIFACT: oldArtifactPath });
    await writeFile(deploymentPath, JSON.stringify({ ...config.release, previousContract, previousArtifact }));
    await writeFile(oldReceiptPath, JSON.stringify(oldReceipt)); await writeFile(oldArtifactPath, JSON.stringify(oldArtifact));
    observedPrevious = previousContract;
    const previousChain = createChain(); await previousChain.onModuleInit();
    assert.equal(previousChain.previous.$options.address, previousContract);
    await writeFile(oldArtifactPath, JSON.stringify({ ...oldArtifact, aci: [{ changed: true }] }));
    await assert.rejects(createChain().onModuleInit(), /artifact/);
    await writeFile(oldArtifactPath, JSON.stringify(oldArtifact));
    await writeFile(oldReceiptPath, JSON.stringify({ ...oldReceipt, network: 'ae_mainnet' }));
    await assert.rejects(createChain().onModuleInit(), /Previous deployment/);
    await writeFile(oldReceiptPath, JSON.stringify({ ...oldReceipt, compiler: '9.0.0' }));
    await assert.rejects(createChain().onModuleInit(), /Previous deployment/);
    await writeFile(oldReceiptPath, JSON.stringify(oldReceipt));
    observedPreviousCode = bytecode;
    await assert.rejects(createChain().onModuleInit(), /Previous deployment/);
    observedPreviousCode = previousCode; observedPrevious = undefined;
    await writeFile(deploymentPath, JSON.stringify(config.release));
    assert.equal(signatures, 0); assert.equal(submitted.length, 0);
  });
  const prepared = await service.prepare(intent); const checked = publicationTransaction(prepared.rawTransaction, intent, contract, account.address, 0, 100, config.policy, config.scope.network);
  assert.equal(checked.ttl, 120); assert.equal(checked.nonce, 1); assert.equal(submitted.length, 0); assert.ok(requests.includes('/v3/dry-run'));
  await service.broadcast(prepared.rawTransaction, checked.hash); assert.deepEqual(submitted, [prepared.rawTransaction]);
});
