require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { AccountMemory, buildTx, buildTxHash, decode, encode, Encoding, Tag, unpackTx } = require('@aeternity/aepp-sdk');
const { AciContractCallEncoder } = require('@aeternity/aepp-calldata');
const { likeInnerTransaction, sponsoredLikeTransaction, likeSponsorshipPolicy } = require('./shorts-like-sponsorship-transaction');
const { observeSponsoredLike, proveSponsoredLikeExpiry } = require('./shorts-sponsored-observation');
const { ShortsLikeSponsorWorker } = require('./shorts-like-sponsor-worker.service');
const { PublisherAttempt } = require('./shorts-publisher-attempt');
const { ShortsWalletTransactionsService } = require('./shorts-wallet-transactions.service');
const { likeSponsorConfig } = require('./shorts-like-sponsorship.config');
const { ShortsLikeSponsorshipService } = require('./shorts-like-sponsorship.service');
const { SHORTS_HTTP_POLICY } = require('./shorts-rate-policy');
const { releaseFixture } = require('./shorts-release.fixture.cjs');
const policy = likeSponsorshipPolicy({
  gasLimit: 100000, gasPrice: '1000000000', maxFee: '1000000000000000',
  maxTransactionCost: '3000000000000000', rollingCostLimit: '30000000000000000',
  maxPending: 10, maxActorPerDay: 20, maxRequestsPerDay: 100, ttlBlocks: 20,
});
const coder = new AciContractCallEncoder([{ contract: {
  name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
    { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'version', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true },
    { name: 'claim', arguments: [], returns: { tuple: [] }, payable: false, stateful: true },
  ],
} }]);
const encoded = kind => encode(randomBytes(32), kind);
async function fixture() {
  const actor = AccountMemory.generate(), payer = AccountMemory.generate();
  const contract = encoded(Encoding.ContractAddress);
  const unsigned = buildTx({ tag: Tag.ContractCallTx, callerId: actor.address, contractId: contract, abiVersion: 3,
    amount: 0, nonce: 1, ttl: 110, gasLimit: 100000, gasPrice: policy.gasPrice, fee: '300000000000000',
    callData: coder.encodeCall('Shorts', 'like', ['video-id', 3]) });
  const sign = (tx, options = {}) => actor.signTransaction(tx, { networkId: 'ae_uat', innerTx: true, ...options });
  const inner = await sign(unsigned);
  const wrap = async (raw, overrides = {}) => payer.signTransaction(buildTx({
    tag: Tag.PayingForTx, payerId: payer.address, nonce: 4, fee: '300000000000000', tx: raw, ...overrides,
  }), { networkId: 'ae_uat' });
  const outer = await wrap(inner);
  const expected = { actor: actor.address, contract, network: 'ae_uat', policy, payer: payer.address };
  return { actor, payer, contract, unsigned, inner, outer, expected, sign, wrap };
}
function nodeEnvelope(raw) {
  const signed = unpackTx(raw), tx = signed.encodedTx;
  return {
    signatures: signed.signatures.map(sig => encode(sig, Encoding.Signature)),
    tx: tx.tag === Tag.PayingForTx
      ? { type: 'PayingForTx', version: 1, payerId: tx.payerId, nonce: tx.nonce, fee: tx.fee,
        tx: nodeEnvelope(buildTx({ tag: Tag.SignedTx, encodedTx: buildTx(tx.tx.encodedTx), signatures: tx.tx.signatures })) }
      : { ...tx, type: 'ContractCallTx', gas: tx.gasLimit },
  };
}
test('zero-payment Like validates user inner domain and dedicated sponsor envelope', async () => {
  const f = await fixture();
  const inner = likeInnerTransaction(f.inner, { ...f.expected, height: 100 });
  assert.equal(inner.videoId, 'video-id'); assert.equal(inner.version, '3'); assert.equal(inner.nonce, 1);
  const result = sponsoredLikeTransaction(f.outer, f.inner, { ...f.expected, payerNonce: 4 });
  assert.equal(result.innerHash, buildTxHash(f.inner));
  assert.equal(result.outerHash, buildTxHash(f.outer));
  assert.equal(result.cost, '700000000000000');
});
test('sponsor rejects ordinary-domain signatures, wrong actor/network/contract and money transfer', async () => {
  const f = await fixture(), call = unpackTx(f.unsigned);
  for (const raw of [
    await f.sign(f.unsigned, { innerTx: false }),
    await f.sign(f.unsigned, { networkId: 'ae_mainnet' }),
    await f.sign(buildTx({ ...call, amount: 1 })),
    await f.sign(buildTx({ ...call, callerId: f.payer.address })),
    await f.sign(buildTx({ ...call, contractId: encoded(Encoding.ContractAddress) })),
    await f.sign(buildTx({ ...call, callData: coder.encodeCall('Shorts', 'claim', []) })),
  ]) assert.throws(() => likeInnerTransaction(raw, f.expected));
  assert.throws(() => likeInnerTransaction(f.inner, { ...f.expected, network: 'ae_mainnet' }));
});
test('sponsor caps gas price, gas limit, fees and expiry, rejects extra nesting', async () => {
  const f = await fixture(), call = unpackTx(f.unsigned);
  for (const change of [{ gasLimit: 100001 }, { gasPrice: '1000000001' }, { fee: '1000000000000001' }, { ttl: 0 }]) {
    const raw = await f.sign(buildTx({ ...call, ...change }));
    assert.throws(() => likeInnerTransaction(raw, f.expected));
  }
  assert.throws(() => likeInnerTransaction(f.inner, { ...f.expected, height: 110 }));
  assert.throws(() => likeInnerTransaction(f.inner, { ...f.expected, height: 89 }));
  const wrappedTwice = await f.wrap(f.outer);
  assert.throws(() => sponsoredLikeTransaction(wrappedTwice, f.inner, f.expected));
  assert.throws(() => sponsoredLikeTransaction(f.outer, f.inner, { ...f.expected, payerNonce: 5 }));
  assert.throws(() => sponsoredLikeTransaction(f.outer, f.inner, { ...f.expected, payer: f.actor.address }));
});
test('both envelopes and canonical execution bind sponsorship observation to the inner hash', async () => {
  const f = await fixture();
  const body = { hash: buildTxHash(f.outer), ...nodeEnvelope(f.outer), blockHeight: 98, blockHash: encoded(Encoding.MicroBlockHash) };
  const tip = { hash: encoded(Encoding.KeyBlockHash), height: 100 };
  const generation = { keyBlock: { hash: encoded(Encoding.KeyBlockHash), height: 98 }, microBlocks: [body.blockHash] };
  const info = { callInfo: { callerId: f.actor.address, callerNonce: 1, contractId: f.contract, height: 98, returnType: 'ok' } };
  const node = {
    getStatus: async () => ({ networkId: 'ae_uat' }), getTransactionByHash: async () => body,
    getCurrentKeyBlock: async () => tip, getGenerationByHeight: async () => generation,
    getTransactionInfoByHash: async () => info, postTransaction: () => assert.fail('Read-only observer must not broadcast'),
  };
  const result = await observeSponsoredLike(node, f.outer, f.inner, f.expected);
  assert.equal(result.status, 'confirmed'); assert.equal(result.tx, buildTxHash(f.inner)); assert.equal(result.sponsoredTx, body.hash);
  const chain = { state: { contract: f.contract }, sdk: { api: node }, release: { network: 'ae_uat', contract: f.contract, schemaVersion: 2 }, readNode: op => op() };
  const observer = new ShortsWalletTransactionsService(chain);
  const ordinary = await observer.observe(body.hash, f.actor.address, f.contract);
  assert.equal(ordinary.status, 'confirmed'); assert.equal(ordinary.innerHash, buildTxHash(f.inner)); assert.equal(ordinary.method, 'like');
  info.callInfo.callerNonce = 2;
  await assert.rejects(observeSponsoredLike(node, f.outer, f.inner, f.expected), /execution evidence/);
  info.callInfo.callerNonce = 1; generation.microBlocks = [];
  assert.equal((await observeSponsoredLike(node, f.outer, f.inner, f.expected)).status, 'reorged');
});
test('sponsorship stays pending on missing outer transaction and does not invent a receipt', async () => {
  const f = await fixture();
  const node = { getStatus: async () => ({ networkId: 'ae_uat' }), getTransactionByHash: async () => { throw { statusCode: 404 }; } };
  const result = await observeSponsoredLike(node, f.outer, f.inner, f.expected);
  assert.equal(result.status, 'unknown'); assert.equal(result.confirmations, 0);
  assert.equal(result.tx, buildTxHash(f.inner)); assert.equal(result.blockHeight, undefined);
});
test('durable rejected status proves no outer submission; signed jobs always obtain fresh observation', async () => {
  const f = await fixture(), release = { network: 'ae_uat', contract: f.contract, sourceHash: 'x', bytecodeHash: 'y' };
  let row = { innerHash: buildTxHash(f.inner), actor: f.actor.address, videoId: 'video-id', intent: { nonce: 1, ttl: 110, version: '3' }, status: 'rejected', outerHash: null };
  const repo = { call: async action => { assert.equal(action, 'status'); return row; } };
  const observer = { observe: async () => ({ status: 'unknown' }) };
  const service = new ShortsLikeSponsorshipService({ enabled: true, release, policy }, repo, { release, state: { contract: f.contract } }, observer);
  const rejected = await service.observe(row.innerHash, f.actor.address, f.contract);
  assert.equal(rejected.neverSubmitted, true); assert.equal(rejected.status, 'unknown');
  row = { ...row, status: 'signed', outerHash: buildTxHash(f.outer) };
  const pending = await service.observe(row.innerHash, f.actor.address, f.contract);
  assert.equal(pending.neverSubmitted, undefined); assert.equal(pending.status, 'unknown');
  assert.equal(pending.sponsoredTx, row.outerHash);
});
test('default-disabled sponsorship has no database/key requirement, and HTTP admission is explicit', async () => {
  assert.deepEqual(await likeSponsorConfig(false, {}), { enabled: false });
  await assert.rejects(likeSponsorConfig(false, { SHORTS_LIKE_SPONSOR_KEY_FILE: '/any/key' }), /isolated signer/);
  await assert.rejects(likeSponsorConfig(true, {}), /disabled/);
  assert.equal(SHORTS_HTTP_POLICY.sponsorLike.private, true);
  assert.equal(SHORTS_HTTP_POLICY.sponsoredLikeStatus.group, 'transactionStatus');
});

test('expiry recovery requires stable canonical depth, explicit absence and unconsumed payer nonce', async () => {
  const f = await fixture(), anchor = { hash: encoded(Encoding.KeyBlockHash), height: 113 };
  const payer = { kind: 'basic', nonce: 3 };
  let present = false;
  const node = {
    getStatus: async () => ({ networkId: 'ae_uat' }),
    getCurrentKeyBlock: async () => anchor,
    getKeyBlockByHeight: async () => anchor,
    getAccountByPubkeyAndHash: async () => ({ kind: 'basic', nonce: 3 }),
    getAccountByPubkey: async () => payer,
    getTransactionByHash: async () => { if (present) return { hash: buildTxHash(f.outer), blockHeight: -1 }; throw { statusCode: 404 }; },
  };
  const expected = { outerHash: buildTxHash(f.outer), ttl: 110, payer: f.payer.address, payerNonce: 4, network: 'ae_uat' };
  const proof = await proveSponsoredLikeExpiry(node, expected);
  assert.deepEqual(proof, { ttl: 110, height: 113, blockHash: anchor.hash, payerNonce: 3 });
  anchor.height = 112; assert.equal(await proveSponsoredLikeExpiry(node, expected), undefined);
  anchor.height = 113; present = true; assert.equal(await proveSponsoredLikeExpiry(node, expected), undefined);
  present = false; payer.nonce = 4; assert.equal(await proveSponsoredLikeExpiry(node, expected), undefined);
  // After the expired nonce has safely been reused, verify the saved historical
  // anchor rather than requiring the current payer nonce to remain unused forever.
  assert.deepEqual(await proveSponsoredLikeExpiry(node, expected, proof), proof);
  node.getKeyBlockByHeight = async () => ({ height: 113, hash: encoded(Encoding.KeyBlockHash) });
  assert.equal(await proveSponsoredLikeExpiry(node, expected, proof), undefined);
  node.getTransactionByHash = async () => { throw new Error('timeout'); };
  await assert.rejects(proveSponsoredLikeExpiry(node, expected), /timeout/);
});

test('exact-call dry-run rejects deterministic failures before a sponsor signature or broadcast', async () => {
  const f = await fixture(), actions = [];
  const job = { inner_hash: buildTxHash(f.inner), actor: f.actor.address, video_id: 'video-id', raw_inner: f.inner,
    intent: { nonce: 1, ttl: 110, version: '3' }, lease_token: '00000000-0000-4000-8000-000000000000', fence: '1', raw_outer: null };
  const repository = { call: async action => { if (action === 'anchor') return { version: 0, job: null, quarantined: false }; actions.push(action); return action === 'claim' ? job : undefined; } };
  const worker = new ShortsLikeSponsorWorker({ enabled: true, release: { contract: f.contract, network: 'ae_uat' }, policy, payer: f.payer.address }, repository);
  worker.verify = async () => ({ likesEnabled: true, version: '3' });
  worker.contract = { $call: async method => {
    assert.equal(method, 'migration_status'); return { decodedResult: { importing: false, frozen: false, abandoned: false } };
  } };
  worker.account = { signTransaction: () => assert.fail('Rejected simulation must not sign') };
  const top = { height: 100, hash: encoded(Encoding.MicroBlockHash) };
  worker.node = {
    getTopHeader: async () => top,
    getAccountByPubkeyAndHash: async (_, hash) => { assert.equal(hash, top.hash); return { kind: 'basic', nonce: 0 }; },
    protectedDryRunTxs: async request => {
      assert.equal(request.txs[0].tx, f.unsigned);
      assert.equal(request.accounts[0].pubKey, f.actor.address);
      return { results: [{ result: 'ok', callObj: { returnType: 'revert' } }] };
    },
    postTransaction: () => assert.fail('Rejected simulation must not broadcast'),
  };
  const attempt = new PublisherAttempt(new AbortController().signal, 5000);
  try { await attempt.run(() => worker.process(attempt)); } finally { attempt.close(); }
  assert.deepEqual(actions, ['claim', 'reject']);
});

test('disabled admission preserves public resolution of an existing signed sponsorship', async () => {
  const f = await fixture(), release = { network: 'ae_uat', contract: f.contract, sourceHash: 'x', bytecodeHash: 'y' };
  const row = { actor: f.actor.address, videoId: 'video-id', intent: { nonce: 1, ttl: 110, version: '3' }, status: 'signed', outerHash: buildTxHash(f.outer) };
  const repository = { call: async () => row };
  const service = new ShortsLikeSponsorshipService({ enabled: false, release, policy }, repository, { release, state: { contract: f.contract } }, { observe: async () => ({ status: 'unknown' }) });
  assert.deepEqual(await service.publicConfig(), { enabled: false });
  const observed = await service.observe(buildTxHash(f.inner), f.actor.address, f.contract);
  assert.equal(observed.sponsoredTx, row.outerHash);
  assert.equal(observed.tx, buildTxHash(f.inner));
});

test('public sponsorship availability follows durable pause, quarantine and role state without restart', async () => {
  const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
    { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'version', type: 'int' }],
      returns: { tuple: [] }, payable: false, stateful: true },
  ] } }];
  const { release, artifact } = releaseFixture({ schemaVersion: 2, likeFeeAetto: '0' }, { aci });
  const chain = { release, state: { contract: release.contract }, policy: async () => ({ likeFeeAetto: '0' }) };
  let binding = { kind: 'api', paused: true, quarantined: false }, unavailable = false;
  const repository = { call: async action => {
    assert.equal(action, 'verify');
    if (unavailable) throw new Error('Queue unavailable');
    return binding;
  } };
  const service = new ShortsLikeSponsorshipService({ enabled: true, release, artifact, policy }, repository, chain, {});
  await service.onApplicationBootstrap();
  assert.deepEqual(await service.publicConfig(), { enabled: false });
  binding.paused = false;
  assert.equal((await service.publicConfig()).enabled, true);
  binding.paused = true;
  assert.deepEqual(await service.publicConfig(), { enabled: false });
  binding = { ...binding, paused: false, quarantined: true };
  assert.deepEqual(await service.publicConfig(), { enabled: false });
  binding = { ...binding, quarantined: false, kind: 'signer' };
  assert.deepEqual(await service.publicConfig(), { enabled: false });
  binding.kind = 'api'; unavailable = true;
  assert.deepEqual(await service.publicConfig(), { enabled: false });
  unavailable = false;
  assert.equal((await service.publicConfig()).enabled, true);
  chain.state.contract = 'ct_wrong';
  assert.deepEqual(await service.publicConfig(), { enabled: false });
});

test('future user nonce is terminally rejected and cannot monopolize the sponsor queue', async () => {
  const f = await fixture(), actions = [];
  const raw = await f.sign(buildTx({ ...unpackTx(f.unsigned), nonce: 1000000 }));
  const job = { inner_hash: buildTxHash(raw), actor: f.actor.address, video_id: 'video-id', raw_inner: raw,
    intent: { nonce: 1000000, ttl: 110, version: '3' }, lease_token: '00000000-0000-4000-8000-000000000000', fence: '1', raw_outer: null };
  const worker = new ShortsLikeSponsorWorker({ enabled: true, release: { contract: f.contract, network: 'ae_uat' }, policy, payer: f.payer.address },
    { call: async action => { if (action === 'anchor') return { version: 0, job: null, quarantined: false }; actions.push(action); return action === 'claim' ? job : undefined; } });
  worker.verify = async () => ({ likesEnabled: true, version: '3' });
  worker.contract = { $call: async () => ({ decodedResult: { importing: false, frozen: false, abandoned: false } }) };
  worker.account = { signTransaction: () => assert.fail('Future nonce must not sign') };
  const top = { height: 100, hash: encoded(Encoding.MicroBlockHash) };
  worker.node = { getTopHeader: async () => top, getAccountByPubkeyAndHash: async () => ({ kind: 'basic', nonce: 0 }),
    protectedDryRunTxs: () => assert.fail('Invalid nonce must not simulate'), postTransaction: () => assert.fail('Invalid nonce must not broadcast') };
  const attempt = new PublisherAttempt(new AbortController().signal, 5000);
  try { await attempt.run(() => worker.process(attempt)); } finally { attempt.close(); }
  assert.deepEqual(actions, ['claim', 'reject']);
});

test('a mismatched unsigned journal intent is rejected while signed mismatch stays preserved for reconciliation', async t => {
  for (const signed of [false, true]) await t.test(signed ? 'signed mismatch preserves the journal' : 'unsigned mismatch releases the queue', async () => {
    const f = await fixture(), actions = [];
    const job = { inner_hash: buildTxHash(f.inner), actor: f.actor.address, video_id: 'video-id', raw_inner: f.inner,
      intent: { nonce: 2, ttl: 110, version: '3' }, lease_token: '00000000-0000-4000-8000-000000000000', fence: '1',
      raw_outer: signed ? f.outer : null, reserved_cost: signed ? '700000000000000' : null };
    const worker = new ShortsLikeSponsorWorker({ enabled: true, release: { contract: f.contract, network: 'ae_uat' }, policy, payer: f.payer.address },
      { call: async action => { if (action === 'anchor') return { version: 0, job: null, quarantined: false }; actions.push(action); return action === 'claim' ? job : undefined; } });
    worker.verify = async () => ({ likesEnabled: true, version: '3' });
    worker.account = { signTransaction: () => assert.fail('Mismatched intent must not sign') };
    worker.node = { postTransaction: () => assert.fail('Mismatched intent must not broadcast') };
    const attempt = new PublisherAttempt(new AbortController().signal, 5000);
    try {
      if (signed) {
        await assert.rejects(attempt.run(() => worker.process(attempt)), /journal identity changed/);
        assert.deepEqual(actions, ['claim', 'release']);
        assert.equal(job.raw_outer, f.outer); assert.equal(job.reserved_cost, '700000000000000');
      } else {
        await attempt.run(() => worker.process(attempt));
        assert.deepEqual(actions, ['claim', 'reject']);
      }
    } finally { attempt.close(); }
  });
});

test('recovery reauthorizes and signs exact reserved bytes; persistence precedes broadcast even after a lost acknowledgement', async () => {
  const f = await fixture(), actions = [];
  const unsignedOuter = buildTx(unpackTx(f.outer).encodedTx);
  let job = { inner_hash: buildTxHash(f.inner), actor: f.actor.address, video_id: 'video-id', raw_inner: f.inner,
    intent: { nonce: 1, ttl: 110, version: '3' }, lease_token: '00000000-0000-4000-8000-000000000000', fence: '1',
    raw_outer: null, prepared_outer: unsignedOuter, prepared_nonce: 4, prepared_cost: '700000000000000' };
  let persistFails = true, admissionPaused = false, broadcast = 0;
  const repository = { call: async (action, data) => {
    if (action === 'anchor') return { version: 0, job: null, quarantined: false }; actions.push(action);
    if (action === 'claim') return { ...job };
    if (action === 'reserve') {
      if (admissionPaused) throw new Error('Admission paused');
      assert.equal(data.unsignedOuter, unsignedOuter); assert.equal(data.cost, job.prepared_cost);
      return { ...job };
    }
    if (action === 'persist') {
      assert.equal(data.rawOuter, f.outer); assert.equal(data.unsignedOuter, unsignedOuter);
      job = { ...job, raw_outer: data.rawOuter, outer_hash: data.outerHash, payer_nonce: data.nonce, reserved_cost: data.cost };
      if (persistFails) throw new Error('Lost persistence acknowledgement');
      return { ...job };
    }
    if (action === 'authorize') { assert.equal(job.raw_outer, f.outer); return true; }
  } };
  const worker = new ShortsLikeSponsorWorker({ enabled: true, release: { contract: f.contract, network: 'ae_uat' }, policy, payer: f.payer.address }, repository);
  worker.verify = async () => ({ likesEnabled: true, version: '3' });
  worker.contract = { $call: async () => ({ decodedResult: { importing: false, frozen: false, abandoned: false } }) };
  worker.account = { signTransaction: async raw => {
    actions.push('sign'); assert.equal(actions.at(-2), 'reserve'); assert.equal(raw, unsignedOuter);
    return f.payer.signTransaction(raw, { networkId: 'ae_uat' });
  } };
  const top = { height: 100, hash: encoded(Encoding.MicroBlockHash) };
  const stableKey = { height: 100, hash: encoded(Encoding.KeyBlockHash) };
  worker.node = {
    getTopHeader: async () => top, getCurrentKeyBlock: async () => stableKey,
    getAccountByPubkeyAndHash: async (_, hash) => { assert.equal(hash, top.hash); return { kind: 'basic', nonce: 0 }; },
    getAccountByPubkey: async () => ({ kind: 'basic', nonce: 3, balance: 1000000000000000000n }),
    protectedDryRunTxs: async request => { assert.equal(request.top, top.hash); return { results: [{ result: 'ok', callObj: {
      returnType: 'ok', callerId: f.actor.address, callerNonce: 1, contractId: f.contract,
    } }] }; },
    getStatus: async () => ({ networkId: 'ae_uat' }), getTransactionByHash: async () => { throw { statusCode: 404 }; },
    postTransaction: async ({ tx }) => { assert.equal(tx, job.raw_outer); broadcast++; return { txHash: buildTxHash(tx) }; },
  };
  const run = async () => { const attempt = new PublisherAttempt(new AbortController().signal, 5000);
    try { return await attempt.run(() => worker.process(attempt)); } finally { attempt.close(); } };
  admissionPaused = true;
  await assert.rejects(run(), /Admission paused/);
  assert.equal(actions.includes('sign'), false); assert.equal(broadcast, 0);
  admissionPaused = false; actions.length = 0;
  await assert.rejects(run(), /Lost persistence acknowledgement/);
  assert.deepEqual(actions, ['claim', 'reserve', 'sign', 'persist', 'release']); assert.equal(broadcast, 0);
  persistFails = false; actions.length = 0;
  await run();
  assert.deepEqual(actions, ['claim', 'authorize', 'release']); assert.equal(broadcast, 1);
});

test('new sponsorship reserves budget before signing and terminally rejects an unaffordable outer envelope', async t => {
  for (const tightBudget of [false, true]) await t.test(tightBudget ? 'combined-cost limit rejects before reserve' : 'new envelope reserve precedes sign', async () => {
    const f = await fixture(), actions = [];
    const selectedPolicy = tightBudget ? likeSponsorshipPolicy({ ...policy, maxTransactionCost: '1100001000000000' }) : policy;
    const raw = tightBudget ? await f.sign(buildTx({ ...unpackTx(f.unsigned), fee: policy.maxFee })) : f.inner;
    let job = { inner_hash: buildTxHash(raw), actor: f.actor.address, video_id: 'video-id', raw_inner: raw,
      intent: { nonce: 1, ttl: 110, version: '3' }, lease_token: '00000000-0000-4000-8000-000000000000', fence: '1', raw_outer: null };
    const repository = { call: async (action, data) => {
      if (action === 'anchor') return { version: 0, job: null, quarantined: false }; actions.push(action);
      if (action === 'claim') return job;
      if (action === 'reserve') { job = { ...job, prepared_outer: data.unsignedOuter, prepared_nonce: data.nonce, prepared_cost: data.cost }; return job; }
      if (action === 'persist') { assert.equal(data.unsignedOuter, job.prepared_outer); throw new Error('Stop after persistence request'); }
    } };
    const worker = new ShortsLikeSponsorWorker({ enabled: true, release: { contract: f.contract, network: 'ae_uat' }, policy: selectedPolicy, payer: f.payer.address }, repository);
    worker.verify = async () => ({ likesEnabled: true, version: '3' });
    worker.contract = { $call: async () => ({ decodedResult: { importing: false, frozen: false, abandoned: false } }) };
    worker.account = { signTransaction: async unsigned => { actions.push('sign'); assert.equal(unsigned, job.prepared_outer); assert.equal(actions.at(-2), 'reserve'); return f.payer.signTransaction(unsigned, { networkId: 'ae_uat' }); } };
    const top = { height: 100, hash: encoded(Encoding.MicroBlockHash) };
    worker.node = {
      getTopHeader: async () => top, getAccountByPubkeyAndHash: async () => ({ kind: 'basic', nonce: 0 }),
      getAccountByPubkey: async () => ({ kind: 'basic', nonce: 3, balance: 1000000000000000000n }),
      getRecentGasPrices: async () => [{ minGasPrice: 1000000000n, utilization: 0 }],
      protectedDryRunTxs: async () => ({ results: [{ result: 'ok', callObj: { returnType: 'ok', callerId: f.actor.address, callerNonce: 1, contractId: f.contract } }] }),
      postTransaction: () => assert.fail('No broadcast before persistence'),
    };
    const attempt = new PublisherAttempt(new AbortController().signal, 5000);
    try {
      if (tightBudget) { await attempt.run(() => worker.process(attempt)); assert.deepEqual(actions, ['claim', 'reject']); }
      else { await assert.rejects(attempt.run(() => worker.process(attempt)), /Stop after persistence request/); assert.deepEqual(actions, ['claim', 'reserve', 'sign', 'persist', 'release']); }
    } finally { attempt.close(); }
  });
});

test('explicit orphan recovery requires stable canonical absence and the exact next payer nonce', async t => {
  for (const scenario of ['unknown-next', 'orphan-next', 'orphan-normal', 'nonce-gap', 'consumed-nonce', 'moving-head', 'node-outage']) {
    await t.test(scenario, async () => {
      const f = await fixture(), actions = [], identity = sponsoredLikeTransaction(f.outer, f.inner, f.expected);
      const job = { inner_hash: identity.innerHash, outer_hash: identity.outerHash, raw_inner: f.inner, raw_outer: f.outer,
        actor: f.actor.address, video_id: 'video-id', intent: { nonce: 1, ttl: 110, version: '3' }, payer_nonce: 4,
        reserved_cost: identity.cost, lease_token: '00000000-0000-4000-8000-000000000000', fence: '1', settlement_history: [] };
      const recovery = scenario !== 'orphan-normal';
      const worker = new ShortsLikeSponsorWorker({ enabled: !recovery, recovery, release: { contract: f.contract, network: 'ae_uat' }, policy, payer: f.payer.address }, {
        call: async (action, data) => { actions.push(action);
          if (action === 'anchor') return { version: 0, job: null, quarantined: recovery };
          if (action === 'claim' || action === 'claim_recovery') return job;
          if (action === 'authorize') { assert.equal(data.recovery, recovery); return true; }
        },
      });
      worker.verify = async () => ({ likesEnabled: true, version: '3' });
      worker.account = { signTransaction: () => assert.fail('Signed recovery cannot create signatures') };
      const head = { hash: encoded(Encoding.KeyBlockHash), height: 100 }, orphan = encoded(Encoding.MicroBlockHash);
      let headReads = 0, broadcasts = 0;
      worker.node = {
        getStatus: async () => ({ networkId: 'ae_uat' }),
        getCurrentKeyBlock: async () => { headReads++; return scenario === 'moving-head' && headReads > 2 ? { ...head, hash: encoded(Encoding.KeyBlockHash) } : head; },
        getAccountByPubkey: async () => ({ kind: 'basic', nonce: scenario === 'nonce-gap' ? 2 : scenario === 'consumed-nonce' ? 4 : 3 }),
        getTransactionByHash: async () => {
          if (scenario === 'node-outage') throw new Error('Node unavailable');
          if (scenario.startsWith('orphan')) return { ...nodeEnvelope(f.outer), hash: identity.outerHash, blockHash: orphan, blockHeight: 99 };
          throw { statusCode: 404 };
        },
        getGenerationByHeight: async height => ({ keyBlock: { hash: head.hash, height }, microBlocks: [] }),
        postTransaction: async ({ tx }) => { broadcasts++; assert.equal(tx, f.outer); return { txHash: identity.outerHash }; },
      };
      const attempt = new PublisherAttempt(new AbortController().signal, 5000);
      try {
        if (scenario === 'node-outage') await assert.rejects(attempt.run(() => worker.process(attempt)), /Node unavailable/);
        else await attempt.run(() => worker.process(attempt));
      } finally { attempt.close(); }
      assert.equal(broadcasts, ['unknown-next', 'orphan-next'].includes(scenario) ? 1 : 0);
      assert.equal(actions.includes('expire'), false); assert.equal(actions.includes('reserve'), false);
      assert.equal(actions.includes('persist'), false); assert.equal(actions.at(-1), 'release');
    });
  }
});

test('unavailable settlement evidence blocks work without manufacturing a reorganization', async () => {
  const f = await fixture(), identity = sponsoredLikeTransaction(f.outer, f.inner, f.expected), actions = [];
  const job = { inner_hash: identity.innerHash, outer_hash: identity.outerHash, raw_inner: f.inner, raw_outer: f.outer,
    actor: f.actor.address, contract: f.contract, payer_nonce: 4, reserved_cost: identity.cost,
    status: 'confirmed', block_hash: encoded(Encoding.MicroBlockHash), block_height: 100, result: 'ok' };
  const worker = new ShortsLikeSponsorWorker({ enabled: true, release: { contract: f.contract, network: 'ae_uat' }, policy, payer: f.payer.address }, {
    call: async action => { actions.push(action); if (action === 'anchor') return { version: 1, job, quarantined: false }; },
  });
  worker.node = { getStatus: async () => ({ networkId: 'ae_uat' }),
    getTransactionByHash: async () => { throw { statusCode: 404 }; },
    getGenerationByHeight: async () => { throw new Error('Generation unavailable'); },
  };
  const attempt = new PublisherAttempt(new AbortController().signal, 5000);
  try { await assert.rejects(attempt.run(() => worker.process(attempt)), /Generation unavailable/); }
  finally { attempt.close(); }
  assert.deepEqual(actions, ['anchor']);
});

test('public-testnet gas price is supported within a bounded combined sponsor reservation', async () => {
  const f = await fixture(), livePolicy = likeSponsorshipPolicy({ ...policy,
    gasPrice: '30300000000', maxFee: '10000000000000000', maxTransactionCost: '100000000000000000', rollingCostLimit: '1000000000000000000' });
  const inner = await f.sign(buildTx({ ...unpackTx(f.unsigned), gasPrice: livePolicy.gasPrice, fee: '9000000000000000' }));
  const outer = await f.wrap(inner, { fee: '9000000000000000' });
  assert.equal(sponsoredLikeTransaction(outer, inner, { ...f.expected, policy: livePolicy }).cost, '21030000000000000');
  assert.throws(() => likeSponsorshipPolicy({ ...livePolicy, gasPrice: '100000000001' }));
  assert.throws(() => likeSponsorshipPolicy({ ...livePolicy, maxFee: '10000000000000001' }));
});
