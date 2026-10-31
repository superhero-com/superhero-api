require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AccountMemory, encode, Encoding } = require('@aeternity/aepp-sdk');
const { shortsContractPolicy } = require('./shorts-contract-policy');
const { ShortsCommentsService } = require('./shorts-comments.service');
const { ShortsLegacyImportService } = require('./shorts-legacy-import.service');
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

test('content scope stays pinned while auth/transaction identity advances and mutation fails closed', () => {
  const { release } = releaseFixture({ schemaVersion: 2, storage: { contract: address(2), sourceHash: 'b'.repeat(64) } });
  const chain = { release, state: { contract: release.contract, sourceHash: release.sourceHash } };
  assert.equal(shortsRuntimeScope(chain).contract, release.contract); assert.equal(shortsStorageScope(chain).contract, address(2)); assert.equal(shortsStorageSourceHash(chain), 'b'.repeat(64));
  chain.release.storage.sourceHash = 'c'.repeat(64); assert.throws(() => shortsStorageScope(chain), { status: 503 });
  const frozen = shortsRelease(release); assert.ok(Object.isFrozen(frozen.storage));
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

function imported() {
  const s = new ShortsLegacyImportService({ read: f => f() });
  const snapshot = { commitment: 'ab'.repeat(32), cutoff: { height: 4 } };
  const manifest = { source: owner, totals: { videos: 1, likes: 0, comments: 0, authors: 0 } };
  const state = { status: { import_started: true, importing: false, frozen: false, abandoned: false, totals: { videos: 4n, likes: 5n, comments: 2n, authors: 2n } }, writes: 0 };
  s.release = { contract: address(8) }; s.commitment = async () => ({ manifest, items: [{}], commitment: snapshot.commitment });
  s.verify = async value => value; s.canonical = async () => {};
  s.destination = { $call: async (method, _args, options) => {
    if (!options.callStatic) { state.writes++; throw new Error('No repeat signing'); }
    if (method === 'migration_status') return { decodedResult: state.status };
    if (method === 'get_import_source') return { decodedResult: [null, manifest] };
    if (method === 'get_import_progress') return { decodedResult: [1n, 1n, Buffer.from(snapshot.commitment, 'hex'), Buffer.from(snapshot.commitment, 'hex'), 0n, 0n] };
    throw new Error('Must not require unchanged live content: ' + method);
  } };
  return { s, snapshot, state };
}
test('immutable import proof supports setup after new activity but rejects inactive, abandoned, frozen and forged baselines', async () => {
  const { s, snapshot, state } = imported(); await s.verifyBaseline(snapshot);
  for (const key of ['importing', 'abandoned', 'frozen']) { state.status[key] = true; await assert.rejects(s.verifyBaseline(snapshot), /lifecycle/); state.status[key] = false; }
  await assert.rejects(s.verifyBaseline({ ...snapshot, commitment: 'cd'.repeat(32) }), /commitment mismatch/);
});
test('lost activation acknowledgement reconciles already-completed import without a second signature', async () => {
  const { s, snapshot, state } = imported(); assert.equal((await s.import(snapshot, true)).importing, false); assert.equal(state.writes, 0);
});


test('free accounts skip removed getters and preserve verified historical reward balances', async () => {
  const { ShortsChainService } = require('./shorts-chain.service');
  const like = { name: 'like', arguments: [{ name: 'id', type: 'string' }, { name: 'version', type: 'int' }], returns: { tuple: [] }, payable: false, stateful: true };
  const aci = [{ contract: { name: 'Shorts', kind: 'contract_main', typedefs: [], functions: [like] } }];
  const { release, artifact } = releaseFixture({ schemaVersion: 2, likeFeeAetto: '0' }, { aci });
  const chain = new ShortsChainService({}, {});
  Object.assign(chain, { release, artifact, sdk: { getBalance: async () => '5000000000000000000' } });
  chain.readNode = operation => operation();
  chain.policy = async () => ({ likeFeeAetto: '0' });
  chain.read = async () => { throw new Error('removed current reward getter'); };
  let oldCalls = 0;
  chain.rewardContracts = () => [
    { artifact, contract: { $options: { address: address(9) }, $call: async () => { throw new Error('free predecessor has no reward getter'); } } },
    { contract: { $options: { address: address(8) }, $call: async (method, args, options) => {
    assert.equal(method, 'get_account'); assert.deepEqual(args, [owner]); assert.equal(options.callStatic, true); oldCalls++;
    return { decodedResult: { available: 2n * 10n ** 18n, earned: 3n * 10n ** 18n, claimed: 10n ** 18n } };
  } } }];
  assert.deepEqual(await chain.account(owner), { address: owner, wallet: '5', available: '0', earned: '3', claimed: '1',
    previousAvailable: '2', rewardAccounts: [{ contract: address(8), available: '2' }] });
  assert.equal(oldCalls, 1);
  chain.policy = async () => ({ likeFeeAetto: '1' });
  await assert.rejects(chain.account(owner), /capability/);
  assert.equal(oldCalls, 1);
  chain.policy = async () => ({ likeFeeAetto: '0' });
  chain.artifact = { ...artifact, aci: [] };
  await assert.rejects(chain.account(owner));
  assert.equal(oldCalls, 1);
  const paid = releaseFixture();
  Object.assign(chain, paid);
  chain.read = async (method, args) => { assert.equal(method, 'get_account'); assert.deepEqual(args, [owner]); return { available: 1n, earned: 2n, claimed: 1n }; };
  assert.equal((await chain.account(owner)).available, '0.000000000000000001');
});
