require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AccountMemory, encode, Encoding } = require('@aeternity/aepp-sdk');
const { shortsContractPolicy } = require('./shorts-contract-policy');
const { ShortsCommentsService } = require('./shorts-comments.service');
const { ShortsAuthService } = require('./shorts-auth.service');
const { shortsRuntimeScope, shortsStorageScope, shortsStorageSourceHash } = require('./shorts-runtime-scope');
const { shortsRelease } = require('./shorts-release');
const { releaseFixture } = require('./shorts-release.fixture.cjs');
const address = n => encode(Buffer.alloc(32, n), Encoding.ContractAddress);
const owner = AccountMemory.generate().address, replacement = AccountMemory.generate().address;
const cfg = { operator: owner, treasury: owner, like_fee: 1n, treasury_bps: 3333n, max_video_bytes: 1000000n,
  max_comment_chars: 12n, max_comment_bytes: 24n, comment_cooldown: 3n, publishing_enabled: true, likes_enabled: false, comments_enabled: true };

test('live V2 policy exposes exact changed fee/version/limits; invalid settings fail closed', () => {
  const p = shortsContractPolicy([cfg, 8n], 2); assert.equal(p.version, '8'); assert.equal(p.likeFeeAetto, '1'); assert.equal(p.maxCommentChars, 12); assert.equal(p.likesEnabled, false);
  assert.equal(shortsContractPolicy([{ ...cfg, like_fee: 0n }, 8n], 2).likeFeeAetto, '0');
  for (const patch of [{ like_fee: -1n }, { max_comment_chars: 281n }, { comments_enabled: 'true' }, { comment_cooldown: -1n }]) assert.throws(() => shortsContractPolicy([{ ...cfg, ...patch }, 8n], 2));
});

test('compact free policy reads without economics fields while partial and unknown records fail closed', () => {
  const { treasury, like_fee, treasury_bps, ...free } = cfg;
  const policy = shortsContractPolicy([free, 9n], 2);
  assert.equal(policy.version, '9'); assert.equal(policy.treasury, null);
  assert.equal(policy.likeFeeAetto, '0'); assert.equal(policy.treasuryBps, 0);
  assert.equal(policy.maxCommentChars, 12);
  for (const patch of [{treasury}, {like_fee}, {treasury_bps}, {unknown: 0}])
    assert.throws(() => shortsContractPolicy([{...free, ...patch}, 9n], 2));
  for (const key of Object.keys(free)) {
    const incomplete = {...free}; delete incomplete[key];
    assert.throws(() => shortsContractPolicy([incomplete, 9n], 2));
  }
  assert.equal(shortsContractPolicy([owner, owner, 1n, 2000n], 1).likeFeeAetto, '1');
});

test('storage and chain use the same active contract', () => {
  const { release } = releaseFixture();
  const chain = { release, state: { contract: release.contract, sourceHash: release.sourceHash } };
  assert.equal(shortsRuntimeScope(chain), shortsStorageScope(chain));
  assert.equal(shortsStorageSourceHash(chain), release.sourceHash);
  chain.state.contract = address(2);
  assert.throws(() => shortsStorageScope(chain), { status: 503 });
});

test('on-chain operator rotation immediately removes privileged API access and fails closed offline', async () => {
  const chain = { release: { schemaVersion: 2 }, operator: { address: owner }, policy: async () => ({ operator: replacement }) };
  const auth = new ShortsAuthService({}, chain); auth.authenticate = async () => owner; await assert.rejects(auth.operator(), { status: 403 });
  auth.authenticate = async () => replacement; assert.equal(await auth.operator(), replacement);
  chain.policy = async () => { throw new Error('offline'); }; await assert.rejects(auth.operator(), /offline/);
});

test('comments use bounded versioned pages, exact counters, author sequence and stale-cursor restart', async () => {
  let stale = false, reads = [];
  const chain = { release: { schemaVersion: 2 }, address: a => a, policy: async () => shortsContractPolicy([cfg, 8n], 2), sdk: { api: { getCurrentKeyBlock: async () => ({ height: 104 }) } }, readNode: f => f(), read: async (method, args) => {
    reads.push([method, args]);
    if (method === 'get_author') return { sequence: 2n, height: 103n };
    if (method === 'get_video_stats') return { likes: 9007199254740993n, comments: 2n, comment_version: 7n };
    if (method === 'get_comments_page') { if (stale) throw new Error('STALE_CURSOR'); return { items: [[4n, { author: owner, text: '<script>hello</script>', height: 100n, sequence: 2n }]], next_cursor: 1n, end_cursor: 2n, version: 7n }; }
    throw new Error(method);
  } };
  const service = new ShortsCommentsService(chain, { ensurePlayable: async () => ({}) });
  assert.equal((await service.author(owner)).nextSequence, '3'); assert.equal((await service.author(owner)).availableAt, '106');
  const page = await service.page('video', {}); assert.equal(page.next, '1'); assert.equal(page.items[0].id, '4'); assert.equal(page.version, '7');
  assert.equal((await service.stats('video')).likes, '9007199254740993');
  for (const query of [{ cursor: '1' }, { limit: '26' }, { cursor: '-1' }, { version: '1e3' }]) await assert.rejects(service.page('video', query), { status: 400 });
  stale = true; await assert.rejects(service.page('video', { cursor: '1', version: '7' }), { status: 409 });
  chain.release.schemaVersion = 1; await assert.rejects(service.page('video', {}), { status: 404 });
});
