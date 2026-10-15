const { ShortsMediaAdmission1791763225000 } = require('../migrations/1791763225000-ShortsMediaAdmission');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { DataSource } = require('typeorm');
const {
  ShortsMetadata1791763200000,
} = require('../migrations/1791763200000-ShortsMetadata');
const {
  ShortsLifecycle1791763213000,
} = require('../migrations/1791763213000-ShortsLifecycle');
const {
  ShortsLifecycleJobsService,
} = require('./shorts-lifecycle-jobs.service');
const {
  ShortsHostedHostingService,
} = require('./shorts-hosted-hosting.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { ShortsService } = require('./shorts.service');
const { ShortsController } = require('./shorts.controller');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scope = { network: 'ae_uat', contract: 'ct_lifecycle' };
const hash = 'a'.repeat(64);
const item = (id, overrides = {}) => ({
  id,
  creator: 'ak_creator',
  cid: `bafy${id}`,
  bytes: 10,
  duration: 2,
  createdAt: 1,
  files: [],
  moderation: 'approved',
  safety: { status: 'no_flags' },
  publication: 'published',
  ...overrides,
});
const assertNo = () =>
  assert.fail(
    'hosted lifecycle must not enumerate the library, inspect all pins or delete storage',
  );

function workerFixture(records, options = {}) {
  const effects = [],
    results = [];
  let index = 0;
  const claims = records.map((r) => ({
    id: r.id,
    token: randomUUID(),
    generation: '1',
    fence: '1',
  }));
  const chain = {
    release: { network: 'ae_uat', contract: scope.contract },
    state: { contract: scope.contract, sourceHash: hash },
    serial: () => assert.fail('Hosted lifecycle must not hold the local mutation queue'),
    read: async (_method, [id]) => {
      const s = records.find((r) => r.id === id);
      return options.video
        ? options.video(s)
        : { creator: s.creator, cid: s.cid, size: s.bytes, withdrawn: false };
    },
  };
  const registry = {
    shared: true,
    all: assertNo,
    get: async (id) => structuredClone(records.find((r) => r.id === id)),
  };
  const jobs = {
    verify: async () => {},
    claim: async () => claims[index++],
    renew: async () => true,
    settle: async (_s, c, r) => {
      results.push([c.id, r]);
      return true;
    },
  };
  const media = {
    pins: assertNo,
    unpin: assertNo,
    pinned: async () => false,
    pin: async (s) => effects.push(['pin', s.id]),
    ensurePinned: async (short, signal) => media.pin(short, signal),
  };
  const shorts = {
    demoAutoApprove: false,
    matchesPublication: ShortsService.prototype.matchesPublication,
    publisher: {
      status: async () => options.job,
      capacity: async () => true,
      enqueue: async (id) => effects.push(['enqueue', id]),
    },
    publish: () => assert.fail('Recovery must not re-enter the HTTP publication path'),
    publication: async (_creator, id) => effects.push(['project', id]),
    retryInspection: async (id) => effects.push(['scan', id]),
  };
  return {
    worker: new ShortsHostedHostingService(
      chain,
      media,
      shorts,
      registry,
      jobs,
      options.limits,
    ),
    chain,
    registry,
    jobs,
    media,
    shorts,
    effects,
    results,
  };
}

test('hosted recovery bounds each pass, coalesces calls and never auto-publishes private/denied content', async () => {
  const records = [
    item('draft', { publication: undefined }),
    item('denied', { moderation: 'rejected' }),
    item('withdrawn', { publication: 'withdrawn' }),
    item('error', {
      moderation: 'pending',
      safety: { status: 'error', checkedAt: 1 },
    }),
    ...Array.from({ length: 15 }, (_, n) => item(`live${n}`)),
  ];
  const f = workerFixture(records);
  const first = f.worker.reconcile();
  assert.equal(first, f.worker.reconcile());
  await first;
  assert.equal(f.results.length, 10);
  assert.equal(f.effects.filter((e) => e[0] === 'pin').length, 6);
  assert.deepEqual(
    f.effects.filter((e) => e[0] === 'scan'),
    [['scan', 'error']],
  );
  assert.equal(
    f.effects.some((e) => e[0] === 'publish'),
    false,
  );
  assert.deepEqual(
    f.results.find((r) => r[0] === 'withdrawn'),
    ['withdrawn', 'retention_pending'],
  );
  await f.worker.reconcile();
  assert.equal(f.results.length, 19);
  await f.worker.onModuleDestroy();
  await f.worker.reconcile();
  assert.equal(f.results.length, 19);
});

test('publication recovery reuses the journal and separates unknown or reverted outcomes', async (t) => {
  for (const status of [
    undefined,
    'queued',
    'signed',
    'confirmed',
    'reconciled',
    'reverted',
    'cancelled',
  ])
    await t.test(String(status), async () => {
      const f = workerFixture([item('pending', { publication: 'pending' })], {
        job: status ? { status } : undefined,
      });
      await f.worker.reconcile();
      assert.deepEqual(
        f.effects,
        status === undefined
          ? [['pin', 'pending'], ['enqueue', 'pending']]
          : ['confirmed', 'reconciled'].includes(status)
            ? [['project', 'pending']]
            : [],
      );
      assert.equal(
        f.results[0][1],
        ['cancelled', 'reverted'].includes(status)
          ? 'reconciliation_required'
          : 'publication_pending',
      );
    });
  const f = workerFixture([item('missing')], { video: () => undefined });
  await f.worker.reconcile();
  assert.deepEqual(f.effects, []);
  assert.equal(f.results[0][1], 'reconciliation_required');
});

test('storage, identity, policy, shutdown and lease failures cannot cause stale repair or deletion', async (t) => {
  await t.test('unavailable pin check', async () => {
    const f = workerFixture([item('a')]);
    f.media.pinned = async () => {
      throw new Error('Unavailable');
    };
    await f.worker.reconcile();
    assert.deepEqual(f.effects, []);
    assert.equal(f.results[0][1], 'failed');
  });
  await t.test('wrong chain identity', async () => {
    const f = workerFixture([item('a')], {
      video: () => ({ creator: 'ak_other', cid: 'bafya', size: 10 }),
    });
    await f.worker.reconcile();
    assert.deepEqual(f.effects, []);
    assert.equal(f.results[0][1], 'failed');
  });
  await t.test('review revoked during pin check', async () => {
    const record = item('a');
    const f = workerFixture([record]);
    f.media.pinned = async () => {
      record.moderation = 'rejected';
      return false;
    };
    await f.worker.reconcile();
    assert.deepEqual(f.effects, []);
  });
  await t.test('lease replaced during pin check', async () => {
    const f = workerFixture([item('a')]);
    f.media.pinned = async () => {
      f.jobs.renew = async () => false;
      return false;
    };
    await f.worker.reconcile();
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.results, []);
  });
  await t.test('shutdown while node read is in flight', async () => {
    const f = workerFixture([item('a')]);
    let finish;
    f.chain.read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const work = f.worker.reconcile();
    while (!finish) await pause(1);
    const stop = f.worker.onModuleDestroy();
    finish({ creator: 'ak_creator', cid: 'bafya', size: 10 });
    await work;
    await stop;
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.results, []);
  });
});

test(
  'durable lifecycle PostgreSQL queue: bounded claims, generation fences, locked expiry and killed-worker recovery',
  { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 },
  async (t) => {
    const url = process.env.SHORTS_TEST_PG_URL;
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
      throw new Error('Isolated loopback PostgreSQL required');
    const schema = `shorts_lifecycle_${randomUUID().replaceAll('-', '')}`;
    const admin = await new DataSource({ type: 'postgres', url }).initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = {
      type: 'postgres',
      url,
      extra: { options: `-c search_path=${schema}`, max: 4 },
    };
    const a = await new DataSource(options).initialize(),
      b = await new DataSource(options).initialize();
    t.after(async () => {
      await a.destroy();
      await b.destroy();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.destroy();
    });
    const migration = new ShortsLifecycle1791763213000();
    await new ShortsMetadata1791763200000().up(a);
    await a.query(`INSERT INTO shorts_runtime VALUES($1,$2,$3,NULL,50,5)`, [
      scope.network,
      scope.contract,
      hash,
    ]);
    const insert = async (id) =>
      a.query(
        'INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
        [scope.network, scope.contract, id, 'ak_creator', item(id)],
      );
    for (let i = 0; i < 125; i++)
      await insert(`short${String(i).padStart(3, '0')}`);
    await migration.up(a);
    await new ShortsMediaAdmission1791763225000().up(a);
    const jobs = new ShortsLifecycleJobsService(a),
      other = new ShortsLifecycleJobsService(b);
    await jobs.verify(scope, hash);
    await assert.rejects(jobs.verify(scope, 'b'.repeat(64)), /mismatch/);
    await t.test(
      'backfill and atomic concurrent claims include the complete catalog',
      async () => {
        const ids = new Set();
        for (let n = 0; n < 25; n++) {
          const claims = await Promise.all(
            Array.from({ length: 5 }, (_, i) =>
              (i % 2 ? jobs : other).claim(scope),
            ),
          );
          for (const c of claims) {
            assert.ok(c);
            assert.ok(!ids.has(c.id));
            ids.add(c.id);
            assert.equal(await jobs.settle(scope, c, 'checked'), true);
          }
        }
        assert.equal(ids.size, 125);
        assert.equal(await jobs.claim(scope), undefined);
        const health = await jobs.health(scope);
        assert.equal(health.total, 125);
        assert.equal(health.due, 0);
        assert.equal(health.active, 0);
        assert.ok(health.lastCheckedAt);
        assert.deepEqual(
          await jobs.health({ ...scope, contract: 'ct_absent' }),
          {
            total: 0,
            active: 0,
            due: 0,
            failed: 0,
            capacityWaiting: 0,
            retentionPending: 0,
            reconciliationRequired: 0,
            oldestDueSeconds: 0,
            lastCheckedAt: null,
          },
        );
        const [{ n }] = await a.query(
          "SELECT count(*) AS n FROM shorts_lifecycle_jobs WHERE result='checked' AND checked_at IS NOT NULL",
        );
        assert.equal(Number(n), 125);
        assert.equal(
          await other.claim({ ...scope, contract: 'ct_other' }),
          undefined,
        );
      },
    );
    await t.test(
      'changes enqueue atomically and invalidate stale generations while unrelated report fields do not',
      async () => {
        await insert('new');
        const old = await jobs.claim(scope);
        assert.equal((await jobs.health(scope)).active, 1);
        await a.query(
          "UPDATE shorts_content SET body=jsonb_set(body,'{reports}','1') WHERE id='new'",
        );
        assert.equal(await jobs.renew(scope, old), true);
        await a.query(
          "UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"rejected\"') WHERE id='new'",
        );
        assert.equal(await jobs.settle(scope, old, 'checked'), false);
        assert.equal(await jobs.renew(scope, old), false);
        const current = await other.claim(scope);
        assert.equal(current.id, old.id);
        assert.equal(current.generation, '2');
        assert.equal(current.fence, '2');
        assert.equal(await other.settle(scope, current, 'failed'), true);
        assert.equal(await jobs.claim(scope), undefined);
        const [row] = await a.query(
          "SELECT attempts,next_at>clock_timestamp() AS delayed FROM shorts_lifecycle_jobs WHERE id='new'",
        );
        assert.equal(row.attempts, 1);
        assert.equal(row.delayed, true);
        assert.equal((await jobs.health(scope)).failed, 1);
        await a.query(
          "UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()+interval '1 hour' WHERE id='new'",
        );
        const q = a.createQueryRunner();
        await q.connect();
        await q.startTransaction();
        await q.query(
          "UPDATE shorts_content SET body=jsonb_set(body,'{moderation}','\"approved\"') WHERE id='new'",
        );
        await q.rollbackTransaction();
        await q.release();
        assert.equal(await jobs.claim(scope), undefined);
        await a.query(
          "UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()-interval '30 seconds',result='retention_pending' WHERE id='short000'",
        );
        await a.query(
          "UPDATE shorts_lifecycle_jobs SET result='reconciliation_required' WHERE id='short001'",
        );
        const health = await jobs.health(scope);
        assert.equal(health.due, 1);
        assert.equal(health.retentionPending, 1);
        assert.equal(health.reconciliationRequired, 1);
        assert.ok(health.oldestDueSeconds >= 30);
        await jobs.settle(scope, await jobs.claim(scope), 'checked');
      },
    );
    await t.test(
      'renew and completion evaluate expiry after a blocking row lock',
      async () => {
        for (const action of ['renew', 'settle']) {
          const id = `locked${action}`;
          await insert(id);
          const claim = await jobs.claim(scope, 1000);
          const q = b.createQueryRunner();
          await q.connect();
          await q.startTransaction();
          await q.query(
            'SELECT id FROM shorts_lifecycle_jobs WHERE id=$1 FOR UPDATE',
            [id],
          );
          const pending =
            action === 'renew'
              ? jobs.renew(scope, claim)
              : jobs.settle(scope, claim, 'checked');
          await pause(1150);
          await q.commitTransaction();
          await q.release();
          assert.equal(await pending, false);
          const replacement = await other.claim(scope);
          assert.equal(replacement.id, id);
          assert.equal(replacement.fence, '2');
          await other.settle(scope, replacement, 'checked');
        }
      },
    );
    await t.test('retry inspection preserves its live generation during IO and rejects superseded evidence', async t => {
      const { ShortsMetadataService } = require('./shorts-metadata.service');
      const { ShortsRecordsService } = require('./shorts-records.service');
      const { ShortsDatabaseService } = require('./shorts-database.service');
      const db = new ShortsDatabaseService(a); await db.onModuleInit(); t.after(() => db.onModuleDestroy());
      const metadata = new ShortsMetadataService(db), boundedJobs = new ShortsLifecycleJobsService(db);
      const chain = { release: { network: 'ae_uat', contract: scope.contract  }, state: { contract: scope.contract } }, records = new ShortsRecordsService(chain, metadata);
      for (const mode of ['success', 'review', 'cancel', 'locked-cancel']) {
        const id = 'retry-' + mode;
        const short = item(id, { publication: 'pending', moderation: 'pending', safety: undefined,
          title: 'Fixture', topic: 'Art', files: [{ name: 'video.mp4', bytes: 10, sha256: 'a'.repeat(64) }] });
        await a.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
          [scope.network, scope.contract, id, 'ak_creator', short]);
        const claim = await boundedJobs.claim(scope); assert.equal(claim.id, id);
        const entered = gate(), finish = gate(), stop = new AbortController();
        const media = { async rescan(_short, signal) { assert.equal(signal, stop.signal); entered.resolve(); await finish.promise;
          return { status: 'no_flags', checkedAt: Date.now(), reason: 'Owned fixture' }; } };
        const service = new ShortsService(chain, media, undefined, undefined, undefined, undefined, undefined, undefined, records);
        const operation = service.retryInspection(id, stop.signal);
        const outcome = mode === 'success' ? operation : assert.rejects(operation);
        await entered.promise;
        assert.equal(await boundedJobs.renew(scope, claim), true, 'retry must not invalidate its own lease before scanning');
        let q;
        if (mode === 'review') await metadata.change(scope, id, r => { r.moderation = 'rejected'; r.reviewReason = 'New decision'; });
        if (mode === 'cancel') stop.abort();
        if (mode === 'locked-cancel') {
          q = b.createQueryRunner(); await q.connect(); await q.startTransaction();
          await q.query('SELECT id FROM shorts_content WHERE id=$1 FOR UPDATE', [id]);
        }
        try {
          finish.resolve();
          if (q) { await pause(35); stop.abort(); await q.commitTransaction(); }
          await outcome;
        } finally { if (q) { if (q.isTransactionActive) await q.rollbackTransaction(); await q.release(); } }
        const saved = await records.get(id);
        if (mode === 'success') {
          assert.equal(saved.safety.status, 'no_flags'); assert.equal(saved.moderation, 'pending');
          assert.equal(await boundedJobs.renew(scope, claim), false, 'final evidence deliberately schedules a new generation');
        } else {
          assert.equal(saved.safety, undefined);
          assert.equal(saved.moderation, mode === 'review' ? 'rejected' : 'pending');
        }
        await a.query("UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [id]);
      }
    });
    await t.test(
      'SIGKILL leaves a claim recoverable by another database pool',
      async () => {
        await insert('killed');
        const code = `const {DataSource}=require('typeorm');const {ShortsLifecycleJobsService}=require('./src/shorts/shorts-lifecycle-jobs.service');(async()=>{const db=await new DataSource(JSON.parse(process.env.SHORTS_CHILD_DB)).initialize();const c=await new ShortsLifecycleJobsService(db).claim(JSON.parse(process.env.SHORTS_CHILD_SCOPE),1000);process.stdout.write(JSON.stringify(c)+'\\n');setInterval(()=>{},1000);})().catch(e=>{process.stderr.write(e.message);process.exit(1);});`;
        const child = spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register',
            '-r',
            'tsconfig-paths/register',
            '-e',
            code,
          ],
          {
            env: {
              ...process.env,
              SHORTS_CHILD_DB: JSON.stringify(options),
              SHORTS_CHILD_SCOPE: JSON.stringify(scope),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        t.after(() => child.kill('SIGKILL'));
        let stderr = '';
        child.stderr.on('data', (b) => {
          stderr += b.toString();
        });
        const claim = await new Promise((resolve, reject) => {
          let data = '';
          child.stdout.on('data', (b) => {
            data += b.toString();
            if (data.includes('\n')) resolve(JSON.parse(data.split('\n')[0]));
          });
          child.once('exit', (code) =>
            reject(new Error(`child ${code}: ${stderr}`)),
          );
        });
        assert.equal(claim.id, 'killed');
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
        await pause(1150);
        const replacement = await other.claim(scope);
        assert.equal(replacement.id, 'killed');
        assert.equal(replacement.fence, '2');
        assert.equal(await jobs.settle(scope, claim, 'checked'), false);
        await other.settle(scope, replacement, 'checked');
      },
    );
    await t.test(
      'delete cascades and rollback removes only lifecycle schema',
      async () => {
        await a.query("DELETE FROM shorts_content WHERE id='killed'");
        assert.equal(
          (
            await a.query(
              "SELECT id FROM shorts_lifecycle_jobs WHERE id='killed'",
            )
          ).length,
          0,
        );
        await migration.down(a);
        assert.equal(
          (await a.query('SELECT count(*) FROM shorts_content'))[0].count,
          '132',
        );
        await migration.up(a);
        assert.equal(
          (await a.query('SELECT count(*) FROM shorts_lifecycle_jobs'))[0]
            .count,
          '132',
        );
      },
    );
  },
);

test('targeted pin inspection rejects ambiguous errors and bounded-body failures', async (t) => {
  const media = new ShortsMediaService({});
  let reply = () =>
    new Response(JSON.stringify({ Keys: { bafyone: { Type: 'recursive' } } }));
  t.mock.method(media, 'ipfsFetch', async (path, options) => {
    assert.equal(path, 'pin/ls?arg=bafyone&type=recursive');
    assert.ok(options.signal);
    return reply();
  });
  assert.equal(await media.pinned('bafyone'), true);
  reply = () =>
    new Response(
      JSON.stringify({ Code: 0, Message: "path 'bafyone' is not pinned" }),
      { status: 500 },
    );
  assert.equal(await media.pinned('bafyone'), false);
  for (const value of [
    { Code: 0, Message: 'node unavailable' },
    { Keys: { bafyother: { Type: 'recursive' } } },
    { Keys: { bafyone: { Type: 'indirect' } } },
    {},
  ]) {
    reply = () =>
      new Response(JSON.stringify(value), {
        status: value.Code === 0 ? 500 : 200,
      });
    await assert.rejects(media.pinned('bafyone'), /inspect/);
  }
  reply = () => new Response('x'.repeat(16385));
  await assert.rejects(media.pinned('bafyone'), /too large/);
  reply = () => new Response('{}', { headers: { 'content-length': '20000' } });
  await assert.rejects(media.pinned('bafyone'), /too large/);
  await assert.rejects(media.pinned('bad/cid'), /Invalid/);
  for (let i = 0; i < 300; i++) media.rememberPin(`cid${i}`);
  assert.equal(media.pinnedCids.size, 256);
});

test(
  'real offline Kubo reports absent, pinned and removed package identity without full inventory',
  { skip: !process.env.SHORTS_TEST_IPFS_API, timeout: 30000 },
  async (t) => {
    const saved = process.env.SHORTS_IPFS_API;
    process.env.SHORTS_IPFS_API = process.env.SHORTS_TEST_IPFS_API;
    t.after(() => {
      if (saved === undefined) delete process.env.SHORTS_IPFS_API;
      else process.env.SHORTS_IPFS_API = saved;
    });
    const media = new ShortsMediaService({});
    const files = [
      {
        name: 'video.mp4',
        data: Buffer.from(`owned lifecycle test ${randomUUID()}`),
      },
    ];
    const cid = await new ShortsPackageService().cid(files);
    assert.equal(await media.pinned(cid), false);
    const short = item(randomUUID(), {
      cid, privateMedia: {},
      files: files.map(file => ({ name: file.name, bytes: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') })),
    });
    let reads = 0, adds = 0;
    media.preparedFile = async () => { reads++; return files[0].data; };
    const add = media.add.bind(media);
    media.add = async (...args) => { adds++; return add(...args); };
    await media.ensurePinned(short);
    assert.equal(await media.pinned(cid), true);
    await media.ensurePinned(short);
    assert.equal(reads, 1, 'retry must not read private storage again');
    assert.equal(adds, 1, 'retry must verify and reuse the actual pin');
    await assert.rejects(media.ensurePinned({ ...short, files: [{ ...short.files[0], sha256: '0'.repeat(64) }] }), /integrity/);
    assert.equal(adds, 1); assert.equal(reads, 1);
    await media.unpin(cid);
    assert.equal(await media.pinned(cid), false);
  },
);

test('lifecycle monitoring authenticates an operator before reading private queue health', async () => {
  let reads = 0;
  const jobs = {
    health: async (value) => {
      assert.deepEqual(value, scope);
      reads++;
      return { due: 3 };
    },
  };
  const auth = {
    operator: async (token) => {
      if (token !== 'operator-session') throw new Error('Operator required');
    },
  };
  const shorts = { chain: { release: { network: 'ae_uat', contract: scope.contract  }, state: { contract: scope.contract } } };
  const controller = new ShortsController(shorts, auth, {}, jobs);
  await assert.rejects(
    controller.lifecycleHealth('creator-session'),
    /Operator required/,
  );
  assert.equal(reads, 0);
  assert.deepEqual(await controller.lifecycleHealth('operator-session'), {
    due: 3,
  });
  assert.equal(reads, 1);
  await assert.rejects(
    new ShortsController(shorts, auth, {}).lifecycleHealth('operator-session'),
    { status: 503 },
  );
});


function gate() {
  let resolve; const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function stalledPin(t) {
  const { createServer } = require('node:http');
  const entered = gate(), closed = gate();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
    entered.resolve(); res.on('close', closed.resolve);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const media = new ShortsMediaService({});
  media.api = `http://127.0.0.1:${server.address().port}/api/v0`;
  media.ipfsHeaders = async () => new Headers();
  media.preparedFile = async () => Buffer.from('fixture');
  return { media, entered, closed };
}

test('lifecycle shutdown cancels an actual IPFS add response and leaves its claim recoverable', { timeout: 5000 }, async t => {
  const io = await stalledPin(t), f = workerFixture([item('a', { files: [{ name: 'video.mp4' }] })]);
  f.media.pin = io.media.pin.bind(io.media);
  const work = f.worker.reconcile(); await io.entered.promise;
  await f.worker.onModuleDestroy(); await work; await io.closed.promise;
  assert.deepEqual(f.results, []); assert.equal(io.media.hasPin('bafya'), false);
});

test('failed renewal and whole-job deadline cancel IPFS work even while the process stays up', { timeout: 5000 }, async t => {
  for (const reason of ['renewal', 'deadline']) await t.test(reason, async t => {
    const io = await stalledPin(t), f = workerFixture([item('a', { files: [{ name: 'video.mp4' }] })], {
      limits: { attemptMs: reason === 'deadline' ? 180 : 1000, leaseMs: 700, renewMs: 30 },
    });
    f.media.pin = io.media.pin.bind(io.media);
    const work = f.worker.reconcile(); await io.entered.promise;
    if (reason === 'renewal') f.jobs.renew = async () => false;
    await work; await io.closed.promise;
    assert.deepEqual(f.results, []); assert.equal(io.media.hasPin('bafya'), false);
    await f.worker.onModuleDestroy();
  });
});

test('lease expiry closes media IO but a late renewal drains before releasing the running operation', { timeout: 5000 }, async t => {
  const io = await stalledPin(t), entered = gate(), finish = gate(); let finished = false;
  const f = workerFixture([item('a', { files: [{ name: 'video.mp4' }] })], {
    limits: { attemptMs: 1500, leaseMs: 150, renewMs: 30 },
  });
  f.media.pin = io.media.pin.bind(io.media);
  const work = f.worker.reconcile().then(() => { finished = true; }); await io.entered.promise;
  f.jobs.renew = async () => { entered.resolve(); await finish.promise; return true; };
  await entered.promise; await io.closed.promise; assert.equal(finished, false);
  finish.resolve(); await work;
  assert.deepEqual(f.results, []); await f.worker.onModuleDestroy();
});

test('failed private package read cancels and drains sibling reads before pin returns', { timeout: 5000 }, async () => {
  const finish = gate(), aborted = gate(); let settled = false, adds = 0;
  const media = new ShortsMediaService({});
  media.preparedFile = async (_short, name, signal) => {
    if (name === 'video.mp4') throw new Error('Missing source');
    signal.addEventListener('abort', aborted.resolve, { once: true });
    if (signal.aborted) aborted.resolve();
    await finish.promise; signal.throwIfAborted();
  };
  media.add = async () => { adds++; };
  const result = media.pin(item('a', { files: [{ name: 'video.mp4' }, { name: 'poster.jpg' }] })).finally(() => { settled = true; });
  const rejected = assert.rejects(result, /Missing source/); await aborted.promise;
  assert.equal(settled, false); finish.resolve(); await rejected; assert.equal(adds, 0);
});

test('job cancellation reaches private original reads and prevents moderation IO', async () => {
  const started = gate(); let scans = 0;
  const media = new ShortsMediaService({ async scan() { scans++; } }, {
    async original(_scope, _short, signal) {
      started.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  }, { chain: { release: { network: 'ae_uat', contract: 'ct_fixture'  }, state: { contract: 'ct_fixture' } } });
  const stop = new AbortController(), result = media.rescan(item('a', { privateMedia: {} }), stop.signal);
  const rejected = assert.rejects(result); await started.promise; stop.abort(); await rejected; assert.equal(scans, 0);
});

test('cancelled, expired or revoked preparation cannot enqueue a publisher request', async t => {
  for (const mode of ['shutdown', 'lease', 'revocation']) await t.test(mode, async () => {
    const record = item('a', { publication: 'pending' }), f = workerFixture([record]);
    f.media.pin = async () => {
      if (mode === 'shutdown') f.worker.shutdown.abort();
      if (mode === 'lease') f.jobs.renew = async () => false;
      if (mode === 'revocation') record.moderation = 'rejected';
    };
    await f.worker.reconcile();
    assert.equal(f.effects.some(([effect]) => effect === 'enqueue'), false);
    assert.equal(record.publication, 'pending');
    await f.worker.onModuleDestroy();
  });
});

test('creator requests acknowledge durable intent without storage, node IO or the local mutation queue', async () => {
  const record = item('a', { publication: undefined }); let changes = 0, code;
  const records = { shared: true, async get() { return structuredClone(record); }, async change(_id, update) { changes++; update(record); return structuredClone(record); } };
  const no = () => assert.fail('Request must not perform expensive work');
  const media = { safety: { demoAutoApprove: false }, pin: no };
  const service = new ShortsService({ address: value => value, serial: no, read: no, write: no }, media,
    { counters: async () => ({ views: 0 }) }, undefined, undefined, undefined, undefined, undefined, records,
    { enqueue: no, async status() {} });
  const controller = new ShortsController(service, { authenticate: async () => record.creator }, {});
  const result = await controller.publish('session', record.id, { status: value => { code = value; } });
  assert.equal(code, 202); assert.equal(result.publicationPending, true);
  assert.equal(result.publicationRequest, 'preparing'); assert.equal(result.publicationStatus, 'draft');
  assert.equal(changes, 1);
  await service.publish(record.creator, record.id);
  assert.equal(changes, 1, 'retry must not rewrite or reschedule accepted intent');
  await assert.rejects(service.publish('ak_other', record.id), /Only the creator/);
  record.moderation = 'rejected';
  await assert.rejects(service.publish(record.creator, record.id), { status: 403 });
  const saved = await service.publication(record.creator, record.id);
  assert.equal(saved.publicationPending, true); assert.notEqual(saved.status, 'active');
});

test('a delayed creator request cannot revert a concurrently confirmed publication to pending', async () => {
  const record = item('a', { publication: undefined });
  const records = {
    shared: true, async get() { return structuredClone(record); },
    async change(_id, update) {
      record.publication = 'published'; // Another operation commits while this request waits for its lock.
      update(record); return structuredClone(record);
    },
  };
  const service = new ShortsService({ address: value => value }, {}, {}, undefined, undefined, undefined, undefined, undefined, records,
    { async status() { throw new Error('Status connection lost after intent commit'); } });
  await assert.rejects(service.publish(record.creator, record.id), /Status connection lost/);
  assert.equal(record.publication, 'published');
});

test('publisher saturation skips all media work and keeps a normal pending retry', async () => {
  const f = workerFixture([item('a', { publication: 'pending' })]);
  f.shorts.publisher.capacity = async () => false;
  f.media.ensurePinned = () => assert.fail('Full signing queue must not read or upload media');
  await f.worker.reconcile(); await f.worker.onModuleDestroy();
  assert.deepEqual(f.effects, []); assert.deepEqual(f.results, [['a', 'publication_pending']]);
});

test('unknown publisher capacity fails closed and cannot start media work', async () => {
  const f = workerFixture([item('a', { publication: 'pending' })]);
  f.shorts.publisher.capacity = async () => { throw new Error('Capacity unavailable'); };
  f.media.ensurePinned = () => assert.fail('Unknown capacity must not start media work');
  await f.worker.reconcile(); await f.worker.onModuleDestroy();
  assert.deepEqual(f.effects, []); assert.deepEqual(f.results, [['a', 'failed']]);
});

test('a reused recursive pin must verify each file and cannot silently upload over ambiguous reads', async () => {
  const media = new ShortsMediaService({}), short = item('a', { files: [{ name: 'video.mp4' }, { name: 'poster.jpg' }] });
  let reads = [], pins = 0;
  media.pinned = async () => true;
  media.retrieveFile = async (_s, name) => { reads.push(name); };
  media.pinPackage = async () => { pins++; };
  await media.ensurePinned(short);
  assert.deepEqual(reads, ['video.mp4', 'poster.jpg']); assert.equal(pins, 0);
  media.retrieveFile = async () => { throw new Error('Hash mismatch'); };
  await assert.rejects(media.ensurePinned(short), /Hash mismatch/); assert.equal(pins, 0);
  media.pinned = async () => { throw new Error('Pin lookup unavailable'); };
  await assert.rejects(media.ensurePinned(short), /Pin lookup unavailable/); assert.equal(pins, 0);
  media.pinned = async () => false;
  await media.ensurePinned(short); assert.equal(pins, 1);
  await assert.rejects(media.ensurePinned(short, AbortSignal.abort())); assert.equal(pins, 1);
});
