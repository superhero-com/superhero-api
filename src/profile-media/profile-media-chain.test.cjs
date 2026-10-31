const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ProfileMediaChain } = require('./profile-media-chain.service');
const { imageReference, profileImageReference, parseImageReference, profileImageCid } = require('./image-reference');

test('profile signatures use underscore references supported by the deployed identity contract', () => {
  const cid = `bafy${'a'.repeat(55)}`;
  const chain = new ProfileMediaChain({ enabled: false });
  assert.equal(chain.message('ak_owner', 'avatar', 7, cid), `link:ak_owner:avatar:ipfs_superhero_images_${cid}:7`);
  assert.equal(chain.message('ak_owner', 'cover', 7, cid), `link:ak_owner:cover:ipfs_superhero_images_${cid}:7`);
  assert.equal(chain.message('ak_owner', 'avatar', 7, null), 'unlink:ak_owner:avatar:7');
  assert.equal(profileImageCid(cid), cid);
  assert.equal(profileImageCid(profileImageReference(cid)), cid);
  assert.equal(profileImageCid(profileImageReference(cid) + '-preview'), undefined);
  assert.equal(profileImageCid(imageReference(cid)), cid);
  assert.equal(profileImageCid(imageReference(cid, true)), undefined);
  assert.deepEqual(parseImageReference(imageReference(cid, true)), { cid, preview: true });
  for (const suffix of ['/../other', '?x=1', '-preview/extra', '#fragment'])
    for (const format of [imageReference(cid), profileImageReference(cid)]) {
      assert.equal(parseImageReference(format + suffix), undefined);
      assert.equal(profileImageCid(format + suffix), undefined);
    }
});

function chainWith(blockHeight, receipt) {
  const chain = new ProfileMediaChain({ enabled: false });
  chain.node = {
    getTransactionByHash: async () => ({ blockHeight }),
    getTransactionInfoByHash: async () => receipt,
    getCurrentKeyBlockHeight: async () => { throw new Error('Must not wait for extra blocks'); },
  };
  return chain;
}

test('a successful mined image change completes without any additional key blocks', async () => {
  const chain = chainWith(123, { callInfo: { returnType: 'ok' } });
  assert.equal(await chain.transaction('th_test'), 'confirmed');
});

test('an unmined image transaction stays pending without reading a receipt', async () => {
  const chain = chainWith(-1);
  chain.node.getTransactionInfoByHash = async () => { throw new Error('Not mined'); };
  assert.equal(await chain.transaction('th_test'), 'pending');
});

test('a mined transaction waits for its execution receipt and fails on a reverted call', async () => {
  assert.equal(await chainWith(123, {}).transaction('th_test'), 'pending');
  for (const returnType of ['revert', 'error']) {
    assert.equal(await chainWith(123, { callInfo: { returnType } }).transaction('th_test'), 'failed');
  }
});

test('a missing transaction is recoverable and node errors never become success', async () => {
  const chain = chainWith(123, {});
  chain.node.getTransactionByHash = async () => { throw { statusCode: 404 }; };
  assert.equal(await chain.transaction('th_test'), 'missing');
  chain.node.getTransactionByHash = async () => { throw new Error('Offline'); };
  await assert.rejects(chain.transaction('th_test'), /Unable to check/);
});
