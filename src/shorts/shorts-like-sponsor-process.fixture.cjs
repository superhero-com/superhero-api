// Isolated child for opt-in database tests. Never connects to a chain.
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { AccountMemory, buildTxHash } = require('@aeternity/aepp-sdk');
const { runtimeRequire, runtimeEvidence } = require('./testing/fixture-runtime.cjs');
const { ShortsLikeSponsorshipRepository } = runtimeRequire('../shorts-like-sponsorship-repository.service');
const { ShortsLikeSponsorWorker } = runtimeRequire('../shorts-like-sponsor-worker.service');
const { PublisherAttempt } = runtimeRequire('../shorts-publisher-attempt');

const { signedEnvelope } = require('./testing/sponsor-process.cjs');
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
process.once('message', async input => {
  let db, attempt;
  try {
    if (!['127.0.0.1', 'localhost'].includes(new URL(input.url).hostname)
      || !/^shorts_(?:assembled|like_sponsor)_[a-f0-9]+$/.test(input.schema)) throw new Error('Nonlocal fixture');
    db = await new DataSource({ type: 'postgres', url: input.url, logging: false,
      extra: { options: `-c search_path=${input.schema}`, max: 1, statement_timeout: 10000 } }).initialize();
    const repository = new ShortsLikeSponsorshipRepository(input.config);
    repository.db = db;
    if ((await repository.call('verify')).kind !== 'signer') throw new Error('Wrong fixture role');
    let signatures = 0, broadcasts = 0, broadcastHash;
    const stop = async (stage, values = {}) => {
      if (input.stop !== stage) return;
      await send({ type: 'boundary', stage, pid: process.pid, signatures, broadcasts, ...values });
      // Parent kills this process, so no finally/release path can run.
      await new Promise(() => {});
    };
    const call = repository.call.bind(repository);
    repository.call = async (action, args) => {
      const result = await call(action, args);
      if (['claim', 'reserve', 'persist'].includes(action)) await stop(action);
      return result;
    };
    const worker = new ShortsLikeSponsorWorker(input.config, repository);
    worker.verify = async () => ({ likesEnabled: true, version: '3' });
    worker.contract = { $call: async () => ({ decodedResult: { importing: false, frozen: false, abandoned: false } }) };
    const payer = new AccountMemory(input.payerSecret);
    if (payer.address !== input.config.payer) throw new Error('Wrong fixture key');
    worker.account = { signTransaction: async raw => {
      const signed = await payer.signTransaction(raw, { networkId: 'ae_uat' });
      signatures++;
      await stop('sign', { signedHash: buildTxHash(signed) });
      return signed;
    } };
    const minedHeight = input.minedHeight ?? 98, headHeight = input.headHeight ?? 100;
    const body = input.observedOuter && { hash: buildTxHash(input.observedOuter),
      ...signedEnvelope(input.observedOuter), blockHeight: minedHeight, blockHash: input.microHash };
    worker.node = {
      getStatus: async () => ({ networkId: 'ae_uat' }),
      getTopHeader: async () => ({ height: headHeight, hash: input.microHash }),
      getCurrentKeyBlock: async () => ({ height: headHeight, hash: input.keyHash }),
      getAccountByPubkeyAndHash: async () => ({ kind: 'basic', nonce: 0 }),
      getAccountByPubkey: async () => ({ kind: 'basic', nonce: input.observedOuter ? 1 : 0, balance: 1000000000000000000n }),
      getRecentGasPrices: async () => [{ minGasPrice: 1000000000n, utilization: 0 }],
      protectedDryRunTxs: async () => ({ results: [{ result: 'ok', callObj: { returnType: 'ok', callerId: input.actor,
        callerNonce: 1, contractId: input.config.release.contract } }] }),
      getTransactionByHash: async hash => { if (!body || hash !== body.hash) throw { statusCode: 404 }; return body; },
      getGenerationByHeight: async () => ({ keyBlock: { hash: input.keyHash, height: minedHeight }, microBlocks: [input.microHash] }),
      getTransactionInfoByHash: async () => ({ callInfo: { callerId: input.actor, callerNonce: 1,
        contractId: input.config.release.contract, height: minedHeight, returnType: 'ok' } }),
      postTransaction: async ({ tx }) => {
        broadcasts++;
        broadcastHash = buildTxHash(tx);
        await stop('broadcast', { broadcastHash });
        return { txHash: buildTxHash(tx) };
      },
    };
    attempt = new PublisherAttempt(new AbortController().signal, 10000);
    await attempt.run(() => worker.process(attempt));
    await send({ type: 'done', pid: process.pid, signatures, broadcasts, broadcastHash, runtime: runtimeEvidence().mode });
  } catch (error) {
    // Never serialize a DB/SDK error or its parameters: it may contain signed bytes.
    await send({ type: 'error', name: error?.name || 'Error' }).catch(() => {});
    process.exitCode = 1;
  } finally {
    attempt?.close();
    if (db?.isInitialized) await db.destroy();
    if (process.connected) process.disconnect();
  }
});
