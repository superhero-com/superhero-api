const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DataSource } = require('typeorm');
const {
  S3Client,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
} = require('@aws-sdk/client-s3');
const {
  ShortsMetadata1791763200000,
} = require('../migrations/1791763200000-ShortsMetadata');
const {
  ShortsMultipartInventory1791763221000,
} = require('../migrations/1791763221000-ShortsMultipartInventory');
const { ShortsDatabaseService } = require('./shorts-database.service');
const { ShortsStorageListService } = require('./shorts-storage-list.service');
const {
  ShortsMultipartInventoryService,
} = require('./shorts-multipart-inventory.service');
const { storageInventoryConfig } = require('./shorts-storage-inventory.config');
const scope = { network: 'ae_uat', contract: releaseFixture().release.contract },
  sourceHash = 'a'.repeat(64);
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const config = (endpoint) => ({
  scope,
  sourceHash,
  prefix: 'private-v1',
  objectPrefix: `private-v1/${hash(Object.values(scope))}/`,
  storageId: 'c'.repeat(64),
  storage: {
    endpoint,
    region: 'us-east-1',
    bucket: 'multipart-test',
    prefix: 'private-v1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  },
});
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const upload = (c, key = c.objectPrefix + 'video', id = 'id/+==') => ({
  key,
  uploadId: id,
  initiatedAt: '2026-01-01T00:00:00.000Z',
});
const list = (c, entries = [upload(c)], next = null) =>
  `<ListMultipartUploadsResult><Bucket>${c.storage.bucket}</Bucket><Prefix>${c.objectPrefix}</Prefix><IsTruncated>${!!next}</IsTruncated>${entries.map((u) => `<Upload><Key>${escape(u.key)}</Key><UploadId>${escape(u.uploadId)}</UploadId><Initiated>${u.initiatedAt}</Initiated></Upload>`).join('')}${next ? `<NextKeyMarker>${escape(next.key)}</NextKeyMarker><NextUploadIdMarker>${escape(next.uploadId)}</NextUploadIdMarker>` : ''}</ListMultipartUploadsResult>`;
const part = (number) => ({
  number,
  bytes: 4,
  etag: '"opaque-etag"',
  modifiedAt: '2026-01-01T00:00:00.000Z',
});
const partList = (c, u, rows = [part(1)], next = null) =>
  `<ListPartsResult><Bucket>${c.storage.bucket}</Bucket><Key>${escape(u.key)}</Key><UploadId>${escape(u.uploadId)}</UploadId><IsTruncated>${next !== null}</IsTruncated>${rows.map((p) => `<Part><PartNumber>${p.number}</PartNumber><Size>${p.bytes}</Size><ETag>${escape(p.etag)}</ETag><LastModified>${p.modifiedAt}</LastModified></Part>`).join('')}${next !== null ? `<NextPartNumberMarker>${next}</NextPartNumberMarker>` : ''}</ListPartsResult>`;

test('multipart metadata reader bounds and scopes both provider APIs', async (t) => {
  let response = '',
    status = 200,
    calls = 0,
    seen;
  const server = createServer((req, res) => {
    calls++;
    seen = new URL(req.url, 'http://local');
    assert.equal(req.method, 'GET');
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const c = config(`http://127.0.0.1:${server.address().port}`),
    reader = new ShortsStorageListService(c),
    u = upload(c);
  t.after(async () => {
    reader.onModuleDestroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await t.test(
    'opaque upload IDs and numeric part markers round-trip with exact scope',
    async () => {
      response = list(c, [u], { ...u, uploadId: 'next/+=' });
      const page = await reader.multipartUploads(null);
      assert.equal(seen.searchParams.get('prefix'), c.objectPrefix);
      assert.equal(seen.searchParams.get('max-uploads'), '100');
      assert.equal(page.next.uploadId, 'next/+=');
      response = list(c);
      await reader.multipartUploads(page.next);
      assert.equal(seen.searchParams.get('upload-id-marker'), 'next/+=');
      response = partList(c, u, [part(1), part(3)], 3);
      const p = await reader.multipartParts(u);
      assert.equal(p.next, 3);
      assert.equal(seen.searchParams.get('max-parts'), '100');
      assert.equal(seen.searchParams.get('uploadId'), u.uploadId);
      response = partList(c, u, [part(10000)]);
      assert.equal((await reader.multipartParts(u, 3)).next, null);
      assert.equal(seen.searchParams.get('part-number-marker'), '3');
    },
  );
  await t.test(
    'off-scope, duplicate, malformed, oversized and repeated cursors fail closed',
    async () => {
      for (response of [
        list(c, [upload(c, 'outside')]),
        list(c, [u, u]),
        list(c, [u], u),
        list(c).replace('<IsTruncated>false</IsTruncated>', ''),
        list(c, [{ ...u, initiatedAt: 'invalid' }]),
        'x'.repeat(1048577),
      ])
        await assert.rejects(reader.multipartUploads(u), { status: 503 });
      const before = calls;
      await assert.rejects(
        reader.multipartUploads({ key: 'outside', uploadId: 'x' }),
        { status: 503 },
      );
      assert.equal(calls, before);
      for (response of [
        partList(c, { ...u, key: 'outside' }),
        partList(c, { ...u, uploadId: 'other' }),
        partList(c, u, [part(0)]),
        partList(c, u, [part(1), part(1)]),
        partList(c, u, [part(1)], 0),
        partList(c, u, [part(1)], 2),
        partList(c, u, [{ ...part(1), bytes: -1 }]),
        partList(c, u, [{ ...part(1), bytes: 9007199254740992 }]),
        partList(
          c,
          u,
          Array.from({ length: 101 }, (_, i) => part(i + 1)),
        ),
        partList(c, u, [{ ...part(1), etag: 'x'.repeat(1025) }]),
      ])
        await assert.rejects(reader.multipartParts(u), { status: 503 });
      response = partList(c, u, [part(1)]);
      await assert.rejects(reader.multipartParts(u, 1), { status: 503 });
    },
  );
  await t.test(
    'only an explicit 404 NoSuchUpload records unavailable; denied or ambiguous failures do not',
    async () => {
      status = 404;
      response =
        '<Error><Code>NoSuchUpload</Code><Message>private diagnostic</Message></Error>';
      assert.equal((await reader.multipartParts(u)).unavailable, true);
      for (const [code, name] of [
        [403, 'AccessDenied'],
        [404, 'NoSuchKey'],
        [500, 'NoSuchUpload'],
      ]) {
        status = code;
        response = `<Error><Code>${name}</Code><Message>private diagnostic</Message></Error>`;
        const before = calls;
        await assert.rejects(
          reader.multipartParts(u),
          (e) => e.status === 503 && !e.message.includes('private diagnostic'),
        );
        assert.equal(calls, before + 1);
      }
    },
  );
});

test('multipart stalled responses cancel and redirects never forward credentials', async (t) => {
  let mode = 'stall',
    calls = 0,
    forwarded = 0,
    started;
  let seen = new Promise((resolve) => (started = resolve));
  const target = createServer((_req, res) => {
    forwarded++;
    res.end();
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const server = createServer((_req, res) => {
    calls++;
    if (mode === 'redirect') {
      res.writeHead(307, {
        location: `http://127.0.0.1:${target.address().port}`,
      });
      res.end();
      return;
    }
    res.write('<ListPartsResult>');
    started();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const c = config(`http://127.0.0.1:${server.address().port}`),
    reader = new ShortsStorageListService(c);
  t.after(async () => {
    reader.onModuleDestroy();
    for (const s of [server, target]) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
  });
  const stop = new AbortController(),
    began = Date.now(),
    pending = assert.rejects(reader.multipartParts(upload(c), 0, stop.signal), {
      status: 503,
    });
  await seen;
  stop.abort();
  await pending;
  assert.ok(Date.now() - began < 1500);
  mode = 'redirect';
  await assert.rejects(reader.multipartUploads(null), { status: 503 });
  assert.equal(forwarded, 0);
  mode = 'stall';
  seen = new Promise((resolve) => (started = resolve));
  const closing = assert.rejects(reader.multipartUploads(null), {
    status: 503,
  });
  await seen;
  reader.onModuleDestroy();
  await closing;
  const before = calls;
  await assert.rejects(reader.multipartParts(upload(c)), { status: 503 });
  assert.equal(calls, before);
});

test(
  'durable multipart inventory with real PostgreSQL and S3 pagination',
  {
    skip:
      !process.env.SHORTS_TEST_PG_URL || !process.env.SHORTS_TEST_S3_ENDPOINT,
    timeout: 150000,
  },
  async (t) => {
    const pg = new URL(process.env.SHORTS_TEST_PG_URL),
      endpoint = new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
    assert.equal(pg.hostname, '127.0.0.1');
    assert.equal(endpoint.hostname, '127.0.0.1');
    const schema = 'multipart_' + randomUUID().replaceAll('-', ''),
      role = 'mp_' + randomUUID().replaceAll('-', ''),
      password = randomUUID(),
      dir = await mkdtemp(join(tmpdir(), 'multipart-inventory-'));
    const c = config(endpoint.origin);
    c.storage.bucket = 'shorts-multipart-' + randomUUID();
    c.storage.credentials = {
      accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY,
      secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY,
    };
    c.storageId = hash([
      endpoint.origin,
      c.storage.region,
      c.storage.bucket,
      c.prefix,
      true,
    ]);
    const admin = new DataSource({ type: 'postgres', url: pg.href });
    await admin.initialize();
    let db,
      owner,
      raw,
      reader,
      roleCreated = false,
      bucketCreated = false;
    t.after(async () => {
      reader?.onModuleDestroy();
      if (db?.isInitialized) await db.onModuleDestroy();
      if (owner?.isInitialized) await owner.destroy();
      if (roleCreated)
        await admin.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.destroy();
      if (bucketCreated) {
        let marker;
        do {
          const page = await raw.send(
            new ListMultipartUploadsCommand({
              Bucket: c.storage.bucket,
              ...marker,
            }),
          );
          for (const u of page.Uploads || [])
            await raw.send(
              new AbortMultipartUploadCommand({
                Bucket: c.storage.bucket,
                Key: u.Key,
                UploadId: u.UploadId,
              }),
            );
          marker = page.IsTruncated
            ? {
                KeyMarker: page.NextKeyMarker,
                UploadIdMarker: page.NextUploadIdMarker,
              }
            : null;
        } while (marker);
        await raw.send(new DeleteBucketCommand({ Bucket: c.storage.bucket }));
      }
      raw?.destroy();
      await rm(dir, { recursive: true, force: true });
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = {
      type: 'postgres',
      url: pg.href,
      schema,
      extra: { options: `-c search_path=${schema}`, max: 2 },
      migrations: [
        ShortsMetadata1791763200000,
        ShortsMultipartInventory1791763221000,
      ],
    };
    owner = new DataSource(options);
    await owner.initialize();
    await owner.runMigrations({ transaction: 'all' });
    await owner.undoLastMigration({ transaction: 'all' });
    await owner.runMigrations({ transaction: 'all' });
    const args = [scope.network, scope.contract];
    await owner.query(
      'INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)',
      [...args, sourceHash],
    );
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    roleCreated = true;
    await admin.query(
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON ${schema}.shorts_runtime TO ${role};GRANT SELECT,INSERT,UPDATE ON ${schema}.shorts_multipart_inventory_runs TO ${role};GRANT SELECT,INSERT ON ${['uploads', 'parts', 'outcomes', 'pages'].map((s) => `${schema}.shorts_multipart_inventory_${s}`).join(',')} TO ${role}`,
    );
    const login = new URL(pg);
    login.username = role;
    login.password = password;
    db = new ShortsDatabaseService(
      new DataSource({ ...options, url: login.href, migrations: [] }),
    );
    await db.onModuleInit();
    reader = new ShortsStorageListService(c);
    const service = (store = reader, database = db, settings = c) =>
        new ShortsMultipartInventoryService(database, settings, store),
      s = service();
    await s.verify();
    await t.test(
      'empty, observed and vanished listings cannot certify inventory completeness',
      async () => {
        for (const outcome of ['empty', 'observed', 'unavailable']) {
          const id = randomUUID();
          const store = {
            multipartUploads: async () => ({
              entries: outcome === 'empty' ? [] : [upload(c)],
              next: null,
            }),
            multipartParts: async () => ({
              entries: outcome === 'observed' ? [part(1)] : [],
              next: null,
              unavailable: outcome === 'unavailable',
            }),
          };
          const initial = await service(store).start(id);
          assert.equal(initial.listingComplete, false);
          assert.equal(initial.allListedUploadsObserved, false);
          assert.equal(initial.inventoryCompleteness, 'unverified');
          let result;
          for (let step = 0; step < 3; step++) {
            result = await service(store).step(id);
            if (result.listingComplete) break;
          }
          assert.equal(result.listingComplete, true);
          assert.equal(result.uploads, outcome === 'empty' ? '0' : '1');
          assert.equal(result.examinedUploads, result.uploads);
          assert.equal(result.allListedUploadsObserved, outcome !== 'unavailable');
          assert.equal(result.inventoryCompleteness, 'unverified');
          assert.equal(Object.hasOwn(result, 'allUploadsObserved'), false);
          assert.equal(result.consistentSnapshot, false);
          assert.equal(result.deletionEnabled, false);
          const resumed = service({
            multipartUploads: () => assert.fail('completed traversal queried provider'),
            multipartParts: () => assert.fail('completed traversal queried provider'),
          });
          assert.deepEqual(await resumed.step(id), result);
          assert.deepEqual(await resumed.status(id), result);
        }
      },
    );
    raw = new S3Client({ ...c.storage, maxAttempts: 1 });
    await raw.send(new CreateBucketCommand({ Bucket: c.storage.bucket }));
    bucketCreated = true;
    const create = async (key) => {
      const u = await raw.send(
        new CreateMultipartUploadCommand({
          Bucket: c.storage.bucket,
          Key: key,
        }),
      );
      return { key, uploadId: u.UploadId };
    };
    const large = await create(c.objectPrefix + 'a-large'),
      empty = await create(c.objectPrefix + 'b-empty'),
      gone = await create(c.objectPrefix + 'c-gone');
    for (const number of [
      ...Array.from({ length: 105 }, (_, i) => i + 1),
      10000,
    ])
      await raw.send(
        new UploadPartCommand({
          Bucket: c.storage.bucket,
          Key: large.key,
          UploadId: large.uploadId,
          PartNumber: number,
          Body: 'part',
        }),
      );
    for (let i = 0; i < 105; i++) await create(c.objectPrefix + 'd-shared-key');
    await create('outside/deployment');
    const observed = await raw.send(new ListMultipartUploadsCommand({ Bucket: c.storage.bucket, Prefix: c.objectPrefix, MaxUploads: 100 }));
    assert.equal(observed.Uploads?.length, 100, JSON.stringify({ prefix: c.objectPrefix, scopedUploads: observed.Uploads?.length || 0, unfilteredUploads: (await raw.send(new ListMultipartUploadsCommand({ Bucket: c.storage.bucket, MaxUploads: 1000 }))).Uploads?.length || 0 }));
    await t.test(
      'restricted evidence roles reject source writes, RLS and destructive column privileges',
      async () => {
        for (const [table, priv] of [
          ['shorts_runtime', 'UPDATE(source_hash)'],
          ['shorts_multipart_inventory_parts', 'UPDATE(bytes)'],
          ['shorts_multipart_inventory_uploads', 'REFERENCES(identity)'],
          ['shorts_multipart_inventory_runs', 'DELETE'],
        ]) {
          await owner.query(`GRANT ${priv} ON ${table} TO ${role}`);
          await assert.rejects(s.verify());
          await owner.query(`REVOKE ${priv} ON ${table} FROM ${role}`);
        }
        await owner.query(
          'ALTER TABLE shorts_multipart_inventory_parts ENABLE ROW LEVEL SECURITY',
        );
        await assert.rejects(s.verify());
        await owner.query(
          'ALTER TABLE shorts_multipart_inventory_parts DISABLE ROW LEVEL SECURITY',
        );
        await s.verify();
        await assert.rejects(
          db.query('DELETE FROM shorts_multipart_inventory_parts'),
        );
      },
    );
    const id = randomUUID();
    await t.test(
      'multiple upload and part pages resume with new instances and exact totals',
      async () => {
        await s.start(id);
        const first = await s.step(id);
        assert.equal(first.uploads, '100');
        assert.equal(first.phase, 'uploads');
        const listed = await service().step(id);
        assert.equal(listed.uploads, '108');
        assert.equal(listed.phase, 'parts');
        await raw.send(
          new AbortMultipartUploadCommand({
            Bucket: c.storage.bucket,
            Key: gone.key,
            UploadId: gone.uploadId,
          }),
        );
        let result;
        for (let i = 0; i < 120; i++) {
          result = await service().step(id);
          if (result.listingComplete) break;
        }
        assert.equal(result.listingComplete, true);
        assert.equal(result.examinedUploads, '108');
        assert.equal(result.unavailableUploads, '1');
        assert.equal(result.parts, '106');
        assert.equal(result.observedPartBytes, '424');
        assert.equal(result.allListedUploadsObserved, false);
        assert.equal(result.consistentSnapshot, false);
        assert.equal(result.deletionEnabled, false);
        const untouched = {
          multipartUploads: () => {
            throw Error('must not read');
          },
          multipartParts: () => {
            throw Error('must not read');
          },
        };
        assert.deepEqual(await service(untouched).step(id), result);
        const rows = [];
        let page;
        do {
          page = await s.uploads(id, page?.next || '', 30);
          rows.push(...page.items);
        } while (page.next);
        assert.equal(rows.length, 108);
        assert.ok(rows.every((x) => x.eligibleForAbort === false));
        assert.equal(
          rows.find((x) => x.key === gone.key).status,
          'unavailable',
        );
        assert.equal(rows.find((x) => x.key === empty.key).status, 'observed');
        assert.equal(
          rows.find((x) => x.key === large.key).observedBytes,
          '424',
        );
        const identity = hash([large.key, large.uploadId]),
          a = await s.parts(id, identity),
          b = await s.parts(id, identity, a.next);
        assert.equal(a.items.length, 100);
        assert.equal(b.items.length, 6);
        assert.equal(b.items.at(-1).number, 10000);
        assert.equal(b.next, null);
        await assert.rejects(s.parts(id, 'bad'), { status: 400 });
        await assert.rejects(s.uploads(id, '', 101), { status: 400 });
        await assert.rejects(
          service(reader, db, { ...c, storageId: 'f'.repeat(64) }).status(id),
          { status: 409 },
        );
        await assert.rejects(
          owner.undoLastMigration({ transaction: 'all' }),
          /Preserve multipart inventory history/,
        );
      },
    );
    const u = upload(c),
      next = { ...u, uploadId: 'next' };
    const fake = {
      multipartUploads: async () => ({ entries: [u], next: null }),
      multipartParts: async () => ({
        entries: [part(1)],
        next: null,
        unavailable: false,
      }),
    };
    await t.test(
      'deduplicates upload observations and rejects changed observations or looping cursors',
      async () => {
        const run = randomUUID();
        await s.start(run);
        const f = (page) =>
          service({ ...fake, multipartUploads: async () => page });
        await f({ entries: [u], next }).step(run);
        await f({ entries: [u], next: { ...next, uploadId: 'third' } }).step(
          run,
        );
        assert.equal((await s.status(run)).uploads, '1');
        await assert.rejects(f({ entries: [], next }).step(run), {
          status: 409,
        });
        await assert.rejects(
          f({
            entries: [{ ...u, initiatedAt: '2026-01-02T00:00:00.000Z' }],
            next: null,
          }).step(run),
          { status: 409 },
        );
        assert.equal((await s.status(run)).phase, 'uploads');
        await f({ entries: [], next: null }).step(run);
        await service({
          ...fake,
          multipartParts: async () => ({
            entries: [part(1)],
            next: 1,
            unavailable: false,
          }),
        }).step(run);
        await assert.rejects(
          service({
            ...fake,
            multipartParts: async () => ({
              entries: [{ ...part(1), etag: 'changed' }],
              next: null,
              unavailable: false,
            }),
          }).step(run),
          { status: 409 },
        );
        assert.equal((await s.status(run)).parts, '1');
      },
    );
    await t.test(
      'concurrent work, rollback and lost acknowledgement preserve one checkpoint',
      async () => {
        const run = randomUUID();
        await s.start(run);
        let calls = 0,
          release;
        const gate = new Promise((resolve) => (release = resolve));
        const racing = service({
          ...fake,
          multipartUploads: async () => {
            if (++calls === 2) release();
            await gate;
            return fake.multipartUploads();
          },
        });
        const outcomes = await Promise.allSettled([
          racing.step(run),
          racing.step(run),
        ]);
        assert.equal(
          outcomes.filter((x) => x.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          outcomes.find((x) => x.status === 'rejected').reason.status,
          409,
        );
        const failing = {
          query: (...p) => db.query(...p),
          transaction: (fn) =>
            db.transaction(async (tx) => {
              await fn(tx);
              throw Error('rollback');
            }),
        };
        await assert.rejects(service(fake, failing).step(run), /rollback/);
        assert.equal((await s.status(run)).parts, '0');
        const lost = {
          query: (...p) => db.query(...p),
          transaction: async (fn) => {
            await db.transaction(fn);
            throw Error('lost ack');
          },
        };
        await assert.rejects(service(fake, lost).step(run), /lost ack/);
        assert.equal((await s.status(run)).parts, '1');
        assert.equal((await s.status(run)).examinedUploads, '1');
        assert.equal((await service(fake).step(run)).listingComplete, true);
      },
    );
    await t.test(
      'cancellation, unavailable part lists and vanished uploads preserve honest counters',
      async () => {
        const run = randomUUID();
        await s.start(run);
        const abort = new AbortController();
        const cancelled = {
          ...fake,
          multipartUploads: async () => {
            abort.abort();
            return fake.multipartUploads();
          },
        };
        await assert.rejects(service(cancelled).step(run, abort.signal));
        assert.equal((await s.status(run)).pages, '0');
        await service(fake).step(run);
        await service({
          ...fake,
          multipartParts: async () => ({
            entries: [part(1)],
            next: 1,
            unavailable: false,
          }),
        }).step(run);
        await assert.rejects(
          service({
            ...fake,
            multipartParts: async () => {
              throw Error('provider denied');
            },
          }).step(run),
          /provider denied/,
        );
        assert.equal((await s.status(run)).parts, '1');
        await service({
          ...fake,
          multipartParts: async () => ({
            entries: [],
            next: null,
            unavailable: true,
          }),
        }).step(run);
        const final = await service(fake).step(run);
        assert.equal(final.unavailableUploads, '1');
        assert.equal(final.observedPartBytes, '4');
        assert.equal(final.allListedUploadsObserved, false);
      },
    );
    await t.test(
      'compiled CLI uses clean configuration and dedicated role across multipart commands',
      async () => {
        const credentials = join(dir, 'credentials'),
          manifest = join(dir, 'manifest'),
          request = join(dir, 'request');
        await writeFile(credentials, JSON.stringify(c.storage.credentials), {
          mode: 0o600,
        });
        await writeFile(manifest, JSON.stringify(releaseFixture({ ...scope, sourceHash }).release));
        const env = {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          ENABLE_SHORTS: 'true',
          AE_NETWORK_ID: 'ae_uat',
          SHORTS_DEPLOYMENT_FILE: manifest,
          DB_HOST: pg.hostname,
          DB_PORT: pg.port,
          DB_DATABASE: pg.pathname.slice(1),
          DB_USER: role,
          DB_PASSWORD: password,
          PGOPTIONS: `-c search_path=${schema}`,
          SHORTS_DB_CONCURRENCY: '1',
          SHORTS_PRIVATE_S3_ENDPOINT: endpoint.origin,
          SHORTS_PRIVATE_S3_REGION: c.storage.region,
          SHORTS_PRIVATE_S3_BUCKET: c.storage.bucket,
          SHORTS_PRIVATE_S3_PREFIX: c.prefix,
          SHORTS_PRIVATE_S3_PATH_STYLE: 'true',
          SHORTS_PRIVATE_S3_ALLOW_LOOPBACK: '1',
          SHORTS_PRIVATE_S3_CREDENTIALS_FILE: credentials,
        };
        assert.equal(
          (await storageInventoryConfig(env)).storageId,
          c.storageId,
        );
        const cli = async (action, body) => {
          await writeFile(request, JSON.stringify(body));
          const out = await promisify(execFile)(
            process.execPath,
            ['dist/shorts/storage-inventory-main', action, request],
            { env, timeout: 30000 },
          );
          assert.equal(out.stderr, '');
          return JSON.parse(out.stdout);
        };
        assert.equal(
          (await cli('multipart-status', { id })).listingComplete,
          true,
        );
        assert.equal(
          (await cli('multipart-uploads', { id, limit: 2 })).items.length,
          2,
        );
        assert.equal(
          (
            await cli('multipart-parts', {
              id,
              upload: hash([large.key, large.uploadId]),
              limit: 2,
            })
          ).items.length,
          2,
        );
        const fresh = randomUUID();
        await cli('multipart-start', { id: fresh });
        const one = await cli('multipart-scan', { id: fresh, pages: 1 });
        assert.equal(one.pages, '1');
        assert.equal(one.phase, 'uploads');
      },
    );
  },
);
