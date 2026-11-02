// Disposable test worker: exit only after the real provider accepted deletion,
// before the cleanup service can persist its completion event.
require('reflect-metadata');
const { readFileSync } = require('node:fs');
const { DataSource } = require('typeorm');
const {
  ShortsPrivateObjectsService,
} = require('../shorts-private-objects.service');
const {
  ShortsPrivateVersionStorageService,
} = require('../shorts-private-version-storage.service');
const {
  ShortsPrivateVersionCleanupService,
} = require('../shorts-private-version-cleanup.service');
const {
  ShortsStorageReconciliationService,
} = require('../shorts-storage-reconciliation.service');
const {
  ShortsSourceReaderService,
} = require('../shorts-source-reader.service');
const { ShortsRetentionService } = require('../shorts-retention.service');
(async () => {
  const input = JSON.parse(readFileSync(process.env.SHORTS_TEST_CLEANUP_INPUT));
  for (const [id, key] of Object.entries(input.config.objects.keys))
    input.config.objects.keys[id] = Buffer.from(key, 'base64');
  const db = new DataSource(input.loginOptions);
  await db.initialize();
  const objects = new ShortsPrivateObjectsService(input.config.objects);
  const storage = new ShortsPrivateVersionStorageService(input.config);
  const retention = new ShortsRetentionService(db, input.config);
  const inspection = new ShortsStorageReconciliationService(
    db,
    input.config,
    retention,
    new ShortsSourceReaderService(objects),
    objects,
  );
  const coordinator = new ShortsPrivateVersionCleanupService(
    db,
    input.config,
    objects,
    storage,
    inspection,
    retention,
  );
  await coordinator.verify();
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    const target = new URL(url);
    if (
      options?.method === 'DELETE' &&
      target.origin === input.config.storage.endpoint &&
      target.searchParams.get('versionId') === input.candidate
    ) {
      if (response.status !== 204)
        throw Error('Owned deletion was not accepted');
      await response.body?.cancel();
      process.exit(73);
    }
    return response;
  };
  await coordinator.reclaim(input.operation, input.scan, input.identity);
  throw Error('Worker failed to reach its crash boundary');
})().catch(() => {
  process.stderr.write(
    'Cleanup crash fixture failed before its intended boundary\n',
  );
  process.exitCode = 1;
});
