// Full hosted feature wiring for disposable loopback integration tests.
// Only external chain reads are controlled; no signer or real chain is used.
require('reflect-metadata');
const { runtimeRequire, runtimeEvidence } = require('./fixture-runtime.cjs');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { Global, Module } = require('@nestjs/common');

(async () => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  const schema = process.env.SHORTS_TEST_SCHEMA;
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(schema, /^shorts_assembled_[a-f0-9]+$/);
  const manifest = JSON.parse(await readFile(process.env.SHORTS_DEPLOYMENT_FILE, 'utf8'));
  const db = await new DataSource({ type: 'postgres', url: url.href, schema,
    extra: { options: `-c search_path=${schema}`, max: 4 } }).initialize();
  class DatabaseModule {}
  Global()(DatabaseModule);
  Module({ providers: [{ provide: DataSource, useValue: db }], exports: [DataSource] })(DatabaseModule);
  const { ShortsFeatureModule } = runtimeRequire('../shorts-feature.module');
  const { ShortsChainService } = runtimeRequire('../shorts-chain.service');
  const { ShortsWorkQueueService } = runtimeRequire('../shorts-work-queue.service');
  const { ShortsStoreService } = runtimeRequire('../shorts-store.service');
  const { ShortsService } = runtimeRequire('../shorts.service');
  const { ShortsHostingService } = runtimeRequire('../shorts-hosting.service');
  const { ShortsGateway } = runtimeRequire('../shorts.gateway');
  const { ShortsStreamingService } = runtimeRequire('../shorts-streaming.service');
  const chainState = async () => JSON.parse(await readFile(join(dirname(process.env.SHORTS_DEPLOYMENT_FILE), 'chain.json'), 'utf8'));
  const social = await require('./assembled-social.cjs').socialRuntime(db);
  const module = await Test.createTestingModule({ imports: [DatabaseModule, ...social.imports, ShortsFeatureModule.register()] })
    .overrideProvider(ShortsChainService).useFactory({ inject: [ShortsWorkQueueService], factory: work => ({
      release: manifest,
      state: { ...manifest, shorts: [], receipts: [] }, sharedReceipts: true,
      // This offline fixture never encodes a contract call. Supply the metadata
      // normally loaded by ShortsChainService so the real config endpoint runs.
      artifact: { aci: [], bytecodeHash: manifest.sourceHash },
      contract: { $options: { address: manifest.contract } }, operator: { address: manifest.operator },
      address: value => value, serial: callback => work.run(callback),
      account: async address => ({ address, wallet: '100', available: '0', earned: '0', claimed: '0', previousAvailable: '0' }),
      sdk: { getContext: () => ({ onNode: social.node }), api: {
        $host: manifest.node,
        getCurrentKeyBlock: async () => ({ height: (await chainState()).height }),
        getGenerationByHeight: async height => ({ keyBlock: { height, hash: (await chainState()).keyHash }, microBlocks: [] }),
        getStatus: async () => ({ networkId: 'ae_uat' }),
      } },
      readNode: async callback => callback(),
      async read(method, args) {
        if (method === 'get_short') return (await chainState()).shorts[args[0]];
        if (method === 'has_liked') return !!(await chainState()).shorts[args[1]]?.likers?.includes(args[0]);
        if (method === 'get_config') return {};
        throw new Error(`Unexpected chain read in offline fixture: ${method}`);
      },
      write: () => assert.fail('Hosted API must not sign or write to a chain'),
    }) }).setLogger(false).compile();
  const app = module.createNestApplication({ logger: false });
  app.enableShutdownHooks(); await app.listen(0, '127.0.0.1');
  assert.equal(app.get(ShortsStoreService).shared, true);
  assert.throws(() => app.get(ShortsStoreService).db, /unavailable/);
  const shorts = app.get(ShortsService);
  assert.equal(shorts.auth.shared, true); assert.equal(shorts.records.shared, true);
  assert.equal(shorts.media.admission.constructor.name, 'ShortsMediaAdmissionService');
  process.on('message', async message => {
    try {
      if (message?.action === 'listener') {
        const [row] = await app.get(ShortsGateway).runner.query('SELECT pg_backend_pid() AS pid');
        process.send?.({ type: 'command', id: message.id, pid: row.pid }); return;
      }
      if (message?.action === 'social-notify') {
        await app.get(social.gateway).changed(message.scope, message.accounts);
      } else if (message?.action === 'social-listener') {
        const runner = app.get(social.gateway).runner;
        const rows = runner ? await runner.query('SELECT pg_backend_pid() AS pid') : [];
        process.send?.({ type: 'command', id: message.id, pid: rows[0]?.pid }); return;
      } else if (message?.action === 'social-disconnect') {
        for (const socket of app.get(social.gateway).server.sockets.sockets.values()) socket.conn.close();
      } else if (message?.action === 'dispatch') await app.get(ShortsStreamingService).dispatch();
      else if (message?.action === 'reconcile') await app.get(ShortsHostingService).reconcile();
      else if (message?.action === 'stop') { await app.close(); await db.destroy(); process.send?.({ type: 'stopped' }); process.disconnect(); return; }
      else throw new Error('Unsupported fixture command');
      process.send?.({ type: 'command', id: message.id });
    } catch (error) { process.send?.({ type: 'command', id: message.id, error: error.message }); }
  });
  process.send?.({ type: 'ready', base: await app.getUrl(), runtime: runtimeEvidence() });
})().catch(error => { console.error(error); process.exit(1); });
