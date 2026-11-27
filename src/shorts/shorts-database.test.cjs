require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsDatabaseService, shortsDatabaseLimits } = require('./shorts-database.service');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, overrides = {}) {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_db_${randomUUID().replaceAll('-', '')}`;
  const source = new DataSource({ type: 'postgres', url: url.href,
    extra: { max: 1, options: `-c search_path=${schema}` } });
  await source.initialize(); await source.query(`CREATE SCHEMA ${schema}`);
  await source.query('CREATE TABLE saved (id integer PRIMARY KEY)');
  const database = new ShortsDatabaseService(source, { concurrency: 2, connectMs: 150,
    statementMs: 500, lockMs: 150, operationMs: 1200, ...overrides });
  t.after(async () => { await database.onModuleDestroy();
    await source.query(`DROP SCHEMA ${schema} CASCADE`); await source.destroy(); });
  await database.onModuleInit();
  return { source, database };
}
const pg = { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 20000 };

test('database concurrency configuration is finite and cannot disable admission', () => {
  const old = process.env.SHORTS_DB_CONCURRENCY;
  try {
    for (const value of ['0', '17', '1.5', 'Infinity', '-1', '1e1']) {
      process.env.SHORTS_DB_CONCURRENCY = value; assert.throws(shortsDatabaseLimits);
    }
    delete process.env.SHORTS_DB_CONCURRENCY; assert.equal(shortsDatabaseLimits().concurrency, 4);
  } finally { if (old === undefined) delete process.env.SHORTS_DB_CONCURRENCY; else process.env.SHORTS_DB_CONCURRENCY = old; }
});

test('Shorts uses an isolated bounded pool; saturation rejects promptly without blocking the main API', pg, async t => {
  const { source, database } = await fixture(t);
  const hold = deferred(), started = deferred(); let count = 0;
  const jobs = [1, 2].map(() => database.transaction(async db => {
    await db.query('SELECT 1'); if (++count === 2) started.resolve(); await hold.promise;
  }));
  const settled = Promise.allSettled(jobs); await started.promise;
  try {
    await assert.rejects(database.query('INSERT INTO saved VALUES(1)'), { status: 503 });
    assert.equal((await source.query('SELECT 1 AS live'))[0].live, 1);
    assert.equal(database.active.size, 2);
  } finally { hold.resolve(); await settled; }
  assert.deepEqual(await database.query('SELECT * FROM saved'), []);
  assert.equal(database.active.size, 0); assert.ok(source.isInitialized);
});

test('SQL lock waits and statements expire, roll back all writes and leave the pool reusable', pg, async t => {
  const { source, database } = await fixture(t);
  const lock = source.createQueryRunner(); await lock.connect(); await lock.startTransaction();
  await lock.query('LOCK TABLE saved IN ACCESS EXCLUSIVE MODE');
  try { await assert.rejects(database.query('INSERT INTO saved VALUES(1)'), { status: 503 }); }
  finally { await lock.rollbackTransaction(); await lock.release(); }
  await assert.rejects(database.transaction(async db => {
    await db.query('INSERT INTO saved VALUES(2)'); await db.query('SELECT pg_sleep(2)');
  }), { status: 503 });
  assert.deepEqual(await database.query('SELECT * FROM saved'), []);
  await database.query('INSERT INTO saved VALUES(3)');
  assert.deepEqual(await source.query('SELECT * FROM saved'), [{ id: 3 }]);
});

test('whole-operation expiry closes its socket and blocks late callback SQL or commits', pg, async t => {
  const { source, database } = await fixture(t, { operationMs: 180 });
  const hold = deferred(), late = deferred(); let manager;
  const result = database.transaction(async db => {
    manager = db; await db.query('INSERT INTO saved VALUES(1)'); await hold.promise;
    try { await db.query('INSERT INTO saved VALUES(2)'); }
    catch (error) { late.resolve(error); throw error; }
  });
  await assert.rejects(result, { status: 503 });
  hold.resolve(); assert.equal((await late.promise).status, 503);
  assert.ok(manager.queryRunner.isReleased);
  assert.deepEqual(await source.query('SELECT * FROM saved'), []);
  assert.equal(database.active.size, 0);
  assert.equal((await database.query('SELECT 1 AS live'))[0].live, 1);
});

test('socket closure stops server execution even when a statement timeout has been overridden', pg, async t => {
  const { source, database } = await fixture(t, { operationMs: 300 }); let pid;
  const result = database.transaction(async db => {
    pid = (await db.query('SELECT pg_backend_pid() AS pid'))[0].pid;
    await db.query('SET LOCAL statement_timeout=0');
    await db.query('SELECT pg_sleep(30)');
  });
  await assert.rejects(result, { status: 503 }); assert.ok(pid);
  let rows;
  for (let i = 0; i < 40; i++) {
    rows = await source.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid]);
    if (!rows.length) break; await wait(100);
  }
  assert.equal(rows.length, 0, 'PostgreSQL must observe the closed socket, not continue for 30 seconds');
});

test('an uncertain commit stays committed and is never automatically resubmitted', pg, async t => {
  const { source, database } = await fixture(t, { operationMs: 180 });
  const create = database.createQueryRunner.bind(database); let commits = 0;
  database.createQueryRunner = (...args) => {
    const runner = create(...args), commit = runner.commitTransaction.bind(runner);
    runner.commitTransaction = async () => { await commit(); commits++; await new Promise(() => {}); };
    return runner;
  };
  await assert.rejects(database.query('INSERT INTO saved VALUES(7)'), { status: 503 });
  assert.equal(commits, 1); assert.deepEqual(await source.query('SELECT * FROM saved'), [{ id: 7 }]);
  database.createQueryRunner = create;
  assert.deepEqual(await database.query('SELECT * FROM saved'), [{ id: 7 }]);
});

test('shutdown rejects new work, cancels active SQL and preserves the primary DataSource', pg, async t => {
  const { source, database } = await fixture(t); const started = deferred();
  const pending = database.transaction(async db => { started.resolve(); await db.query('SELECT pg_sleep(20)'); });
  const result = assert.rejects(pending, { status: 503 }); await started.promise;
  await database.onModuleDestroy(); await result;
  await assert.rejects(database.query('SELECT 1'), { status: 503 });
  assert.ok(source.isInitialized); assert.equal(database.active.size, 0);
  assert.equal((await source.query('SELECT 1 AS live'))[0].live, 1);
});

test('shutdown during bounded pool acquisition releases a connection arriving after cancellation', pg, async t => {
  const { source, database } = await fixture(t, { concurrency: 1 });
  const held = database.createQueryRunner(); await held.connect();
  const job = database.query('INSERT INTO saved VALUES(1)'); const result = assert.rejects(job, { status: 503 });
  await wait(10); const closing = database.onModuleDestroy();
  await held.release(); await closing; await result;
  assert.equal(database.active.size, 0); assert.deepEqual(await source.query('SELECT * FROM saved'), []);
});

test('pool acquisition timeout never executes its abandoned write when a connection becomes free', pg, async t => {
  const { source, database } = await fixture(t, { concurrency: 1 });
  const held = database.createQueryRunner(); await held.connect();
  try { await assert.rejects(database.query('INSERT INTO saved VALUES(1)'), { status: 503 }); }
  finally { await held.release(); }
  assert.equal(database.active.size, 0);
  assert.deepEqual(await database.query('SELECT * FROM saved'), []);
  assert.deepEqual(await source.query('SELECT * FROM saved'), []);
});

test('Nest metadata services share the dedicated pool and preserve active transaction ownership', pg, async t => {
  const { source } = await fixture(t);
  const { Module, Global } = require('@nestjs/common'); const { Test } = require('@nestjs/testing');
  const { ShortsMetadataModule } = require('./shorts-metadata.module');
  const { ShortsMetadataService } = require('./shorts-metadata.service');
  const { ShortsSessionsService } = require('./shorts-sessions.service');
  class Database {} Global()(Database); Module({ providers: [{ provide: DataSource, useValue: source }], exports: [DataSource] })(Database);
  const app = await Test.createTestingModule({ imports: [Database, ShortsMetadataModule] }).compile();
  t.after(() => app.close()); await app.init();
  const database = app.get(ShortsDatabaseService);
  assert.notEqual(database, source); assert.equal(app.get(ShortsMetadataService).db, database);
  assert.equal(app.get(ShortsSessionsService).db, database);
  await database.transaction('REPEATABLE READ', async manager => {
    assert.equal(manager.connection, database); assert.ok(manager.queryRunner.isTransactionActive);
    assert.equal((await manager.query('SHOW transaction_isolation'))[0].transaction_isolation, 'repeatable read');
    assert.equal((await manager.query('SHOW statement_timeout'))[0].statement_timeout, '15s');
  });
});
