const { isAbsolute, join } = require('node:path');

function ingestRoot() {
  const root = process.env.SHORTS_TEST_INGEST_ROOT;
  if (!root || !isAbsolute(root)) throw new Error('Set SHORTS_TEST_INGEST_ROOT to the built superhero-shorts/ingest-worker checkout.');
  return root;
}

exports.workerConfig = () => require(join(ingestRoot(), 'dist/shorts/shorts-worker.config')).shortsWorkerConfig;
exports.workerFixture = () => join(ingestRoot(), 'test/fixtures/ingest.cjs');
exports.ingestRoot = ingestRoot;
