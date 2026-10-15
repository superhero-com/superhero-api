require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const { AccountMemory, buildTx, buildTxHash, decode, encode, Encoding, Tag, unpackTx } = require('@aeternity/aepp-sdk');
const { AciContractCallEncoder } = require('@aeternity/aepp-calldata');
const { ShortsWalletTransactionsService } = require('./shorts-wallet-transactions.service');
const { ShortsNodeAccessService } = require('./shorts-node-access.service');
const { ShortsController } = require('./shorts.controller');
const { SHORTS_HTTP_POLICY, SHORTS_RATE_GROUPS } = require('./shorts-rate-policy');
const { Test } = require('@nestjs/testing');
const { Module } = require('@nestjs/common');
const { ShortsChainService } = require('./shorts-chain.service');
const encoded = kind => encode(randomBytes(32), kind);
const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [
  ...['paid_like','withdraw','other'].map(name => ({ name, arguments: [{ name: 'id', type: 'string' }], returns: {tuple:[]}, payable: true, stateful: true })),
  { name: 'claim', arguments: [], returns: {tuple:[]}, payable: false, stateful: true },
] } }];
const coder = new AciContractCallEncoder(aci);
async function fixture(method = 'paid_like', options = {}) {
  const account = AccountMemory.generate(), current = encoded(Encoding.ContractAddress), previous = encoded(Encoding.ContractAddress);
  const contract = options.previous ? previous : current;
  const unsigned = buildTx({ tag: Tag.ContractCallTx, callerId: account.address, contractId: contract,
    abiVersion: 3, amount: method === 'paid_like' ? '100000000000000000' : 0,
    callData: coder.encodeCall('Shorts', method, method === 'claim' ? [] : ['video-id']),
    nonce: 7, ttl: options.ttl ?? 200, gasLimit: 100000, gasPrice: 1000000000, fee: '1000000000000000' });
  const network = options.network ?? 'ae_uat';
  const networkId = options.signatureNetwork ?? network;
  const raw = options.rawSignature
    ? buildTx({ tag: Tag.SignedTx, encodedTx: unsigned, signatures: [
      await account.unsafeSign(Buffer.concat([Buffer.from(networkId), decode(unsigned)])),
    ] })
    : await account.signTransaction(unsigned, { networkId });
  const signed = unpackTx(raw), call = signed.encodedTx, tx = buildTxHash(raw);
  const body = { hash: tx, signatures: signed.signatures.map(sig => encode(sig, Encoding.Signature)),
    blockHeight: 98, blockHash: encoded(Encoding.MicroBlockHash),
    tx: { ...call, type: 'ContractCallTx', gas: call.gasLimit } };
  const tip = { hash: encoded(Encoding.KeyBlockHash), height: 100 };
  const generation = { keyBlock: { hash: encoded(Encoding.KeyBlockHash), height: 98 }, microBlocks: [body.blockHash] };
  const info = { callInfo: { callerId: account.address, callerNonce: 7, contractId: contract, height: 98, returnType: 'ok' } };
  let reads = 0;
  const api = { getStatus: async () => ({ networkId: network }), getTransactionByHash: async () => body,
    getCurrentKeyBlock: async () => tip, getGenerationByHeight: async () => generation, getTransactionInfoByHash: async () => info,
    postTransaction: () => assert.fail('Observation must never broadcast') };
  const access = new ShortsNodeAccessService();
  const chain = { release: { network, contract: current, previousContract: previous }, sdk: { api }, state: { contract: current }, previous: { $options: { address: previous } },
    readNode: async op => { reads++; return access.read(op); }, save: () => assert.fail('Observation must not alter state'),
    recordTransaction: () => assert.fail('Observation must not record receipts') };
  const service = new ShortsWalletTransactionsService(chain);
  return { service, chain, api, body, info, tip, generation, account, current, previous, contract, tx, raw,
    observe: () => service.observe(tx, account.address, contract), reads: () => reads };
}

test('node responses may omit a signed zero TTL for each wallet action', async () => {
  for (const method of ['paid_like', 'withdraw', 'claim']) {
    const f = await fixture(method, { ttl: 0 });
    delete f.body.tx.ttl;
    assert.equal((await f.observe()).status, 'confirmed');
  }
});

test('omitting a signed nonzero TTL or supplying malformed TTL is rejected', async () => {
  const nonzero = await fixture();
  delete nonzero.body.tx.ttl;
  await assert.rejects(nonzero.observe(), { status: 400 });
  for (const ttl of [null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = await fixture('claim', { ttl: 0 });
    f.body.tx.ttl = ttl;
    await assert.rejects(f.observe(), { status: 400 });
  }
});

test('release network binds modern and legacy signatures for every wallet action', async t => {
  // Unfunded synthetic keys and read-only node fixtures, not enabled mainnet services.
  for (const network of ['ae_uat', 'ae_mainnet']) for (const rawSignature of [false, true]) {
    await t.test(`${network} ${rawSignature ? 'raw' : 'hash'}`, async () => {
      for (const method of ['paid_like', 'withdraw', 'claim']) {
        const options = { network, rawSignature, previous: method === 'claim' };
        const f = await fixture(method, options), result = await f.observe();
        assert.equal(result.network, network); assert.equal(result.status, 'confirmed');
        assert.equal(result.contract, f.contract);
        const other = await fixture(method, { ...options, signatureNetwork: network === 'ae_uat' ? 'ae_mainnet' : 'ae_uat' });
        await assert.rejects(other.observe(), { status: 400 });
      }
    });
  }
});

test('missing or inconsistent release identity refuses to consult the node', async t => {
  for (const change of ['missing', 'network', 'contract', 'previous']) await t.test(change, async () => {
    const f = await fixture();
    if (change === 'missing') delete f.chain.release;
    if (change === 'network') f.chain.release.network = 'unknown';
    if (change === 'contract') f.chain.release.contract = f.previous;
    if (change === 'previous') f.chain.release.previousContract = null;
    f.api.getStatus = () => assert.fail('Invalid binding must fail before any node read');
    await assert.rejects(f.observe(), { status: 503 });
  });
});

test('release or selected-node changes while observing never return a stale result', async t => {
  for (const change of ['release', 'network', 'contract', 'previous', 'node', 'state']) await t.test(change, async () => {
    const f = await fixture();
    const original = f.api.getTransactionByHash;
    f.api.getTransactionByHash = async () => {
      if (change === 'release') f.chain.release = { ...f.chain.release };
      if (change === 'network') f.chain.release.network = 'ae_mainnet';
      if (change === 'contract') f.chain.release.contract = f.previous;
      if (change === 'previous') f.chain.release.previousContract = null;
      if (change === 'node') f.chain.sdk.api = { ...f.api };
      if (change === 'state') f.chain.state.contract = f.previous;
      return original();
    };
    await assert.rejects(f.observe(), { status: 503 });
  });
});

test('a cross-network response cannot turn a node switch into a rejected wallet payment', async () => {
  const f = await fixture('paid_like', { signatureNetwork: 'ae_mainnet' }); let checks = 0;
  f.api.getStatus = async () => ({ networkId: ++checks === 1 ? 'ae_uat' : 'ae_mainnet' });
  await assert.rejects(f.observe(), { status: 503 });
});

test('a live node changing network fails even for unknown and pending transactions', async t => {
  for (const status of ['unknown', 'pending', 'confirmed']) await t.test(status, async () => {
    const f = await fixture(); let checks = 0;
    f.api.getStatus = async () => ({ networkId: ++checks === 1 ? 'ae_uat' : 'ae_mainnet' });
    if (status === 'unknown') f.api.getTransactionByHash = async () => { throw { statusCode: 404 }; };
    if (status === 'pending') { f.body.blockHeight = -1; f.body.blockHash = 'none'; }
    await assert.rejects(f.observe(), { status: 503 });
  });
});

test('observes submitted, mined and three-confirmation success without mutating or exposing signed bytes', async () => {
  const f = await fixture();
  const confirmed = await f.observe();
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.confirmations, 3);
  assert.equal(confirmed.method, 'paid_like'); assert.equal(confirmed.videoId, 'video-id');
  assert.equal(confirmed.amount, '100000000000000000'); assert.equal(confirmed.nonce, 7);
  assert.equal(JSON.stringify(confirmed).includes(f.raw), false);
  assert.equal('signatures' in confirmed, false); assert.equal('rawTx' in confirmed, false);
  f.tip.height = 98; assert.equal((await f.observe()).status, 'mined');
  f.body.blockHeight = -1; f.body.blockHash = 'none';
  f.api.getTransactionInfoByHash = () => assert.fail('Pending transaction has no execution receipt');
  assert.equal((await f.observe()).status, 'submitted'); assert.equal(f.reads(), 3);
});

test('supports SDK legacy raw-byte signatures while retaining network and payload binding', async t => {
  for (const signatureNetwork of ['ae_uat', 'ae_mainnet', 'ae_uat-inner_tx', '']) {
    await t.test(signatureNetwork || 'missing network', async () => {
      const f = await fixture('paid_like', { rawSignature: true, signatureNetwork });
      if (signatureNetwork === 'ae_uat') {
        assert.equal((await f.observe()).status, 'confirmed');
        f.body.tx.amount = 1n;
        await assert.rejects(f.observe(), { status: 400 });
      } else await assert.rejects(f.observe(), { status: 400 });
    });
  }
});

test('a missing transaction stays unknown and node outages are not converted to rejection', async () => {
  const f = await fixture();
  f.api.getTransactionByHash = async () => { throw { statusCode: 404 }; };
  assert.equal((await f.observe()).status, 'unknown');
  for (const statusCode of [401, 403, 429, 500]) {
    f.api.getTransactionByHash = async () => { throw { statusCode }; };
    await assert.rejects(f.observe(), { statusCode });
  }
  f.api.getStatus = async () => ({ networkId: 'ae_mainnet' });
  await assert.rejects(f.observe(), { status: 503 });
});

test('contract reverts and execution errors meet the observed confirmation threshold before reporting failure', async t => {
  for (const returnType of ['revert', 'error']) await t.test(returnType, async () => {
    const f = await fixture('claim'); f.info.callInfo.returnType = returnType;
    assert.equal((await f.observe()).status, 'failed');
    f.tip.height = 98; const result = await f.observe();
    assert.equal(result.status, 'mined'); assert.equal(result.result, returnType);
  });
});

test('canonical block removal is reorged and changing confirmation snapshots are never confirmed', async t => {
  const f = await fixture(); f.generation.microBlocks = [];
  assert.equal((await f.observe()).status, 'reorged');
  for (const change of ['tip', 'generation', 'membership']) await t.test(change, async () => {
    const g = await fixture(); let tips = 0, generations = 0;
    g.api.getCurrentKeyBlock = async () => (++tips === 2 && change === 'tip' ? { ...g.tip, hash: encoded(Encoding.KeyBlockHash) } : g.tip);
    g.api.getGenerationByHeight = async () => {
      generations++;
      if (generations < 2) return g.generation;
      if (change === 'membership') return { ...g.generation, microBlocks: [] };
      if (change === 'generation') return { ...g.generation, keyBlock: { ...g.generation.keyBlock, hash: encoded(Encoding.KeyBlockHash) } };
      return g.generation;
    };
    await assert.rejects(g.observe(), { status: 503 });
  });
});

test('caller, contract, payload, signature and network are cryptographically bound to the requested hash', async t => {
  for (const change of ['amount','caller','calldata','signature','hash']) await t.test(change, async () => {
    const f = await fixture();
    if (change === 'amount') f.body.tx.amount = 1n;
    if (change === 'caller') f.body.tx.callerId = AccountMemory.generate().address;
    if (change === 'calldata') f.body.tx.callData = coder.encodeCall('Shorts', 'withdraw', ['video-id']);
    if (change === 'signature') f.body.signatures = [encode(randomBytes(64), Encoding.Signature)];
    if (change === 'hash') f.body.hash = encoded(Encoding.TxHash);
    await assert.rejects(f.observe(), { status: 400 });
  });
  const wrongNetwork = await fixture('paid_like', { signatureNetwork: 'ae_mainnet' });
  await assert.rejects(wrongNetwork.observe(), { status: 400 });
});

test('only configured contracts and supported wallet methods can be inspected', async () => {
  for (const method of ['claim','withdraw']) assert.equal((await (await fixture(method)).observe()).method, method);
  assert.equal((await (await fixture('claim', { previous: true })).observe()).status, 'confirmed');
  await assert.rejects((await fixture('paid_like', { previous: true })).observe(), { status: 400 });
  await assert.rejects((await fixture('other')).observe(), { status: 400 });
  const f = await fixture();
  for (const args of [['bad', f.account.address, f.contract], [f.tx, 'bad', f.contract], [f.tx, f.account.address, encoded(Encoding.ContractAddress)]]) {
    await assert.rejects(f.service.observe(...args), { status: 400 });
  }
  assert.equal(f.reads(), 0, 'invalid scope must be rejected before node work');
});

test('execution receipt mismatches and inconsistent heights cannot complete a wallet action', async t => {
  for (const change of [{ callerNonce: 8 }, { callerId: AccountMemory.generate().address }, { contractId: encoded(Encoding.ContractAddress) }, { height: 99 }, { returnType: 'invalid' }]) {
    const f = await fixture(); Object.assign(f.info.callInfo, change);
    await assert.rejects(f.observe(), { status: 503 });
  }
  const f = await fixture(); f.tip.height = 97;
  await assert.rejects(f.observe(), { status: 503 });
  const malformed = await fixture(); malformed.api.getGenerationByHeight = async () => ({});
  await assert.rejects(malformed.observe(), { status: 503 });
  await t.test('shutdown cancels the whole observation', async () => {
    const g = await fixture(), access = new ShortsNodeAccessService(); await access.onModuleDestroy();
    g.chain.readNode = op => access.read(op);
    await assert.rejects(g.observe(), { status: 503 });
  });
});

for (const rawSignature of [false, true]) test(`actual SDK HTTP decoding preserves signed amounts, gas and canonical execution (${rawSignature ? 'raw' : 'hash'} signature); upstream failures stay unresolved`, async t => {
  const f = await fixture('paid_like', { rawSignature }), requests = [], access = new ShortsNodeAccessService();
  const call = f.body.tx;
  const wireTx = { hash: f.tx, block_hash: f.body.blockHash, block_height: f.body.blockHeight, signatures: f.body.signatures,
    tx: { type: 'ContractCallTx', version: 1, abi_version: 3, caller_id: call.callerId, contract_id: call.contractId,
      nonce: call.nonce, ttl: call.ttl, amount: call.amount.toString(), fee: call.fee.toString(), gas: call.gas,
      gas_price: call.gasPrice.toString(), call_data: call.callData } };
  const keyBlock = { hash: f.tip.hash, height: 100 };
  const generation = { key_block: { hash: f.generation.keyBlock.hash, height: 98 }, micro_blocks: [f.body.blockHash] };
  const info = { call_info: { caller_id: f.account.address, caller_nonce: 7, contract_id: f.contract, height: 98,
    gas_price: '1000000000', gas_used: 5000, log: [], return_value: encode(Buffer.from([0]), Encoding.ContractBytearray), return_type: 'ok' } };
  let status = 200;
  const server = createServer((req, res) => {
    requests.push(req.method + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    const path = new URL(req.url, 'http://localhost').pathname;
    let body;
    if (path === '/v3/status') body = { node_version: '7.2.0', network_id: 'ae_uat' };
    else if (path === '/v3/transactions/' + f.tx) { body = status === 200 ? wireTx : { reason: 'fixture unavailable' }; res.statusCode = status; }
    else if (path === '/v3/key-blocks/current') body = keyBlock;
    else if (path === '/v3/generations/height/98') body = generation;
    else if (path === '/v3/transactions/' + f.tx + '/info') body = info;
    else { res.statusCode = 500; body = { reason: 'Unexpected fixture request' }; }
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { access.onModuleDestroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  f.chain.sdk.api = access.createNode(`http://127.0.0.1:${server.address().port}`);
  f.chain.readNode = op => access.read(op);
  const result = await f.observe();
  assert.equal(result.status, 'confirmed'); assert.equal(result.amount, '100000000000000000');
  assert.equal(result.blockHash, f.body.blockHash); assert.equal(result.nonce, 7);
  status = 404; assert.equal((await f.observe()).status, 'unknown');
  status = 503; await assert.rejects(f.observe());
  assert.ok(requests.every(request => request.startsWith('GET ')), 'No HTTP path may submit a transaction');
});

test('Nest resolves the read-only observer and exposes a no-store public endpoint with bounded admission', async () => {
  const f = await fixture();
  class Boundary {} Module({ providers: [ShortsWalletTransactionsService, { provide: ShortsChainService, useValue: f.chain }] })(Boundary);
  const module = await Test.createTestingModule({ imports: [Boundary] }).compile();
  try {
    const observer = module.get(ShortsWalletTransactionsService);
    const controller = new ShortsController({}, { authenticate: () => assert.fail('Public chain status needs no ownership signature') }, {}, undefined, observer);
    assert.equal((await controller.walletTransaction(f.tx, f.account.address, f.contract)).status, 'confirmed');
    assert.equal(Reflect.getMetadata('path', ShortsController.prototype.walletTransaction), 'wallet-transactions/:tx');
    assert.deepEqual(Reflect.getMetadata('__headers__', ShortsController.prototype.walletTransaction), [{ name: 'Cache-Control', value: 'no-store' }]);
    assert.deepEqual(SHORTS_HTTP_POLICY.walletTransaction, { group: 'transactionStatus' });
    assert.equal(SHORTS_RATE_GROUPS.transactionStatus[2], 120);
    await assert.rejects(async () => new ShortsController({}, {}, {}).walletTransaction(f.tx, f.account.address, f.contract), { status: 503 });
  } finally { await module.close(); }
});
