require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('../shorts-metadata.service');

async function main() {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^shorts_metadata_[a-f0-9]+$/.test(process.env.SHORTS_TEST_PG_SCHEMA))
    throw new Error('Only disposable local fixtures are allowed');
  const db = new DataSource({ type: 'postgres', url: url.href,
    extra: { options: `-c search_path=${process.env.SHORTS_TEST_PG_SCHEMA}`, max: 1 } });
  await db.initialize();
  const service = new ShortsMetadataService(db);
  const job = await service.claim(JSON.parse(process.env.SHORTS_TEST_PG_SCOPE), 1000);
  process.send({ job });
  process.on('message', async () => { await db.destroy(); process.exit(0); });
}
main().catch(error => { process.stderr.write(error.message); process.exit(1); });
