require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ShortsPublicationBoundaryService } = require('../shorts-publication-boundary.service');
const { ShortsPublisherService } = require('../shorts-publisher.service');

async function main() {
  const url = new URL(process.env.SHORTS_TEST_PG_URL), schema = process.env.SHORTS_TEST_PG_SCHEMA;
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^shorts_publisher_authority_[a-f0-9]+$/.test(schema))
    throw new Error('Only disposable local fixtures are allowed');
  const db = new DataSource({ type: 'postgres', url: url.href, extra: { options: `-c search_path=${schema}`, max: 2 } });
  await db.initialize();
  const config = JSON.parse(process.env.SHORTS_TEST_PUBLISHER_CONFIG);
  const node = {
    async verify() {}, async existing() {},
    async prepare() { return { rawTransaction: process.env.SHORTS_TEST_SIGNED_TRANSACTION, accountNonce: 0, height: 100 }; },
    async observe() { return { state: 'absent' }; }, async canBroadcast() { return true; },
    async broadcast(rawTransaction, transactionHash) {
      process.send({ submitted: true, rawTransaction, transactionHash });
      await new Promise(() => {}); // Parent kills this process before a response.
    },
  };
  const runner = new ShortsPublisherService(config, new ShortsPublicationBoundaryService(db), node);
  await runner.onApplicationBootstrap();
}
main().catch(() => { process.stderr.write('Disposable publisher failed'); process.exit(1); });
