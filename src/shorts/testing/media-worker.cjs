// Disposable integration worker with production Nest wiring and a restricted DB
// login. Safety defaults to a fixture; real moderation is explicit and loopback-only.
require('reflect-metadata');
const { runtimeRequire, runtimeEvidence } = require('./fixture-runtime.cjs');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { ShortsEncodingService } = runtimeRequire('../shorts-encoding.service');
const { ShortsSafetyService } = runtimeRequire('../shorts-safety.service');
const { SHORTS_WORKER_CONFIG, shortsWorkerConfig } = runtimeRequire('../shorts-worker.config');
(async () => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const config = await shortsWorkerConfig();
  const { ShortsWorkerModule } = runtimeRequire('../shorts-worker.module');
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^shorts_(worker|assembled)_[a-f0-9]+$/.test(process.env.SHORTS_TEST_SCHEMA)) throw new Error('Isolated test database required');
  const db = new DataSource({ type: 'postgres', url: url.href, schema: process.env.SHORTS_TEST_SCHEMA,
    extra: { options: `-c search_path=${process.env.SHORTS_TEST_SCHEMA}` } }); await db.initialize();
  const builder = Test.createTestingModule({ imports: [ShortsWorkerModule] })
    .overrideProvider(DataSource).useValue(db)
    .overrideProvider(SHORTS_WORKER_CONFIG).useValue(config)
    .overrideProvider(ShortsEncodingService).useFactory({ inject: [runtimeRequire('../shorts-scratch.service').ShortsScratchService], factory: scratch => ({ encode: async (...args) => {
      process.send?.({ type: 'encoding', title: args[1] });
      if (process.env.SHORTS_TEST_PAUSE_ENCODING === '1') await new Promise(() => {});
      return new ShortsEncodingService(scratch).encode(...args);
    } }) });
  if (process.env.SHORTS_TEST_REAL_MODERATION === '1') {
    const endpoint = new URL(process.env.SHORTS_MODERATION_URL);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Owned loopback moderation required');
  } else builder.overrideProvider(ShortsSafetyService).useValue({ demoAutoApprove: false, accepting: async () => true, scan: async video => ({ status: 'no_flags',
      sourceSha256: require('node:crypto').createHash('sha256').update(video).digest('hex'), checkedAt: Date.now(), humanReviewRequired: true,
      reason: 'Owned synthetic integration fixture' }) });
  const app = await builder.setLogger(false).compile();
  app.enableShutdownHooks(); await app.init();
  process.send?.({ type: 'started', runtime: runtimeEvidence() });
})().catch(error => { console.error(error); process.exit(1); });
