require('reflect-metadata');
const { DataSource } = require('typeorm');
const { ShortsPublicationsService } = require('../shorts-publications.service');

async function main() {
  const url = new URL(process.env.SHORTS_TEST_PG_URL), schema = process.env.SHORTS_TEST_PG_SCHEMA;
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^shorts_publications_[a-f0-9]+$/.test(schema))
    throw new Error('Only disposable local fixtures are allowed');
  const db = new DataSource({ type: 'postgres', url: url.href, extra: { options: `-c search_path=${schema}`, max: 1 } });
  await db.initialize();
  const journal = new ShortsPublicationsService(db), scope = JSON.parse(process.env.SHORTS_TEST_PG_SCOPE);
  const claim = await journal.claim(scope);
  await journal.persistSigned(scope, claim, process.env.SHORTS_TEST_SIGNED_TRANSACTION, 0, 100);
  process.send({ committed: true, claim });
  process.on('message', async () => { await db.destroy(); process.exit(0); });
}
main().catch(error => { process.stderr.write(error.message); process.exit(1); });
