const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsFeatureModule } = require('./shorts-feature.module');
const { assertShortsEnvironment } = require('./shorts-environment');
const { NestFactory } = require('@nestjs/core');

test('disabled Shorts registers no routes, providers or background services', async () => {
  const before = process.env.ENABLE_SHORTS;
  try {
    for (const value of [undefined, '', 'false', '1', 'TRUE']) {
      if (value === undefined) delete process.env.ENABLE_SHORTS;
      else process.env.ENABLE_SHORTS = value;
      const feature = ShortsFeatureModule.register();
      assert.deepEqual(feature.imports, []);
      assert.throws(assertShortsEnvironment, /disabled/);
      const app = await NestFactory.create(feature, { logger: false });
      await app.listen(0, '127.0.0.1');
      try {
        assert.equal((await fetch(`${await app.getUrl()}/shorts/config`)).status, 404);
      } finally { await app.close(); }
    }
    assert.equal(Object.keys(require.cache).some(path => path.endsWith('/shorts-store.service.ts')), false);
    process.env.ENABLE_SHORTS = 'true';
    const feature = ShortsFeatureModule.register();
    assert.equal(feature.imports.length, 1);
    assert.equal((await feature.imports[0]).module.name, 'ShortsTestnetModule');
  } finally {
    if (before === undefined) delete process.env.ENABLE_SHORTS;
    else process.env.ENABLE_SHORTS = before;
  }
});

test('hosted Shorts rejects mainnet, demo authentication and invalid deployment settings', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      ENABLE_SHORTS: 'true', SHORTS_TESTNET_MVP: '1', NODE_ENV: 'production',
      AE_NETWORK_ID: 'ae_uat', SHORTS_WEB_ORIGIN: 'https://staging.example.com',
      SHORTS_DATA_DIR: '/var/lib/shorts', SHORTS_DEMO_AUTO_APPROVE: '0', SHORTS_DEMO_CONNECTED_WALLET: '0',
    });
    assert.doesNotThrow(assertShortsEnvironment);
    for (const [key, value] of Object.entries({
      AE_NETWORK_ID: 'ae_mainnet', SHORTS_DEMO_CONNECTED_WALLET: '1',
      SHORTS_DEMO_AUTO_APPROVE: '1', SHORTS_WEB_ORIGIN: 'http://staging.example.com', SHORTS_DATA_DIR: 'relative',
    })) {
      const before = process.env[key]; process.env[key] = value;
      assert.throws(assertShortsEnvironment);
      process.env[key] = before;
    }
  } finally { process.env = saved; }
});
