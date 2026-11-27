// Only the external node is simulated. The operator signs the actual publish
// calldata and the publisher login uses the same fenced journal as production.
const assert = require('node:assert/strict');
const { buildTx, buildTxHash, Tag } = require('@aeternity/aepp-sdk');
const { publicationCalldata } = require('../shorts-publication-transaction');
const { ShortsPublisherService } = require('../shorts-publisher.service');
const { ShortsPublicationBoundaryService } = require('../shorts-publication-boundary.service');
const { observePublication } = require('../shorts-publication-observation');

exports.publishFixture = async ({ signerDb, deployment, operator, state, save, published, record }) => {
  const { scope } = deployment;
  const calldata = publicationCalldata(record);
  let submitted;
  const node = {
    getStatus: async () => ({ networkId: scope.network }),
    getCurrentKeyBlock: async () => ({ height: state.height, hash: state.keyHash }),
    getGenerationByHeight: async height => ({
      keyBlock: { hash: state.keyHash, height }, microBlocks: [published.block_hash],
    }),
    getTransactionByHash: async hash => {
      if (!submitted) throw Object.assign(new Error('Absent'), { statusCode: 404 });
      assert.equal(hash, buildTxHash(submitted));
      return { hash, blockHeight: published.block_height, blockHash: published.block_hash,
        tx: { type: 'ContractCallTx', callerId: operator.address, contractId: scope.contract,
          nonce: 1, amount: 0n, callData: calldata } };
    },
    getTransactionInfoByHash: async () => ({ callInfo: { callerId: operator.address, contractId: scope.contract,
      callerNonce: 1, height: published.block_height, returnType: 'ok' } }),
    getMicroBlockTransactionsByHash: async () => ({ transactions: [{ hash: buildTxHash(submitted) }] }),
  };
  const boundary = new ShortsPublicationBoundaryService(signerDb);
  const publisher = new ShortsPublisherService(deployment, boundary, {
    verify: async () => {}, existing: async intent => state.shorts[intent.id],
    prepare: async intent => {
      assert.equal(publicationCalldata(intent), calldata);
      const tx = buildTx({ tag: Tag.ContractCallTx, callerId: operator.address, contractId: scope.contract,
        abiVersion: 3, amount: 0, callData: calldata, nonce: 1, ttl: state.height + 10,
        gasLimit: 100000, gasPrice: 1000000000, fee: '1000000000000000' });
      return { rawTransaction: await operator.signTransaction(tx, { networkId: scope.network }),
        accountNonce: 0, height: state.height };
    },
    observe: claim => observePublication(node, { ...scope, operator: operator.address,
      transactionHash: claim.transactionHash, intent: claim.intent, nonce: claim.nonce }, deployment.policy.confirmations),
    canBroadcast: async () => true,
    broadcast: async (raw, hash) => {
      assert.equal(submitted, undefined);
      assert.equal(buildTxHash(raw), hash);
      submitted = raw;
      published.hash = hash;
      state.microBlocks = { [published.block_height]: [published.block_hash] };
      state.shorts[record.id] = { creator: record.creator, cid: record.cid, size: record.bytes, likes: 0, withdrawn: false, likers: [] };
      state.height = published.block_height + deployment.policy.confirmations;
      await save();
    },
  });
  await publisher.tick();
  assert.ok(submitted, 'Publisher must submit the journaled call');
  await publisher.tick();
};
