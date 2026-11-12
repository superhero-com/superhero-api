const { originalRecord } = require('./testing/original-record.cjs');
const {
  ShortsUploads,
  ShortsUploadBudget,
  ShortsMetadata,
} = require('./testing/schema-migrations.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const files = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { DataSource } = require('typeorm');
const { ShortsStoreService } = require('./shorts-store.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsMetadataModule } = require('./shorts-metadata.module');
const { ShortsRecordsService } = require('./shorts-records.service');
function clean(t) {
  const keys = [
    'SHORTS_DATA_DIR',
    'SHORTS_IPFS_API',
    'SHORTS_IPFS_APIS',
    'SHORTS_IPFS_CREDENTIALS_FILE',
    'SHORTS_IPFS_TOKEN_FILE',
    'NODE_ENV',
  ];
  const saved = keys.map((key) => process.env[key]);
  keys.forEach((key) => delete process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }),
  );
}

test('hosted providers neither create a local store nor generate quarantine files', async (t) => {
  clean(t);
  t.mock.method(fs, 'mkdirSync', () => {
    throw new Error('Unexpected local directory');
  });
  t.mock.method(files, 'mkdir', async () => {
    throw new Error('Unexpected local media directory');
  });
  t.mock.method(files, 'writeFile', async () => {
    throw new Error('Unexpected local key');
  });
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
  });
  for (let i = 0; i < 2; i++) {
    const app = await NestFactory.createApplicationContext(
      {
        module: class HostedProviders {},
        providers: [
          { provide: DataSource, useValue: {} },
          ShortsStoreService,
        ],
      },
      { logger: false },
    );
    apps.push(app);
    const store = app.get(ShortsStoreService);
    assert.equal(store.shared, true);
    assert.throws(() => store.db, /unavailable in the hosted API/);
    assert.throws(() => store.load(), /unavailable in the hosted API/);
    assert.throws(() => store.save({}), /unavailable in the hosted API/);
    const media = new ShortsMediaService({}, {}, { shared: true }, { acquire: async () => ({ signal: new AbortController().signal, release: async () => {} }) });
    await media.onModuleInit();
    await assert.rejects(
      media.preview({ id: 'owned', files: [] }),
      /Invalid original video identity/,
    );
    await assert.rejects(
      media.rescan({ id: 'owned' }),
      /Invalid original video identity/,
    );
    media.onModuleDestroy();
  }
});

test('hosted startup rejects a local store', t => {
  clean(t); process.env.SHORTS_DATA_DIR = '/local/data';
  assert.throws(() => new ShortsStoreService({}), /shared storage/);
});

test(
  'two hosted runtimes share the active deployment and reject missing media references',
  {
    skip: !process.env.SHORTS_TEST_PG_URL,
    timeout: 20000,
  },
  async (t) => {
    clean(t);
    const url = new URL(process.env.SHORTS_TEST_PG_URL);
    assert.equal(url.hostname, '127.0.0.1');
    const schema = 'shorts_shared_' + randomUUID().replaceAll('-', '');
    const admin = new DataSource({ type: 'postgres', url: url.href });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = {
      type: 'postgres',
      url: url.href,
      schema,
      extra: { options: `-c search_path=${schema}` },
      migrations: [
        ShortsMetadata, ShortsUploads,
        ShortsUploadBudget],
    };
    const a = new DataSource(options),
      b = new DataSource(options),
      apps = [];
    t.after(async () => {
      for (const app of apps) await app.close();
      if (a.isInitialized) await a.destroy();
      if (b.isInitialized) await b.destroy();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.destroy();
    });
    await a.initialize();
    await b.initialize();
    await a.runMigrations({ transaction: 'all' });
    const scope = { network: 'ae_uat', contract: 'ct_owned' },
      hash = 'a'.repeat(64);
    const meta = new ShortsMetadataService(a),
      other = new ShortsMetadataService(b);
    await meta.initialize(scope, hash);
    await Promise.all([
      meta.verifyHostedStorage(scope),
      other.verifyHostedStorage(scope),
    ]);
    const record = originalRecord('owned', { creator: 'ak_creator', title: 'Owned', topic: 'Art', createdAt: 100, duration: 3, moderation: 'pending', reports: 0, views: [] });
    await meta.insertDraft(scope, record);
    await assert.rejects(
      other.verifyHostedStorage(scope),
      /missing its private media/,
    );
    await a.query(
      `UPDATE shorts_content SET body=body || $1::jsonb WHERE id='owned'`, [JSON.stringify({privateMedia:{version:1,fence:record.derivatives.generation.fence,source:{processingProfile:'original-h264-v1',bytes:record.bytes,sha256:record.original.sha256}}})],
    );
    for (const db of [a, b]) {
      const app = await NestFactory.createApplicationContext(
        {
          module: class Runtime {},
          imports: [{ module: class Database {}, global: true,
            providers: [{ provide: DataSource, useValue: db }], exports: [DataSource] }, ShortsMetadataModule],
          providers: [
            ShortsStoreService,
            {
              provide: ShortsRecordsService,
              useFactory: (m) =>
                new ShortsRecordsService(
                  {
                    release: { network: scope.network, contract: scope.contract },
                    state: {
                      contract: scope.contract,
                      sourceHash: hash,
                      shorts: [],
                    },
                  },
                  m,
                ),
              inject: [ShortsMetadataService],
            },
          ],
        },
        { logger: false },
      );
      apps.push(app);
    }
    const one = apps[0].get(ShortsRecordsService),
      two = apps[1].get(ShortsRecordsService);
    const writes = Array.from({ length: 20 }, (_, i) => () =>
      (i % 2 ? one : two).change('owned', s => { s.reports++; }));
    const results = await Promise.allSettled(writes.map(write => write()));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') continue;
      assert.equal(results[i].reason.status, 503);
      assert.equal(results[i].reason.message, 'Shorts database is busy; retry shortly');
      await writes[i](); // Only known pre-execution refusal; never replay uncertain writes.
    }
    assert.equal((await one.get('owned')).reports, 20);
    assert.equal((await two.get('owned')).reports, 20);
    await assert.rejects(
      a.undoLastMigration({ transaction: 'all' }),
      /Preserve upload reservations/,
    );
  },
);
