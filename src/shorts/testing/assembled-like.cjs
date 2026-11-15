// Real wallet and payer signatures, API admission and restricted signer journal.
// Only external node and middleware responses are controlled by the fixture.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { AccountMemory, buildTx, buildTxHash, encode, Encoding, Tag } = require('@aeternity/aepp-sdk');
const { toMdwTx } = require('../../mdw-sync/utils/to-mdw-tx');
const { ShortsLikeSponsorSetupService } = require('../shorts-like-sponsor-setup.service');
const { runSponsor, signedEnvelope } = require('./sponsor-process.cjs');

exports.enrollSponsor = async ({ owner, admin, url, schema, roles, deployment }) => {
  const payer = AccountMemory.generate();
  const policy = { gasLimit: 100000, gasPrice: '1000000000', maxFee: '1000000000000000',
    maxTransactionCost: '3000000000000000', rollingCostLimit: '30000000000000000',
    maxPending: 10, maxActorPerDay: 20, maxRequestsPerDay: 100, ttlBlocks: 20 };
  const config = { ...deployment, payer: payer.address, policy, enabled: false };
  const credentials = Object.fromEntries(['api','signer'].map(kind => [kind, {
    role: 'shlike_' + randomUUID().replaceAll('-', ''), password: randomBytes(32).toString('base64url'),
  }]));
  await new ShortsLikeSponsorSetupService(owner).enroll(config, credentials);
  const endpoints = {};
  for (const [kind, { role, password }] of Object.entries(credentials)) {
    roles.push({ async dispose() { await admin.query('DROP OWNED BY ' + role); await admin.query('DROP ROLE ' + role); } });
    const endpoint = new URL(url); endpoint.username = role; endpoint.password = password;
    await admin.query('ALTER ROLE ' + role + ' SET search_path TO ' + schema);
    endpoints[kind] = endpoint.href;
  }
  await owner.query('UPDATE shorts_like_sponsor_accounts SET paused=false WHERE network=$1 AND payer=$2', [config.release.network, config.payer]);
  return { policyFile: { payer: payer.address, ...policy }, apiUrl: endpoints.api,
    signer: { schema, config: { ...config, enabled: true }, payerSecret: payer.secretKey, url: endpoints.signer } };
};

exports.submitFreeLike = async (f, state, save, codec, log) => {
  const { b, c, owner, scope, id, request, sponsor } = f;
  const viewer = AccountMemory.generate(), version = '3';
  const callData = codec.encodeCall('Shorts', 'like', [id, version]);
  const signLike = nonce => viewer.signTransaction(buildTx({ tag: Tag.ContractCallTx, callerId: viewer.address,
    contractId: scope.contract, abiVersion: 3, amount: 0, nonce, ttl: 110, gasLimit: sponsor.policyFile.gasLimit,
    gasPrice: sponsor.policyFile.gasPrice, fee: '300000000000000', callData }), { networkId: scope.network, innerTx: true });
  const signedInnerTx = await signLike(1);
  const innerHash = buildTxHash(signedInnerTx), body = { id: randomUUID(), videoId: id, signedInnerTx };
  const statusUrl = '/like-sponsorships/' + innerHash + '?address=' + viewer.address + '&contract=' + scope.contract;
  const post = async api => {
    const result = await request(api, '/like-sponsorships', body);
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.tx, innerHash); return result.body;
  };
  for (const api of [b, c]) assert.equal((await post(api)).sponsorshipStatus, 'queued');
  const blockHash = encode(randomBytes(32), Encoding.MicroBlockHash);
  const signer = { ...sponsor.signer, actor: viewer.address, microHash: blockHash, keyHash: state.keyHash, minedHeight: state.height + 1, headHeight: state.height };
  const submitted = await runSponsor(signer);
  assert.equal(submitted.runtime, process.env.SHORTS_TEST_COMPILED === '1' ? 'compiled' : 'typescript');
  assert.equal(submitted.signatures, 1); assert.equal(submitted.broadcasts, 1);
  const [job] = await owner.query('SELECT raw_outer, outer_hash, broadcast_attempts FROM shorts_like_sponsorship_jobs WHERE inner_hash=$1', [innerHash]);
  assert.equal(job.outer_hash, submitted.broadcastHash); assert.equal(buildTxHash(job.raw_outer), submitted.broadcastHash);
  assert.equal(job.broadcast_attempts, 1);
  const envelope = signedEnvelope(job.raw_outer);
  const inner = envelope.tx.tx.tx;
  assert.equal(inner.callerId, viewer.address); assert.equal(inner.callData, callData); assert.equal(String(inner.amount), '0');
  assert.equal(inner.contractId, scope.contract); assert.equal(envelope.tx.payerId, sponsor.policyFile.payer);
  const { args } = codec.decodeCall('Shorts', 'like', inner.callData);
  const [videoId, configVersion] = args;
  assert.equal(videoId, id); assert.equal(String(configVersion), version);
  const executed = { ...envelope, hash: submitted.broadcastHash, blockHash, blockHeight: signer.minedHeight };
  state.transaction = executed;
  state.callInfo = { callerId: inner.callerId, callerNonce: inner.nonce, contractId: inner.contractId, height: signer.minedHeight, returnType: 'ok' };
  state.height = signer.minedHeight; state.microBlocks[state.height] = [blockHash];
  const video = state.shorts[videoId];
  assert.equal(video.likers.includes(inner.callerId), false); video.likers.push(inner.callerId); video.likes++;
  await save();
  const mined = await request(c, statusUrl);
  assert.equal(mined.status, 200, JSON.stringify(mined.body));
  assert.equal(mined.body.status, 'mined'); assert.equal(mined.body.confirmations, 1); assert.equal(mined.body.result, 'ok');
  assert.equal(mined.body.sponsoredTx, submitted.broadcastHash); assert.equal(mined.body.address, viewer.address);
  // Feed the actual submitted envelope, enriched only with middleware execution metadata, into the ordinary mapper.
  const row = toMdwTx({ ...executed, microIndex: 0, microTime: Date.now(),
    tx: { ...envelope.tx, tx: { ...envelope.tx.tx, tx: { ...inner, function: 'like', returnType: 'ok',
      log: [log('Liked', inner.callerId, configVersion, videoId)] } } } });
  row.data = { other_plugin: { untouched: true } };
  return { viewer, row, async settle() {
    const result = await runSponsor({ ...signer, headHeight: state.height, observedOuter: job.raw_outer });
    assert.equal(result.broadcasts, 0); assert.equal(result.signatures, 0);
    const retry = await post(b);
    assert.equal(retry.sponsorshipStatus, 'confirmed'); assert.equal(retry.sponsoredTx, row.hash);
    assert.equal(retry.status, 'confirmed');
    const duplicate = await request(c, '/like-sponsorships', { id: randomUUID(), videoId: id, signedInnerTx: await signLike(2) });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    const [only] = await owner.query('SELECT count(*)::int AS jobs, sum(broadcast_attempts)::int AS broadcasts FROM shorts_like_sponsorship_jobs WHERE contract=$1', [scope.contract]);
    assert.deepEqual(only, { jobs: 1, broadcasts: 1 });
  } };
};
