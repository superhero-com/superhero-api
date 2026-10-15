// Runs the separate, locally built streaming service unchanged for integration.
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
(async () => {
  const repo = process.env.SHORTS_TEST_STREAMING_REPO;
  assert.ok(isAbsolute(repo));
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).name, 'superhero-video-streaming');
  for (const name of ['STREAM_CATALOG_URL', 'STREAM_IPFS_API', 'STREAM_REDIS_URL'])
    assert.equal(new URL(process.env[name]).hostname, '127.0.0.1');
  const { createApp } = require(join(repo, 'dist/app.js'));
  const app = await createApp(false);
  await app.listen(process.env.STREAM_ROLE === 'worker' ? 0 : Number(process.env.PORT), '127.0.0.1');
  process.on('message', async message => {
    if (message?.action !== 'stop') throw new Error('Unsupported fixture command');
    await app.close(); process.send?.({ type: 'stopped' }); process.disconnect();
  });
  process.send?.({ type: 'ready', base: await app.getUrl() });
})().catch(error => { console.error(error); process.exit(1); });
