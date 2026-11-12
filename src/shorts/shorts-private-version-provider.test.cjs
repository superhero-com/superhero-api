require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  ShortsPrivateObjectsService,
} = require('./shorts-private-objects.service');
const {
  ShortsPrivateVersionStorageService,
} = require('./shorts-private-version-storage.service');
const {
  ShortsPrivateVersionCleanupService,
} = require('./shorts-private-version-cleanup.service');
const { ShortsRetentionService } = require('./shorts-retention.service');
const { ShortsSourceReaderService } = require('./shorts-source-reader.service');
const { ShortsStorageListService } = require('./shorts-storage-list.service');
const {
  ShortsStorageInventoryService,
} = require('./shorts-storage-inventory.service');
const {
  ShortsStorageReconciliationService,
} = require('./shorts-storage-reconciliation.service');
const {
  privateVersionDatabase,
} = require('./testing/private-version-database.cjs');
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// MinIO's STS endpoint supplies a real restricted principal. No ambient AWS
// credentials, production endpoints, unsigned S3 mocks or permissive emulator.
test(
  'real version cleanup preserves current bytes with restricted STS authority and crash recovery',
  {
    skip:
      process.env.SHORTS_TEST_MINIO_STS !== '1' ||
      !process.env.SHORTS_TEST_S3_ENDPOINT ||
      !process.env.SHORTS_TEST_PG_URL,
    timeout: 120000,
  },
  async (t) => {
    const endpoint = new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
    assert.equal(endpoint.protocol, 'http:');
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.pathname, '/');
    assert.ok(endpoint.port);
    const {
      STSClient,
      AssumeRoleCommand,
    } = require('@aws-sdk/nested-clients/sts');
    const rootConfig = {
      endpoint: endpoint.origin,
      region: 'us-east-1',
      forcePathStyle: true,
      bucket: 'shorts-cleanup-' + randomUUID(),
      prefix: 'quarantine',
      credentials: {
        accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY,
        secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY,
      },
    };
    const scope = { network: 'ae_uat', contract: 'ct_providerCleanup' };
    const keys = { key1: randomBytes(32) },
      plaintext = randomBytes(2 * 1048576 + 7);
    const raw = new S3Client(rootConfig),
      writer = new ShortsPrivateObjectsService({
        ...rootConfig,
        activeKeyId: 'key1',
        keys,
      });
    const sts = new STSClient({ ...rootConfig, maxAttempts: 1 });
    let bucketCreated = false,
      limited,
      objects,
      storage,
      listing,
      coordinator;
    t.after(async () => {
      await coordinator?.onModuleDestroy();
      storage?.onModuleDestroy();
      listing?.onModuleDestroy();
      objects?.onModuleDestroy();
      writer.onModuleDestroy();
      limited?.destroy();
      sts.destroy();
      if (bucketCreated) {
        let next;
        do {
          const page = await raw.send(
            new ListObjectVersionsCommand({
              Bucket: rootConfig.bucket,
              ...next,
            }),
          );
          const rows = [
            ...(page.Versions || []),
            ...(page.DeleteMarkers || []),
          ].map((r) => ({ Key: r.Key, VersionId: r.VersionId }));
          if (rows.length) {
            const removed = await raw.send(
              new DeleteObjectsCommand({
                Bucket: rootConfig.bucket,
                Delete: { Objects: rows },
              }),
            );
            assert.equal(removed.Errors?.length || 0, 0);
          }
          next = page.IsTruncated
            ? {
                KeyMarker: page.NextKeyMarker,
                VersionIdMarker: page.NextVersionIdMarker,
              }
            : undefined;
        } while (next);
        await raw.send(new DeleteBucketCommand({ Bucket: rootConfig.bucket }));
      }
      raw.destroy();
    });
    await raw.send(new CreateBucketCommand({ Bucket: rootConfig.bucket }));
    bucketCreated = true;
    await raw.send(
      new PutBucketVersioningCommand({
        Bucket: rootConfig.bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    const variants = new Map();
    let ref, previousCiphertext;
    // Populate historical duplicate envelopes with distinct encryption nonces.
    // The actual writer's conditional put remains unchanged.
    writer.client.send = async (command) => {
      assert.equal(command.constructor.name, 'PutObjectCommand');
      assert.equal(command.input.IfNoneMatch, '*');
      const body = Buffer.from(command.input.Body);
      if (previousCiphertext) assert.notDeepEqual(body, previousCiphertext);
      previousCiphertext = body;
      return {};
    };
    for (const label of [
      'corrupt',
      'happy',
      'lost',
      'crash',
      'expiry',
      'current',
    ]) {
      ref = await writer.put(scope, 'job', 'part/0', plaintext);
      const body = Buffer.from(previousCiphertext);
      if (label === 'corrupt') body[body.length - 1] ^= 1;
      const result = await raw.send(
        new PutObjectCommand({
          Bucket: rootConfig.bucket,
          Key: ref.key,
          Body: body,
        }),
      );
      assert.ok(result.VersionId && result.VersionId !== 'null');
      variants.set(label, result.VersionId);
    }
    const outsideKey = 'unrelated/owned-fixture';
    const outside = await raw.send(
      new PutObjectCommand({
        Bucket: rootConfig.bucket,
        Key: outsideKey,
        Body: 'unrelated fixture',
      }),
    );
    const objectPrefix = ref.key.split('/').slice(0, 2).join('/') + '/';
    const bucketArn = `arn:aws:s3:::${rootConfig.bucket}`;
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:GetBucketVersioning', 's3:GetLifecycleConfiguration'],
          Resource: [bucketArn],
        },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket', 's3:ListBucketVersions'],
          Resource: [bucketArn],
          Condition: { StringLike: { 's3:prefix': [objectPrefix + '*'] } },
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Resource: [bucketArn + '/' + objectPrefix + '*'],
        },
        // MinIO authorizes versioned DELETE as DeleteObject, then applies explicit
        // DeleteObjectVersion denies. Permit only these immutable historical IDs;
        // never grant an unconditional DeleteObject permission to make a test pass.
        {
          Effect: 'Allow',
          Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
          Resource: [bucketArn + '/' + ref.key],
          Condition: {
            StringEquals: {
              's3:versionid': [...variants]
                .filter(([label]) => label !== 'current')
                .map(([, version]) => version),
            },
          },
        },
      ],
    };
    const issued = await sts.send(
      new AssumeRoleCommand({
        RoleArn: 'arn:aws:iam::123456789012:role/shorts-cleanup',
        RoleSessionName: 'shorts-cleanup-' + randomUUID(),
        DurationSeconds: 900,
        Policy: JSON.stringify(policy),
      }),
    );
    assert.ok(issued.Credentials?.SessionToken);
    const credentials = {
      accessKeyId: issued.Credentials.AccessKeyId,
      secretAccessKey: issued.Credentials.SecretAccessKey,
      sessionToken: issued.Credentials.SessionToken,
    };
    const config = {
      scope,
      prefix: rootConfig.prefix,
      objectPrefix,
      sourceHash: hash('provider-cleanup'),
      storageId: hash([endpoint.origin, rootConfig.bucket]),
      storage: { ...rootConfig, credentials },
      objects: { ...rootConfig, credentials, activeKeyId: 'key1', keys },
    };
    limited = new S3Client(config.storage);
    objects = new ShortsPrivateObjectsService(config.objects);
    storage = new ShortsPrivateVersionStorageService(config);
    const current = variants.get('current'),
      signal = new AbortController().signal;
    const head = (version) =>
      raw.send(
        new HeadObjectCommand({
          Bucket: rootConfig.bucket,
          Key: ref.key,
          VersionId: version,
        }),
      );
    const intact = async () => {
      const retained = await raw.send(
        new HeadObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key }),
      );
      assert.equal(retained.VersionId, current);
      assert.deepEqual(await objects.get(scope, ref), plaintext);
    };
    await t.test(
      'storage enforces credential scope and blocks ordinary deletes and writes',
      async () => {
        for (const command of [
          new PutObjectCommand({
            Bucket: rootConfig.bucket,
            Key: ref.key,
            Body: 'forbidden',
          }),
          new DeleteObjectCommand({ Bucket: rootConfig.bucket, Key: ref.key }),
          new DeleteObjectCommand({
            Bucket: rootConfig.bucket,
            Key: ref.key,
            VersionId: 'null',
          }),
          new DeleteObjectCommand({
            Bucket: rootConfig.bucket,
            Key: ref.key,
            VersionId: current,
          }),
          new GetObjectCommand({ Bucket: rootConfig.bucket, Key: outsideKey }),
          new DeleteObjectCommand({
            Bucket: rootConfig.bucket,
            Key: outsideKey,
            VersionId: outside.VersionId,
          }),
        ]) {
          await assert.rejects(
            limited.send(command),
            (e) => e.$metadata?.httpStatusCode === 403,
          );
        }
        await storage.preflight(ref.key, current, ref.bytes, signal);
        await intact();
      },
    );
    await t.test(
      'expired and version-tampered signed DELETE requests cannot remove data',
      async () => {
        const command = new DeleteObjectCommand({
          Bucket: rootConfig.bucket,
          Key: ref.key,
          VersionId: variants.get('expiry'),
        });
        const expired = await getSignedUrl(limited, command, {
          expiresIn: 30,
          signingDate: new Date(Date.now() - 60000),
        });
        const changed = new URL(
          await getSignedUrl(limited, command, { expiresIn: 30 }),
        );
        changed.searchParams.set('versionId', variants.get('corrupt'));
        for (const [url, code] of [
          [expired, 'AccessDenied'],
          [changed.href, 'SignatureDoesNotMatch'],
        ]) {
          const response = await fetch(url, {
            method: 'DELETE',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          });
          const body = await response.text();
          assert.equal(response.status, 403);
          // Assert only non-secret error fields, never print a signed URL/token.
          assert.equal(/<Code>([^<]+)<\/Code>/.exec(body)?.[1], code);
          if (url === expired)
            assert.equal(
              /<Message>([^<]+)<\/Message>/.exec(body)?.[1],
              'Request has expired',
            );
        }
        await head(variants.get('expiry'));
        await intact();
      },
    );
    const database = await privateVersionDatabase(t, config, ref);
    const retention = new ShortsRetentionService(database.owner, config);
    const inspection = new ShortsStorageReconciliationService(
      database.owner,
      config,
      retention,
      new ShortsSourceReaderService(objects),
      objects,
    );
    listing = new ShortsStorageListService(config);
    const inventory = new ShortsStorageInventoryService(
        database.owner,
        config,
        listing,
      ),
      inventoryId = randomUUID();
    await inventory.start(inventoryId);
    while (!(await inventory.step(inventoryId)).listingComplete) {}
    const rows = await database.owner.query(
      'SELECT identity,version_id,latest FROM shorts_storage_inventory_objects WHERE run_id=$1',
      [inventoryId],
    );
    assert.equal(rows.length, variants.size);
    assert.equal(rows.filter((r) => r.latest).length, 1);
    assert.equal(rows.find((r) => r.latest).version_id, current);
    const identity = (label) => {
      const row = rows.find((r) => r.version_id === variants.get(label));
      assert.ok(row);
      return row.identity;
    };
    const scan = async () => {
      const id = randomUUID();
      await inspection.start(id, inventoryId);
      while (!(await inspection.step(id)).referenceTraversalComplete) {}
      return id;
    };
    const scopedRetention = new ShortsRetentionService(database.db, config);
    const scopedInspection = new ShortsStorageReconciliationService(
      database.db,
      config,
      scopedRetention,
      new ShortsSourceReaderService(objects),
      objects,
    );
    const create = () => {
      const previous = process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED;
      process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED = 'true';
      try {
        return new ShortsPrivateVersionCleanupService(
          database.db,
          config,
          objects,
          storage,
          scopedInspection,
          scopedRetention,
        );
      } finally {
        if (previous === undefined)
          delete process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED;
        else process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED = previous;
      }
    };
    coordinator = create();
    await coordinator.verify();
    await t.test(
      'retention holds and unauthentic historical content cannot be deleted',
      async () => {
        const hold = randomUUID();
        await retention.hold({
          id: hold,
          resourceId: 'job',
          reason: 'appeal',
          reference: 'provider-fixture',
        });
        await assert.rejects(
          coordinator.reclaim(randomUUID(), await scan(), identity('happy')),
        );
        await head(variants.get('happy'));
        await retention.release(hold);
        const op = randomUUID();
        await assert.rejects(
          coordinator.reclaim(op, await scan(), identity('corrupt')),
        );
        await head(variants.get('corrupt'));
        assert.equal(
          (await coordinator.cancel(op)).operation.state,
          'cancelled',
        );
        await intact();
      },
    );
    await t.test(
      'authenticated duplicate cleanup removes only its exact noncurrent version',
      async () => {
        const op = randomUUID(),
          run = await scan();
        const result = await coordinator.reclaim(op, run, identity('happy'));
        assert.equal(result.operation.state, 'removed');
        assert.deepEqual(
          result.events.map((e) => e.kind),
          ['issued', 'removed'],
        );
        await assert.rejects(
          head(variants.get('happy')),
          (e) => e.$metadata?.httpStatusCode === 404,
        );
        assert.equal(
          (await coordinator.reclaim(op, run, identity('happy'))).operation
            .state,
          'removed',
        );
        await head(variants.get('lost'));
        await intact();
      },
    );
    await t.test(
      'a lost provider acknowledgement remains recoverable without another deletion',
      async () => {
        const op = randomUUID(),
          run = await scan(),
          originalFetch = global.fetch;
        let deletions = 0;
        global.fetch = async (url, options) => {
          const response = await originalFetch(url, options);
          if (
            options?.method === 'DELETE' &&
            new URL(url).searchParams.get('versionId') === variants.get('lost')
          ) {
            assert.equal(response.status, 204);
            await response.body?.cancel();
            deletions++;
            throw new TypeError('Simulated lost provider acknowledgement');
          }
          return response;
        };
        try {
          await assert.rejects(coordinator.reclaim(op, run, identity('lost')));
        } finally {
          global.fetch = originalFetch;
        }
        assert.equal(deletions, 1);
        assert.deepEqual(
          (await coordinator.status(op)).events.map((e) => e.kind),
          ['issued', 'uncertain'],
        );
        await coordinator.onModuleDestroy();
        coordinator = create();
        await coordinator.verify();
        const restored = await coordinator.recover(op);
        assert.equal(restored.operation.state, 'removed');
        assert.deepEqual(
          restored.events.map((e) => e.kind),
          ['issued', 'uncertain', 'removed'],
        );
        await intact();
      },
    );
    await t.test(
      'a terminated worker leaves an issued journal that a new coordinator recovers',
      async () => {
        const operation = randomUUID(),
          run = await scan(),
          directory = await mkdtemp(join(tmpdir(), 'shorts-cleanup-crash-'));
        const input = join(directory, 'input.json');
        try {
          const childConfig = {
            ...config,
            objects: {
              ...config.objects,
              keys: Object.fromEntries(
                Object.entries(keys).map(([id, value]) => [
                  id,
                  value.toString('base64'),
                ]),
              ),
            },
          };
          await writeFile(
            input,
            JSON.stringify({
              config: childConfig,
              loginOptions: database.loginOptions,
              operation,
              scan: run,
              identity: identity('crash'),
              candidate: variants.get('crash'),
            }),
            { mode: 0o600, flag: 'wx' },
          );
          const child = spawn(
            process.execPath,
            [
              '-r',
              'ts-node/register',
              '-r',
              'tsconfig-paths/register',
              join(__dirname, 'testing/private-version-crash.cjs'),
            ],
            {
              cwd: process.cwd(),
              env: {
                PATH: process.env.PATH,
                SHORTS_TEST_CLEANUP_INPUT: input,
                SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED: 'true',
              },
              stdio: ['ignore', 'ignore', 'pipe'],
            },
          );
          let stderr = '';
          child.stderr.on('data', (data) => {
            if (stderr.length < 4096) stderr += data;
          });
          const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
          try {
            const code = await new Promise((resolve, reject) => {
              child.once('error', reject);
              child.once('exit', resolve);
            });
            assert.equal(code, 73, stderr);
          } finally {
            clearTimeout(timer);
          }
          const saved = await coordinator.status(operation);
          assert.equal(saved.operation.state, 'pending');
          assert.deepEqual(
            saved.events.map((e) => e.kind),
            ['issued'],
          );
          await assert.rejects(
            head(variants.get('crash')),
            (e) => e.$metadata?.httpStatusCode === 404,
          );
          await coordinator.onModuleDestroy();
          coordinator = create();
          await coordinator.verify();
          assert.equal(
            (await coordinator.recover(operation)).operation.state,
            'removed',
          );
          assert.deepEqual(
            (await coordinator.status(operation)).events.map((e) => e.kind),
            ['issued', 'removed'],
          );
          await intact();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
    await require('./testing/private-input-version-provider.cjs')({
      t, rootConfig, raw, writer, sts, AssumeRoleCommand, plaintext, scope, keys, intact, ref,
    });
  },
);
