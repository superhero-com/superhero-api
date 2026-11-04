const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { AeSdk, AccountMemory, Node, CompilerHttp, Contract } = require('@aeternity/aepp-sdk');

// Use only a disposable ae_dev node and newly generated, genesis-funded fixture accounts.
// This proves SDK/node snapshot semantics; the hosted reconciler still requires ae_uat.
test('real devnet fixed key-block state excludes its own generation and stays unchanged after claims', {
  skip: !process.env.SHORTS_TEST_DEVNET_URL, timeout: 180000,
}, async () => {
  const local = value => { const url = new URL(value); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); return url.href; };
  const base = local(process.env.SHORTS_TEST_DEVNET_URL), compilerUrl = local(process.env.SHORTS_TEST_COMPILER_URL);
  const node = new Node(base);
  assert.equal((await node.getStatus()).networkId, 'ae_dev', 'Never submit these fixture calls to testnet or mainnet');
  const [operator, creator, viewer, treasury] = JSON.parse(readFileSync(process.env.SHORTS_TEST_DEVNET_WALLETS)).map(w => new AccountMemory(w.secretKey));
  const sdk = new AeSdk({ accounts: [operator, creator, viewer, treasury], nodes: [{ name: 'disposable', instance: node }], onCompiler: new CompilerHttp(compilerUrl), interval: 100 });
  const sourceCode = readFileSync(process.env.SHORTS_TEST_CONTRACT_SOURCE, 'utf8');
  const contract = await Contract.initialize({ ...sdk.getContext(), sourceCode });
  const fee = 100000000000000003n, treasuryShare = fee * 2000n / 10000n;
  const emit = async () => { const r = await fetch(new URL('emit_kb?n=1', base)); assert.equal(r.ok, true); };
  const read = async (method, args, top) => (await contract.$call(method, args, { callStatic: true, top })).decodedResult;
  await contract.$deploy([treasury.address, fee, 2000, undefined]);
  await contract.$call('publish', ['snapshot-short', creator.address, 'fixture-cid', 100]);
  await emit();
  const liked = await contract.$call('paid_like', ['snapshot-short'], { onAccount: viewer, amount: fee });
  const likeTx = await node.getTransactionByHash(liked.hash);
  assert.ok(likeTx.blockHeight > 0); await emit();
  const before = await node.getKeyBlockByHeight(likeTx.blockHeight), after = await node.getKeyBlockByHeight(likeTx.blockHeight + 1);
  assert.deepEqual(await read('get_liabilities', [], before.hash), [0n, 0n]);
  assert.deepEqual(await read('get_liabilities', [], after.hash), [fee, fee]);
  const expected = { available: fee - treasuryShare, earned: fee - treasuryShare, claimed: 0n };
  assert.deepEqual(await read('get_account', [creator.address], after.hash), expected);
  assert.deepEqual(await read('get_account', [treasury.address], after.hash), { available: treasuryShare, earned: treasuryShare, claimed: 0n });
  const config = await read('get_config', [], after.hash);
  assert.equal(config[1], treasury.address); assert.equal(config[2], fee); assert.equal(config[3], 2000n);
  const claimed = await contract.$call('claim', [], { onAccount: creator });
  const claimTx = await node.getTransactionByHash(claimed.hash); await emit();
  const afterClaim = await node.getKeyBlockByHeight(claimTx.blockHeight + 1);
  assert.deepEqual(await read('get_liabilities', [], afterClaim.hash), [treasuryShare, treasuryShare]);
  assert.deepEqual(await read('get_account', [creator.address], afterClaim.hash), { earned: expected.earned, claimed: expected.earned, available: 0n });
  assert.deepEqual(await read('get_account', [creator.address], after.hash), expected, 'later claims cannot alter an earlier fixed-hash read');
  assert.deepEqual(await read('get_liabilities', [], after.hash), [fee, fee]);
});
