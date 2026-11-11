const schemaMigrations = require('./schema-migrations.cjs');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { mkdir, writeFile, readdir } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/nested-clients/sts');
const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { ShortsPrivateObjectsService, privateObjectConfig } = require('../shorts-private-objects.service');
const { ShortsSourceService } = require('../shorts-source.service');
const { ShortsSourceReaderService } = require('../shorts-source-reader.service');
const { ShortsDeliveryPackagesService } = require('../shorts-delivery-packages.service');
const { ShortsDeliverySelectionService } = require('../shorts-delivery-selection.service');
const { ShortsDeliveryInputRetirementService } = require('../shorts-delivery-input-retirement.service');
const { ShortsPrivateInputRetirementsService } = require('../shorts-private-input-retirements.service');
const { ShortsPrivateInputRetirementService } = require('../shorts-private-input-retirement.service');
const { ShortsStorageListService } = require('../shorts-storage-list.service');
const { ShortsStorageInventoryService } = require('../shorts-storage-inventory.service');
const { ShortsStorageReconciliationService } = require('../shorts-storage-reconciliation.service');
const { ShortsRetentionService } = require('../shorts-retention.service');
const { ShortsPrivateReferenceBarriersService } = require('../shorts-private-reference-barriers.service');
const { ShortsPrivateInputCleanupJournalService: Journal } = require('../shorts-private-input-cleanup-journal.service');
const { ShortsPrivateInputCleanupVerifierService: Verifier } = require('../shorts-private-input-cleanup-verifier.service');
const { ShortsPrivateInputCleanupControlController: Controller, ShortsPrivateInputCleanupControlGuard: Guard } = require('../shorts-private-input-cleanup-control.controller');
const { ShortsPrivateInputCleanupService: Operator } = require('../shorts-private-input-cleanup.service');
const { ShortsPrivateInputCleanupModule } = require('../shorts-private-input-cleanup.module');
const { SHORTS_STORAGE_RECONCILIATION_CONFIG } = require('../shorts-storage-reconciliation.config');
const { shortsPlaybackDescriptor } = require('../shorts-playback-descriptor');
const { sourceKey } = require('../hls-protocol/hls-package');
const { parseMaster } = require('../hls-protocol/hls-adaptive');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const drain = async (step, field) => {
  for (let page = 0; page < 256; page++) if ((await step())[field] === true) return;
  assert.fail(`Local fixture traversal did not complete: ${field}`);
};

// Opt-in local integration: migrations not already installed by the worker fixture.
exports.migrate = owner => owner.transaction(async runner => {
  for (const name of [
    'ShortsRetentionHolds', 'ShortsStorageInventory',
    'ShortsStorageReferences', 'ShortsHlsInventory',
    'ShortsAdaptiveInventory', 'ShortsDeliveryPackages',
    'ShortsDeliveryGenerations', 'ShortsFileStorageReferences',
    'ShortsGenerationDeliveryPackages', 'ShortsDeliveryStaging',
    'ShortsDeliverySelection', 'ShortsDeliveryInputRetirement',
    'ShortsOriginalUploads', 'ShortsPrivateVersionCleanup',
    'ShortsPrivateInputRetirement', 'ShortsAcceptedManifests',
    'ShortsPrivateReferenceBarriers', 'ShortsPrivateInputCleanupJournal',
  ]) await new schemaMigrations[name]().up(runner);
  if (process.env.SHORTS_TEST_INPUT_RECLAMATION === '1') {
    for (const name of [
      'ShortsInputReclamationReservations', 'ShortsPinTransfers',
      'ShortsInputReclamationPermits', 'ShortsStorageWriteEpochs',
      'ShortsReclamationRelease', 'ShortsStorageRecovery',
    ]) await new schemaMigrations[name]().up(runner);
  }
});

// Uses the real upload, worker, encoder and publisher fixture. Chain confirmation
// and safety observations remain controlled inputs; no live chain is contacted.
exports.exercise = async f => {
  const { t, owner, scope, sourceHash, schema, dir, raw, bucket, credentials, endpoint, api, shorts, media, record, video, ownedPins } = f;
  assert.match(schema, /^shorts_worker_[a-f0-9]+$/);
  const repo = process.env.SHORTS_TEST_STREAMING_REPO; assert.ok(isAbsolute(repo));
  const { TranscoderService } = require(join(repo, 'dist/streaming/transcoder.service'));
  const { IpfsService } = require(join(repo, 'dist/streaming/ipfs.service'));
  const { DiskCapacityService, DiskProbeService } = require(join(repo, 'dist/streaming/disk-capacity.service'));
  const kubo = process.env.SHORTS_TEST_KUBO_API; assert.equal(new URL(kubo).hostname, '127.0.0.1');
  const rpc = async (action, params) => {
    const response = await fetch(`${kubo}/${action}?${new URLSearchParams(params)}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, action); return Buffer.from(await response.arrayBuffer());
  };
  const cacheDir = join(dir, 'streaming');
  const streamConfig = { role: 'worker', cacheDir, ipfs: kubo, prepareTimeout: 120000, metadataTimeout: 5000,
    diskMaxUsedPercent: 99, diskMinFreeBytes: 1048576, diskMinFreeInodes: 128 };
  const disk = new DiskCapacityService(streamConfig, new DiskProbeService());
  const transcoder = new TranscoderService(streamConfig, new IpfsService(streamConfig), disk);
  const connections = [], roles = [], modules = [];
  let control, verifier, retirement, listing, sts, limited;
  try {
    await transcoder.onModuleInit();
    const descriptor = shortsPlaybackDescriptor(record, scope);
    const prepared = await transcoder.prepare(descriptor, () => shorts.ensurePlayable(record.id));
    ownedPins.add(prepared.cid);
    assert.equal(prepared.version, 3);
    const master = parseMaster(prepared.playlist);
    assert.deepEqual(master.videos.map(track => track.track), ['v1080', 'v720', 'v480', 'v360', 'vrescue']);
    assert.equal(master.videos[0].frameRate, 60); assert.equal(master.audio.length, 2);
    assert.deepEqual(await readdir(cacheDir), []);
    const key = sourceKey(descriptor), selections = new ShortsDeliverySelectionService(owner);
    await new ShortsDeliveryPackagesService(owner).acknowledge(descriptor, prepared);
    await media.verifyDurableDelivery(record, descriptor, prepared);
    // Owner-only clock travel keeps the test bounded. Runtime roles cannot
    // change this immutable acknowledgement or shorten the rollback window.
    await owner.transaction(async db => {
      await db.query('ALTER TABLE shorts_delivery_packages DISABLE TRIGGER shorts_delivery_package_guard');
      await db.query("UPDATE shorts_delivery_packages SET acknowledged_at=clock_timestamp()-interval '2 hours'");
      await db.query('ALTER TABLE shorts_delivery_packages ENABLE TRIGGER shorts_delivery_package_guard');
    });
    await new ShortsDeliveryInputRetirementService(owner).commit(scope, record.id, key, randomUUID());
    process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED = 'true';
    const objects = api.get(ShortsPrivateObjectsService);
    retirement = new ShortsPrivateInputRetirementService(shorts, media, selections, new ShortsPrivateInputRetirementsService(owner), api.get(ShortsSourceService), objects);
    const receipt = await retirement.retireInputs(record.id, key, randomUUID());
    const [{ objects: refs }] = await owner.query('SELECT objects FROM shorts_private_input_retirements WHERE resource_id=$1', [record.id]);
    assert.equal(receipt.objectCount, refs.length);
    assert.ok(refs.some(ref => ref.key === record.privateMedia.source.manifest.key));
    const configObjects = await privateObjectConfig();
    const config = { scope, sourceHash, prefix: configObjects.prefix, storage: configObjects, objects: configObjects,
      objectPrefix: `${configObjects.prefix}/${hash(JSON.stringify([scope.network, scope.contract]))}/`,
      storageId: hash(JSON.stringify([configObjects.endpoint, configObjects.region, bucket, configObjects.prefix, configObjects.forcePathStyle])) };
    const retention = new ShortsRetentionService(owner, config);
    const barriers = new ShortsPrivateReferenceBarriersService(owner);
    await barriers.enrol(scope);

    // Add an unauthentic duplicate before inventory, preserving the authentic
    // version. The operator must reject it without obtaining API proof.
    const target = refs[0];
    const sourceVersion = await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: target.key }));
    const encrypted = await raw.send(new GetObjectCommand({ Bucket: bucket, Key: target.key, VersionId: sourceVersion.VersionId }));
    const corrupt = Buffer.from(await encrypted.Body.transformToByteArray()); corrupt[corrupt.length - 1] ^= 1;
    const bad = await raw.send(new PutObjectCommand({ Bucket: bucket, Key: target.key, Body: corrupt }));
    const restored = await raw.send(new GetObjectCommand({ Bucket: bucket, Key: target.key, VersionId: sourceVersion.VersionId }));
    const restoredVersion = await raw.send(new PutObjectCommand({ Bucket: bucket, Key: target.key, Body: await restored.Body.transformToByteArray() }));
    assert.notEqual(restoredVersion.VersionId, sourceVersion.VersionId);

    listing = new ShortsStorageListService(config);
    const inventoryService = new ShortsStorageInventoryService(owner, config, listing);
    const inventory = randomUUID(); await inventoryService.start(inventory);
    await drain(() => inventoryService.step(inventory), 'listingComplete');
    const inspector = new ShortsStorageReconciliationService(owner, config, retention, new ShortsSourceReaderService(objects), objects);
    const scan = randomUUID(); await inspector.start(scan, inventory);
    await drain(() => inspector.step(scan), 'referenceTraversalComplete');
    const rows = await owner.query('SELECT identity,object_key,version_id,bytes FROM shorts_storage_inventory_objects WHERE run_id=$1 AND NOT deleted', [inventory]);
    const candidates = [];
    for (const ref of refs) {
      const barrier = randomUUID(); await barriers.reserve(scope, barrier, scan, ref.key); await barriers.seal(scope, barrier, scan);
      for (const row of rows.filter(row => row.object_key === ref.key)) candidates.push({ id: randomUUID(), barrier, inventory, identity: row.identity, row });
    }
    assert.equal(candidates.length, refs.length + 2);
    const rejected = candidates.find(item => item.row.version_id === bad.VersionId);
    const items = candidates.filter(item => item !== rejected);
    const request = ({ row: _row, ...item }) => item;

    const principal = async isVerifier => {
      const role = 'shmedia_' + randomUUID().replaceAll('-', ''), password = randomUUID();
      await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`); roles.push(role);
      await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
        GRANT SELECT ON shorts_private_input_cleanup,shorts_private_input_verifications,shorts_private_input_attempts,shorts_private_input_outcomes,shorts_private_input_barriers TO ${role};
        GRANT EXECUTE ON FUNCTION shorts_private_cleanup_snapshot(uuid) TO ${role}`);
      if (isVerifier) await owner.query(`GRANT INSERT ON shorts_private_input_verifications TO ${role}; GRANT EXECUTE ON FUNCTION shorts_private_cleanup_lock_batch(text,text,uuid[]) TO ${role}`);
      else await owner.query(`GRANT SELECT ON shorts_runtime TO ${role}; GRANT INSERT ON shorts_private_input_cleanup,shorts_private_input_attempts,shorts_private_input_outcomes TO ${role};
        GRANT EXECUTE ON FUNCTION shorts_private_sealed_snapshot(uuid),shorts_private_cleanup_dispatch(uuid) TO ${role}`);
      const url = new URL(process.env.SHORTS_TEST_PG_URL); url.username = role; url.password = password;
      const db = new DataSource({ ...owner.options, url: url.href }); await db.initialize(); connections.push(db); return db;
    };
    const verifierDb = await principal(true), operatorDb = await principal(false);
    process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED = 'true';
    process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE = join(dir, 'cleanup-token');
    await writeFile(process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
    verifier = new Verifier(shorts, media, selections, new Journal(verifierDb));
    class ControlModule {}
    Module({ controllers: [Controller], providers: [Guard, { provide: Verifier, useValue: verifier }] })(ControlModule);
    control = await NestFactory.create(ControlModule, { logger: false, abortOnError: false }); control.setGlobalPrefix('api'); await control.listen(0, '127.0.0.1');
    process.env.SHORTS_STORAGE_CONTROL_URL = await control.getUrl();
    // The verifier and operator normally start in separate processes. The
    // operator uses its own restricted login and only the operator flag.
    delete process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED;
    delete process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED;
    process.env.SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED = 'true';
    const bucketArn = `arn:aws:s3:::${bucket}`;
    const objectArn = `${bucketArn}/${config.objectPrefix}${record.id}/*`;
    assert.ok(refs.every(ref => ref.key.startsWith(`${config.objectPrefix}${record.id}/`)));
    assert.equal(new Set(candidates.map(item => item.row.version_id)).size, candidates.length);
    const policy = { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['s3:GetBucketVersioning', 's3:GetLifecycleConfiguration'], Resource: [bucketArn] },
      { Effect: 'Allow', Action: ['s3:ListBucket', 's3:ListBucketVersions'], Resource: [bucketArn], Condition: { StringLike: { 's3:prefix': [config.objectPrefix + '*'] } } },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: [objectArn] },
      // Version IDs are distinct across the single owned upload. This exact
      // version allowlist fits STS's 2 KiB policy limit without permitting writes
      // or an unqualified DELETE anywhere under that upload's prefix.
      { Effect: 'Allow', Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'], Resource: [objectArn],
        Condition: { StringEquals: { 's3:versionid': candidates.map(item => item.row.version_id) } } },
    ] };
    assert.ok(JSON.stringify(policy).length <= 2048);
    sts = new STSClient({ endpoint, region: 'us-east-1', credentials, maxAttempts: 1 });
    const session = await sts.send(new AssumeRoleCommand({ RoleArn: 'arn:aws:iam::123456789012:role/shorts-media-cleanup',
      RoleSessionName: 'media-' + randomUUID(), DurationSeconds: 900, Policy: JSON.stringify(policy) }));
    const restricted = { accessKeyId: session.Credentials.AccessKeyId, secretAccessKey: session.Credentials.SecretAccessKey, sessionToken: session.Credentials.SessionToken };
    const cleanupConfig = { ...config, storage: { ...config.storage, credentials: restricted }, objects: { ...config.objects, credentials: restricted } };
    limited = new S3Client(cleanupConfig.storage);
    await assert.rejects(limited.send(new DeleteObjectCommand({ Bucket: bucket, Key: target.key })), error => error.$metadata?.httpStatusCode === 403);
    await assert.rejects(limited.send(new PutObjectCommand({ Bucket: bucket, Key: target.key, Body: 'forbidden' })), error => error.$metadata?.httpStatusCode === 403);
    // Boot the actual operations module with isolated config and its restricted
    // direct login. All storage, client and coordinator providers are production.
    const boot = async () => {
      const module = await Test.createTestingModule({ imports: [ShortsPrivateInputCleanupModule] })
        .overrideProvider(DataSource).useValue(operatorDb)
        .overrideProvider(SHORTS_STORAGE_RECONCILIATION_CONFIG).useValue(cleanupConfig).compile();
      modules.push(module); await module.init(); const service = module.get(Operator); await service.verify(); return service;
    };
    let service = await boot();
    const count = async table => (await owner.query(`SELECT count(*)::int n FROM ${table}`))[0].n;
    await t.test('combined media path rejects corrupt private ciphertext before requesting durability proof', async () => {
      await assert.rejects(service.reclaimMany([request(rejected)]));
      assert.equal(await count('shorts_private_input_verifications'), 0); assert.equal(await count('shorts_private_input_attempts'), 0);
    });
    await t.test('missing original or HLS pin blocks real API verification and leaves private versions intact', async () => {
      for (const cid of [record.cid, prepared.cid]) {
        await rpc('pin/rm', { arg: cid });
        try { await assert.rejects(service.reclaimMany([request(items[0])]), /verification unavailable/); }
        finally { await rpc('pin/add', { arg: cid }); }
        assert.equal(await count('shorts_private_input_attempts'), 0);
        assert.ok((await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: items[0].row.object_key, VersionId: items[0].row.version_id }))).VersionId);
      }
    });
    await t.test('altered original bytes in transit fail verification without authorizing a private DELETE', async () => {
      const realFetch = global.fetch; let altered = 0;
      global.fetch = async (url, options) => {
        const response = await realFetch(url, options), address = new URL(url);
        if (address.origin === new URL(kubo).origin && address.pathname.endsWith('/cat') && address.searchParams.get('arg') === record.cid) {
          const bytes = Buffer.from(await response.arrayBuffer()); bytes[bytes.length - 1] ^= 1; altered++;
          return new Response(bytes, { status: response.status, headers: response.headers });
        }
        return response;
      };
      try { await assert.rejects(service.reclaimMany([request(items[0])]), /verification unavailable/); }
      finally { global.fetch = realFetch; }
      assert.equal(altered, 1); assert.equal(await count('shorts_private_input_attempts'), 0);
    });
    await t.test('a hold and then genuine proof expiry prevent dispatch of the verified private version', async () => {
      const journal = new Journal(operatorDb), item = items[0], hold = randomUUID();
      await verifier.verify(item.id, randomUUID());
      const [proof] = await owner.query('SELECT id FROM shorts_private_input_verifications WHERE operation_id=$1 ORDER BY verified_at DESC LIMIT 1', [item.id]);
      const attempt = await journal.issue(scope, item.id, proof.id, randomUUID());
      await retention.hold({ id: hold, resourceId: record.id, reason: 'legal', reference: 'local-media-test' });
      try { await assert.rejects(journal.dispatch(scope, item.id, attempt.id), /retained/); }
      finally { await retention.release(hold); }
      assert.ok((await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: item.row.object_key, VersionId: item.row.version_id }))).VersionId);
      // Exercise the real SQL clock; do not mutate or renew this issued proof.
      await new Promise(resolve => setTimeout(resolve, 31000));
      await assert.rejects(journal.dispatch(scope, item.id, attempt.id), /expired/);
    });
    await t.test('a real lost DELETE response is recovered after module restart without deleting twice', async () => {
      const realFetch = global.fetch; let deletes = 0;
      global.fetch = async (url, options) => {
        const response = await realFetch(url, options);
        if (options?.method === 'DELETE' && new URL(url).origin === endpoint) {
          deletes++; assert.equal(response.status, 204); await response.body?.cancel(); throw new Error('Lost provider acknowledgement');
        }
        return response;
      };
      try { await assert.rejects(service.reclaimMany(items.map(request)), /Lost provider acknowledgement/); }
      finally { global.fetch = realFetch; }
      assert.equal(deletes, 1);
      await modules.pop().close(); service = await boot();
      assert.equal((await service.recover(items[0].id)).operation.removed, true);
      assert.ok((await service.reclaimMany(items.map(request))).every(row => row.operation.removed));
      const before = await count('shorts_private_input_attempts');
      assert.ok((await service.reclaimMany(items.map(request))).every(row => row.operation.removed));
      assert.equal(await count('shorts_private_input_attempts'), before);
    });
    await t.test('exact original and every HLS track remain durable and decodable after private cleanup', async () => {
      for (const item of items) await assert.rejects(raw.send(new HeadObjectCommand({ Bucket: bucket, Key: item.row.object_key, VersionId: item.row.version_id })), error => error.$metadata?.httpStatusCode === 404);
      // The unauthentic duplicate is deliberately quarantined, never marked removed.
      assert.equal((await service.status(rejected.id)).operation.removed, false);
      assert.ok((await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: target.key, VersionId: bad.VersionId }))).VersionId);
      assert.deepEqual(await rpc('cat', { arg: record.cid }), video);
      await media.verifyDurableDelivery(record, descriptor, prepared);
      const playback = join(dir, 'playback'); await mkdir(playback);
      for (const file of prepared.files) {
        const bytes = await rpc('cat', { arg: `/ipfs/${prepared.cid}/${file.name}` });
        assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256); await writeFile(join(playback, file.name), bytes);
      }
      for (const name of Object.keys(prepared.playlists)) {
        await execFile('ffmpeg', ['-nostdin', '-v', 'error', '-i', join(playback, name), '-f', 'null', '-'], { timeout: 30000 });
      }
      const result = await execFile('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(playback, 'v1080.m3u8')]);
      const stream = JSON.parse(result.stdout).streams[0];
      assert.equal(stream.width, 1080); assert.equal(stream.height, 1920); assert.equal(stream.r_frame_rate, '60/1');
      assert.deepEqual((await shorts.ensurePlayable(record.id)).original, record.original);
      assert.equal((await shorts.ensurePlayable(record.id)).cid, record.cid);
      const freshScan = randomUUID(); await inspector.start(freshScan, inventory);
      await drain(() => inspector.step(freshScan), 'referenceTraversalComplete');
      const references = await owner.query('SELECT DISTINCT object_key FROM shorts_storage_references WHERE run_id=$1', [freshScan]);
      assert.deepEqual(references.map(row => row.object_key).sort(), refs.map(ref => ref.key).sort());
      t.diagnostic(JSON.stringify({ originalBytes: video.length, hlsBytes: prepared.files.reduce((sum, file) => sum + file.bytes, 0),
        privateVersionsRemoved: items.length, privateCiphertextBytesRemoved: items.reduce((sum, item) => sum + Number(item.row.bytes), 0),
        quarantinedVersions: 1, decodedVideoTracks: master.videos.length, decodedAudioTracks: master.audio.length }));
    });
    if (process.env.SHORTS_TEST_INPUT_RECLAMATION === '1') {
      await require('./input-reclamation-media.cjs').exercise({ ...f, descriptor, prepared, rpc, retention, transcoder });
    }
  } finally {
    for (const module of modules.reverse()) await module.close();
    await control?.close(); await verifier?.onModuleDestroy(); await retirement?.onModuleDestroy();
    listing?.onModuleDestroy(); limited?.destroy(); sts?.destroy();
    await transcoder.onModuleDestroy(); disk.onModuleDestroy();
    for (const connection of connections) if (connection.isInitialized) await connection.destroy();
    for (const role of roles) await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
};
