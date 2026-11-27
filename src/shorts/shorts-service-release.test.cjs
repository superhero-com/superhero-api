require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm, mkdir, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { releaseFixture } = require('./shorts-release.fixture.cjs');
const { loadShortsRelease } = require('./shorts-release');
const { workerConfig } = require('./testing/standalone-ingest.cjs');
const { retentionConfig } = require('./shorts-retention.config');
const { storageInventoryConfig } = require('./shorts-storage-inventory.config');
const { storageReconciliationConfig } = require('./shorts-storage-reconciliation.config');
const { hlsInventoryConfig } = require('./shorts-hls-inventory.config');
const { pinInventoryConfig } = require('./shorts-pin-inventory.config');
const { publishingDeployment, shortsPublisherConfig } = require('./shorts-publisher.config');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-service-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { release, artifact } = releaseFixture();
  const file = join(dir, 'release.json');
  const save = value => writeFile(file, JSON.stringify(value));
  await save(release);
  const env = { NODE_ENV: 'production', ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat',
    SHORTS_TESTNET_MVP: '1', SHORTS_DEPLOYMENT_FILE: file };
  const files = { 's3.json': { accessKeyId: 'fixture', secretAccessKey: 'fixture-only' },
    'keys.json': { activeKeyId: 'key1', keys: { key1: 'a'.repeat(64) } },
    'policy.json': { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000',
      maxPending: 2, maxCreatorPending: 1, leaseMs: 3000, maxTtlBlocks: 20, confirmations: 3 },
    'artifact.json': artifact };
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(value), { mode: 0o600 });
  await writeFile(join(dir, 'token'), 'b'.repeat(64), { mode: 0o600 });
  const storage = { SHORTS_PRIVATE_S3_ENDPOINT: 'https://storage.invalid', SHORTS_PRIVATE_S3_REGION: 'us-east-1',
    SHORTS_PRIVATE_S3_BUCKET: 'shorts-fixture', SHORTS_PRIVATE_S3_CREDENTIALS_FILE: join(dir, 's3.json') };
  const publisher = { SHORTS_PUBLISHING_POLICY_FILE: join(dir, 'policy.json'), SHORTS_CONTRACT_ARTIFACT: join(dir, 'artifact.json'),
    SHORTS_OPERATOR_KEY_FILE: join(dir, 'dedicated-key-not-read-during-config') };
  const roles = [
    ...(process.env.SHORTS_TEST_INGEST_ROOT ? [['worker', workerConfig(), {}]] : []),
    ['retention', retentionConfig, {}],
    ['storage inventory', storageInventoryConfig, storage],
    ['storage reconciliation', storageReconciliationConfig, { ...storage, SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE: join(dir, 'keys.json') }],
    ['pin inventory', pinInventoryConfig, { SHORTS_PIN_API: 'https://ipfs.invalid/api/v0', SHORTS_PIN_PEER_ID: '12D3KooW' + 'a'.repeat(44), SHORTS_PIN_TOKEN_FILE: join(dir, 'token') }],
    ['HLS inventory', hlsInventoryConfig, { SHORTS_HLS_REDIS_URL: 'rediss://inventory@redis.invalid/0', SHORTS_HLS_REDIS_PASSWORD_FILE: join(dir, 'token'), SHORTS_HLS_NAMESPACE: 'shorts-fixture' }],
    ['publication boundary', publishingDeployment, { SHORTS_PUBLISHING_POLICY_FILE: publisher.SHORTS_PUBLISHING_POLICY_FILE }],
    ['publisher', shortsPublisherConfig, publisher],
  ];
  return { dir, file, release, env, save, roles };
}

test('all service roles accept the same full reviewed release without contacting external services', async t => {
  const f = await fixture(t);
  for (const [name, load, extra] of f.roles) {
    const config = await load({ ...f.env, ...extra });
    assert.deepEqual(config.scope, { network: f.release.network, contract: f.release.contract }, name);
    assert.equal(config.sourceHash, f.release.sourceHash, name);
    if (config.release) { assert.deepEqual(config.release, f.release); assert.ok(Object.isFrozen(config.release)); }
  }
});

test('worker and operations adapters reject stale, cross-wired and unsupported manifests', async t => {
  const f = await fixture(t);
  const cases = [
    { network: 'ae_uat', contract: f.release.contract, sourceHash: f.release.sourceHash },
    ...[{ network: 'ae_mainnet' }, { schemaVersion: 0 }, { contract: 'ct_unchecked' },
      { operator: f.release.contract }, { aciHash: '' }, { compiler: 'unknown' },
      { node: 'http://127.0.0.1:3333' }, { middleware: 'https://mainnet.aeternity.io/mdw' },
      { previousContract: releaseFixture().release.contract }]
      .map(patch => ({ ...f.release, ...patch })),
  ];
  for (const value of cases) {
    await f.save(value);
    for (const [name, load, extra] of f.roles) await assert.rejects(load({ ...f.env, ...extra }), undefined, name);
  }
  await f.save(f.release);
  for (const [name, load, extra] of f.roles) await assert.rejects(load({ ...f.env, ...extra, AE_NETWORK_ID: 'ae_mainnet' }), undefined, name);
});

test('all role adapters reject non-regular, linked, malformed and oversized manifest files', { timeout: 10000 }, async t => {
  const f = await fixture(t), directory = join(f.dir, 'directory'), link = join(f.dir, 'link'), fifo = join(f.dir, 'fifo');
  await mkdir(directory); await symlink(f.file, link); execFileSync('mkfifo', [fifo]);
  for (const path of ['relative.json', directory, link, fifo]) {
    for (const [name, load, extra] of f.roles) await assert.rejects(load({ ...f.env, ...extra, SHORTS_DEPLOYMENT_FILE: path }), undefined, name);
  }
  for (const data of ['{bad', ' '.repeat(1048577)]) {
    await writeFile(f.file, data);
    for (const [name, load, extra] of f.roles) await assert.rejects(load({ ...f.env, ...extra }), undefined, name);
  }
});

test('service configuration uses the explicit network rather than the ambient environment', async t => {
  const f = await fixture(t), old = process.env.AE_NETWORK_ID;
  process.env.AE_NETWORK_ID = 'ae_mainnet';
  t.after(() => { if (old === undefined) delete process.env.AE_NETWORK_ID; else process.env.AE_NETWORK_ID = old; });
  assert.deepEqual(await loadShortsRelease(f.env), f.release);
  for (const [, load, extra] of f.roles) assert.equal((await load({ ...f.env, ...extra })).scope.network, 'ae_uat');
});
