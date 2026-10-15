require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsService } = require('./shorts.service');
const { releaseFixture } = require('./shorts-release.fixture.cjs');

function fixture(patch = {}) {
  const { release, artifact } = releaseFixture(patch);
  const chain = { release, artifact, operator: { address: release.operator }, state: { contract: release.contract } };
  const media = { health: async () => true, safety: { health: async () => false } };
  return { chain, media, service: new ShortsService(chain, media, { since: 1234 }, { realtime: true }) };
}
for (const network of ['ae_uat', 'ae_mainnet']) {
  for (const [likeFeeAetto, treasuryBps, fee, creatorShare, treasuryShare] of [
    ['100000000000000000', 2000, '0.1', 80, 20],
    ['1234567890123456789', 3333, '1.234567890123456789', 66.67, 33.33],
    ['1', 0, '0.000000000000000001', 100, 0],
    ['1000000000000000000', 10000, '1', 0, 100],
  ]) test(`public configuration derives ${network} fee ${fee} and split ${treasuryBps} from the release`, async () => {
    const f = fixture({ network, likeFeeAetto, treasuryBps });
    const config = await f.service.config();
    assert.equal(config.network, network); assert.equal(config.mode, network === 'ae_uat' ? 'testnet' : 'mainnet');
    assert.equal(config.likeFee, fee); assert.equal(config.creatorShare, creatorShare); assert.equal(config.treasuryShare, treasuryShare);
    assert.deepEqual(config.release, f.chain.release); assert.equal(config.hosting, 'platform-funded');
    assert.equal(config.ipfs, true); assert.equal(config.visualModeration, false);
    assert.equal(config.analyticsSince, 1234); assert.equal(config.realtime, true);
  });
}

test('uninitialized or malformed configuration never advertises a default price', async () => {
  for (const patch of [{ likeFeeAetto: undefined }, { likeFeeAetto: '0' }, { likeFeeAetto: '-1' }, { treasuryBps: 10001 }, { network: 'other' }]) {
    const f = fixture(patch); let called = false;
    f.media.health = async () => { called = true; return true; };
    await assert.rejects(f.service.config()); assert.equal(called, false);
  }
});

test('a release change while readiness loads cannot return a mixed configuration', async () => {
  for (const change of ['price', 'split', 'network', 'contract', 'reference']) {
    const f = fixture();
    f.media.health = async () => {
      if (change === 'price') f.chain.release.likeFeeAetto = '200000000000000000';
      if (change === 'split') f.chain.release.treasuryBps = 0;
      if (change === 'network') f.chain.release.network = 'ae_mainnet';
      if (change === 'contract') f.chain.state.contract = 'ct_other';
      if (change === 'reference') f.chain.release = { ...f.chain.release };
      return true;
    };
    await assert.rejects(f.service.config(), { status: 503 });
  }
});
