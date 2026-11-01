require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shortsContractPolicy } = require('./shorts-contract-policy');
const { ShortsService } = require('./shorts.service');
const { releaseFixture } = require('./shorts-release.fixture.cjs');

function fixture(patch = {}) {
  const { release, artifact } = releaseFixture(patch);
  const chain = { release, artifact, operator: { address: release.operator }, state: { contract: release.contract } };
  chain.policy = async () => shortsContractPolicy([release.operator, release.treasury, release.likeFeeAetto, release.treasuryBps], 1);
  chain.rewardContracts = () => [];
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

test('free Like configuration advertises sponsorship only for the bound zero-payment ABI', async () => {
  const like = { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'expected_config_version', type: 'int' }],
    returns: { tuple: [] }, payable: false, stateful: true };
  const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [like] } }];
  const { release, artifact } = releaseFixture({ schemaVersion: 2, likeFeeAetto: '0' }, { aci });
  const chain = { release, artifact, state: { contract: release.contract }, rewardContracts: () => [],
    policy: async () => ({ version: '0', operator: release.operator, treasury: release.treasury,
      likeFeeAetto: '0', treasuryBps: 2000, publishingEnabled: true, likesEnabled: true, commentsEnabled: true }) };
  const media = { health: async () => true, safety: { health: async () => true } };
  const service = new ShortsService(chain, media, { since: 1234 }, {});
  const withoutSponsor = await service.config();
  assert.equal(withoutSponsor.likeMode, 'free'); assert.equal(withoutSponsor.likeFee, '0');
  assert.equal(withoutSponsor.creatorShare, 0); assert.equal(withoutSponsor.treasuryShare, 0);
  assert.deepEqual(withoutSponsor.likeSponsorship, { enabled: false });
  const sponsorship = { enabled: true, gasLimit: 100000, gasPrice: '1000000000', maxFee: '100000000000000', ttlBlocks: 10 };
  service.likeSponsor = { publicConfig: async () => sponsorship };
  assert.deepEqual((await service.config()).likeSponsorship, sponsorship);
  service.likeSponsor = { publicConfig: async () => {
    chain.state.contract = 'ct_changed_during_sponsorship_check';
    return sponsorship;
  } };
  await assert.rejects(service.config(), { status: 503 });
  chain.state.contract = release.contract;
  service.likeSponsor = { publicConfig: async () => {
    chain.release = { ...release, sourceHash: 'f'.repeat(64) };
    return sponsorship;
  } };
  await assert.rejects(service.config(), { status: 503 });
  chain.release = release;
  chain.policy = async () => ({ likeFeeAetto: '1' });
  await assert.rejects(service.config(), /capability/);
});
