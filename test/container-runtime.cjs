// Run against the final image with this file mounted at /checks/runtime.cjs.
// No database, chain endpoint, wallet or external network is contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const load = createRequire(join(process.cwd(), 'package.json'));

test('production runtime is unprivileged and excludes application sources and build tools', () => {
  assert.equal(process.platform, 'linux');
  assert.notEqual(process.getuid(), 0);
  assert.equal(process.env.NODE_ENV, 'production');
  for (const path of ['.env', '.git', 'Dockerfile', 'tsconfig.json', 'docs',
    'scripts/update-package-type.js', '/usr/local/bin/npm', '/usr/local/bin/npx',
    '/usr/bin/git', '/usr/bin/gcc', '/usr/bin/python3']) {
    assert.equal(existsSync(path), false, path);
  }
  assert.deepEqual(readdirSync('src'), ['data']);
  assert.deepEqual(readdirSync('src/data'), ['ae-pricing.json']);
});

test('compiled role entrypoints, migrations and dynamic assets are retained', () => {
  for (const path of ['dist/main.js', 'dist/data-source.js',
    'dist/shorts/worker-main.js', 'dist/shorts/publisher-main.js',
    'scripts/migrate-with-lock.js', 'views/main-layout.hbs']) {
    assert.ok(readFileSync(path).length > 0, path);
  }
  assert.ok(readdirSync('dist/migrations').some(name => name.endsWith('.js')));
  assert.ok(JSON.parse(readFileSync('src/data/ae-pricing.json')));
  assert.ok(JSON.parse(readFileSync('dist/plugins/address-links/aci/AddressLink.aci.json')));
});

test('production SDK and native password hashing load after pruning build dependencies', async () => {
  load('reflect-metadata');
  assert.ok(load('bctsl-sdk'));
  assert.ok(load('@aeternity/aepp-sdk').AeSdk);
  const argon2 = load('argon2');
  const hash = await argon2.hash('container-fixture', { memoryCost: 4096, timeCost: 2, parallelism: 1 });
  assert.equal(await argon2.verify(hash, 'container-fixture'), true);
  assert.equal(await argon2.verify(hash, 'wrong-fixture'), false);
  load('./dist/app.module.js');
});
