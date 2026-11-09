require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { releaseFixture, digest } = require('./shorts-release.fixture.cjs');
const { shortsRelease, shortsArtifact, assertSupportedShortsRelease, assertShortsReleaseConfig, shortsConfigJson } = require('./shorts-release');
const { shortsPublisherConfig } = require('./shorts-publisher.config');
const { ShortsChainService } = require('./shorts-chain.service');

test('versioned manifests bind every release field without enabling mainnet or changed economics', () => {
  const { release } = releaseFixture();
  assert.deepEqual(shortsRelease(release), release);
  assert.ok(Object.isFrozen(shortsRelease(release)));
  assertSupportedShortsRelease(release, { AE_NETWORK_ID: 'ae_uat' });
  for (const field of Object.keys(release)) {
    const missing = { ...release }; delete missing[field];
    if (field === 'previousContract') assert.equal(shortsRelease(missing).previousContract, null);
    else assert.throws(() => shortsRelease(missing), undefined, field);
  }
  for (const patch of [
    { schemaVersion: '1' }, { network: 'ae_dev' }, { contract: release.operator },
    { previousContract: release.contract }, { treasury: release.contract }, { operator: '' },
    { compiler: 'unknown' }, { sourceHash: 'A'.repeat(64) }, { bytecodeHash: '' }, { aciHash: 1 },
    { likeFeeAetto: 1 }, { likeFeeAetto: '1e18' }, { likeFeeAetto: '01' },
    { likeFeeAetto: (2n ** 256n).toString() }, { treasuryBps: '2000' }, { treasuryBps: 0.2 }, { treasuryBps: 10001 },
  ]) assert.throws(() => shortsRelease({ ...release, ...patch }));
  for (const patch of [{ network: 'ae_mainnet' }, { middleware: 'https://wrong.invalid/mdw' }]) {
    const parsed = shortsRelease({ ...release, ...patch });
    assert.throws(() => assertSupportedShortsRelease(parsed, { AE_NETWORK_ID: 'ae_uat' }));
  }
  assert.throws(() => assertSupportedShortsRelease(release, { AE_NETWORK_ID: 'ae_mainnet' }));
});

test('release endpoint URLs reject credentials, redirects-by-configuration and remote plaintext', () => {
  const { release } = releaseFixture();
  for (const node of ['http://remote.invalid', 'https://user:pass@node.invalid', 'https://node.invalid/?key=x', 'https://node.invalid/#x', 'https://node.invalid/v3', 'https://node.invalid/', 'HTTPS://NODE.INVALID', 'https://node.invalid:443']) {
    assert.throws(() => shortsRelease({ ...release, node }, true), undefined, node);
  }
  for (const middleware of ['http://remote.invalid/mdw', 'https://u:p@mdw.invalid', 'https://mdw.invalid/mdw?token=x', 'https://mdw.invalid/mdw#x', 'https://mdw.invalid/mdw/']) {
    assert.throws(() => shortsRelease({ ...release, middleware }, true));
  }
  assert.throws(() => shortsRelease({ ...release, node: 'http://127.0.0.1:19000' }));
  assert.equal(shortsRelease({ ...release, node: 'http://127.0.0.1:19000' }, true).node, 'http://127.0.0.1:19000');
});

test('artifact source, compiler, bytecode and ABI are tied to independently mounted manifest hashes', () => {
  const { release, artifact } = releaseFixture();
  assert.equal(shortsArtifact(artifact, release), artifact);
  for (const patch of [{ sourceHash: 'b'.repeat(64) }, { compiler: '8.0.1' }, { bytecodeHash: 'c'.repeat(64) }, { bytecode: artifact.bytecode + 'x' }, { aci: [] }, { aci: [{ altered: true }] }]) {
    assert.throws(() => shortsArtifact({ ...artifact, ...patch }, release), /artifact/);
  }
  // Updating a tampered artifact's self-declared hash still cannot replace the release.
  const bytecode = artifact.bytecode + 'x';
  assert.throws(() => shortsArtifact({ ...artifact, bytecode, bytecodeHash: digest(bytecode) }, release));
  const config = { operator: release.operator, max_video_bytes: 100000000, max_comment_chars: 280,
    max_comment_bytes: 1120, comment_cooldown: 0, publishing_enabled: true, likes_enabled: true, comments_enabled: true };
  assertShortsReleaseConfig(release, [config, 1]);
  assert.throws(() => assertShortsReleaseConfig(release, [{ ...config, operator: release.contract }, 1]));

});

test('bounded configuration reads reject symlinks, relative paths, malformed and oversized files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'release-files-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json'); await writeFile(file, '{"ok":true}');
  assert.deepEqual(await shortsConfigJson(file), { ok: true });
  await symlink(file, join(dir, 'link')); await assert.rejects(shortsConfigJson(join(dir, 'link')));
  await assert.rejects(shortsConfigJson('relative.json'), /absolute/);
  await writeFile(file, 'x'.repeat(1048577)); await assert.rejects(shortsConfigJson(file), /size/);
  await writeFile(file, '{bad'); await assert.rejects(shortsConfigJson(file));
});

test('release and publisher configuration imports do not load ambient dotenv files', async t => {
  const { execFileSync } = require('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'release-ambient-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ambient.env');
  await writeFile(file, 'SHORTS_AMBIENT_RELEASE_TEST=must-not-load\n');
  execFileSync(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', '-e',
    'require("./src/shorts/shorts-publisher.config"); if (process.env.SHORTS_AMBIENT_RELEASE_TEST) process.exit(1);'],
  { cwd: process.cwd(), env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: file }, timeout: 15000, stdio: 'pipe' });
});

test('API and publisher fail on release or artifact mismatch before node access or key loading', async t => {
  const saved = { ...process.env }, dir = await mkdtemp(join(tmpdir(), 'release-start-'));
  t.after(async () => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); await rm(dir, { recursive: true, force: true }); });
  const { release, artifact } = releaseFixture();
  const env = { ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1', NODE_ENV: 'test',
    SHORTS_DEPLOYMENT_FILE: join(dir, 'deployment.json'), SHORTS_CONTRACT_ARTIFACT: join(dir, 'artifact.json'),
    SHORTS_PUBLISHING_POLICY_FILE: join(dir, 'policy.json'), SHORTS_OPERATOR_KEY_FILE: join(dir, 'absent-key.json') };
  const policy = { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000', maxPending: 8, maxCreatorPending: 2, leaseMs: 120000, maxTtlBlocks: 30, confirmations: 3 };
  await writeFile(env.SHORTS_PUBLISHING_POLICY_FILE, JSON.stringify(policy));
  Object.assign(process.env, env); delete process.env.SHORTS_OPERATOR_KEY_FILE;
  for (const [r, a] of [[{ ...release, network: 'ae_mainnet' }, artifact], [{ ...release, treasury: 'not-an-address' }, artifact], [release, { ...artifact, aci: [{ changed: true }] }], [release, { ...artifact, sourceHash: 'd'.repeat(64) }]]) {
    await writeFile(env.SHORTS_DEPLOYMENT_FILE, JSON.stringify(r)); await writeFile(env.SHORTS_CONTRACT_ARTIFACT, JSON.stringify(a));
    const chain = new ShortsChainService({}, {}, { shared: true }, { createNode() { assert.fail('No node request before validation'); } });
    await assert.rejects(chain.onModuleInit(), /release|artifact/i);
    await assert.rejects(shortsPublisherConfig(env), /release|artifact/i);
  }
  await writeFile(env.SHORTS_DEPLOYMENT_FILE, JSON.stringify(release)); await writeFile(env.SHORTS_CONTRACT_ARTIFACT, JSON.stringify(artifact));
  const config = await shortsPublisherConfig(env);
  assert.deepEqual(config.release, release); assert.equal(config.nodeUrl, release.node);
  await assert.rejects(shortsPublisherConfig({ ...env, SHORTS_PUBLISHER_NODE_URL: 'https://other.invalid' }), /override/);
});

test('canonical release hashing matches the web golden vector and ignores receipt ordering', () => {
  const vector = require('./shorts-release-vector.fixture.json');
  const input = Object.fromEntries(Object.entries(vector.release).reverse());
  input.transaction = 'receipt-metadata';
  assert.equal(digest(JSON.stringify(shortsRelease(input))), vector.digest);
});

test('a fresh release rejects external contract, reward and storage bindings', () => {
  const { release } = releaseFixture();
  for (const patch of [{ previousContract: release.contract }, { previousArtifact: {} }, { rewardContracts: [release] }, { storage: release }])
    assert.throws(() => shortsRelease({ ...release, ...patch }));
});

test('startup requires an active contract deployed without an import', () => {
  const { assertActiveShortsContract } = require('./shorts-release');
  const fresh = {schema: 2n, importing: false, import_started: false, abandoned: false, frozen: false};
  assert.doesNotThrow(() => assertActiveShortsContract(fresh));
  for (const patch of [{schema:1n}, {importing:true}, {import_started:true}, {abandoned:true}, {frozen:true}, {reserved_source:'ct_other'}])
    assert.throws(() => assertActiveShortsContract({...fresh, ...patch}));
});
