// Runs affected V1/V2 suites using a new loopback-only PostgreSQL cluster.
// No application .env or existing database is read. The cluster is removed on exit.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { spawn } = require('node:child_process');
const { statfsSync } = require('node:fs');
const { findPostgresBinDir, startPostgres } = require('../reward-e2e/postgres');

(async () => {
  const disk = statfsSync(require('node:os').tmpdir());
  if (disk.bavail * disk.bsize < 5 * 1024 ** 3)
    throw new Error('5 GiB disk guard');
  const bin = findPostgresBinDir();
  if (!bin) throw new Error('PostgreSQL binaries required');
  const pg = await startPostgres(bin);
  const url = new URL(pg.url);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: '/dev/null',
    DB_TYPE: 'postgres',
    DB_HOST: '127.0.0.1',
    DB_PORT: url.port,
    DB_USER: 'postgres',
    DB_PASSWORD: '',
    DB_DATABASE: 'postgres',
    TG_TEST_DB_ADMIN_DATABASE: 'postgres',
    DB_SYNC: 'false',
    DB_LOGGING: 'false',
    SOCIAL_GRAPH_V2_WORKER_ENABLED: 'false',
    SOCIAL_GRAPH_V2_SCALE_TEST: 'true',
  };
  let child;
  const stop = () => {
    child?.kill('SIGTERM');
    pg.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    child = spawn(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--runInBand',
        'src/plugins/social-graph',
        'src/notifications',
        'src/utils',
        'src/ae/websocket.service.spec.ts',
        '--json',
        '--outputFile=docs/evidence/social-graph-v2-jest-results.json',
      ],
      { env, stdio: 'inherit' },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    pg.stop();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
