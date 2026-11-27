const schemaMigrations = require('./testing/schema-migrations.cjs');
const {
  ShortsReclamationRelease: Migration,
  ShortsStorageRecovery: RecoveryMigration,
} = schemaMigrations;
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const {
  ShortsDeliveryPackagesService,
} = require('./shorts-delivery-packages.service');
const {
  ShortsDeliverySelectionService,
} = require('./shorts-delivery-selection.service');
const {
  ShortsDeliveryInputRetirementService,
} = require('./shorts-delivery-input-retirement.service');
const {
  ShortsInputReclamationReservationsService,
} = require('./shorts-input-reclamation-reservations.service');
const {
  ShortsInputReclamationPermitsService,
} = require('./shorts-input-reclamation-permits.service');
const {
  ShortsReclamationReleaseService,
} = require('./shorts-reclamation-release.service');
const {
  ShortsInputReclamationService,
} = require('./shorts-input-reclamation.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsPinTransfersService } = require('./shorts-pin-transfers.service');
const {
  ShortsStorageRecoveriesService,
} = require('./shorts-storage-recoveries.service');
const {
  ShortsStorageRecoveryService,
} = require('./shorts-storage-recovery.service');
const { reclamationStorage } = require('./shorts-reclamation-storage');
const { workerRole } = require('./testing/worker-role.cjs');
const golden = structuredClone(require('./testing/hls-v3.json'));
golden.descriptor.derivatives.cid =
  'bafybeiarceirceirceirceirceirceirceirceirceirceirceirceirce';
golden.sourceKey = require('./hls-protocol/hls-package').sourceKey(
  golden.descriptor,
);
const epoch = '1'.repeat(64),
  peer = '1'.repeat(40);
const caps = () => ({
  version: 1,
  epochVersion: 1,
  nodeEpoch: epoch,
  peerId: peer,
  unpinMaxLifetimeMs: 30000,
  unpinTimeoutMs: 10000,
  addVersion: 1,
  legacyWritesEnabled: false,
  writing: false,
  uncertain: false,
  serverTimeUnixMs: Date.now(),
  clockGuardVersion: 1,
  clockMaxDriftMs: 5000,
});
const coordinator = (f, enabled = true) => {
  const keys = [
      'SHORTS_DELIVERY_INPUT_RECLAMATION_ENABLED',
      'SHORTS_IPFS_EXPIRING_WRITES',
    ],
    old = keys.map((k) => process.env[k]);
  process.env[keys[0]] = String(enabled);
  process.env[keys[1]] = 'true';
  try {
    return new ShortsInputReclamationService(
      f.shorts,
      f.media,
      f.selections,
      f.reservations,
      f.permits,
      f.releases,
    );
  } finally {
    keys.forEach((k, i) =>
      old[i] === undefined ? delete process.env[k] : (process.env[k] = old[i]),
    );
  }
};
async function fixture(t, withRecovery = false) {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_reclaim_' + randomUUID().replaceAll('-', '');
  const admin = new DataSource({ type: 'postgres', url: url.href });
  await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new DataSource({
    type: 'postgres',
    url: url.href,
    schema,
    extra: { options: `-c search_path=${schema}`, max: 8 },
  });
  await db.initialize();
  let worker, identity;
  t.after(async () => {
    await worker?.destroy();
    await db.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await identity?.dispose();
    await admin.destroy();
  });
  await db.transaction(async (sql) => {
    for (const name of [
      'ShortsMetadata',
      'ShortsUploads',
      'ShortsWorkers',
      'ShortsWorkerAuthority',
      'ShortsProcessingCapacity',
      'ShortsRetentionHolds',
      'ShortsHlsInventory',
      'ShortsPinInventory',
      'ShortsWorkerBackpressure',
      'ShortsUploadBudget',
      'ShortsOriginalContent',
      'ShortsAdaptiveInventory',
      'ShortsDeliveryPackages',
      'ShortsDeliveryGenerations',
      'ShortsGenerationDeliveryPackages',
      'ShortsDeliveryStaging',
      'ShortsDeliverySelection',
      'ShortsDeliveryInputRetirement',
      'ShortsInputReclamationReservations',
      'ShortsPinTransfers',
      'ShortsInputReclamationPermits',
      'ShortsStorageWriteEpochs',
    ])
      await new schemaMigrations[name]().up(sql);
    await new Migration().up(sql);
  });
  await db.transaction((sql) => new Migration().down(sql));
  await db.transaction((sql) => new Migration().up(sql));
  if (withRecovery) {
    await db.transaction((sql) => new RecoveryMigration().up(sql));
    await db.transaction((sql) => new RecoveryMigration().down(sql));
    await db.transaction((sql) => new RecoveryMigration().up(sql));
  }
  const scope = {
    network: golden.descriptor.network,
    contract: golden.descriptor.contract,
  };
  const original = {
    ...structuredClone(golden.descriptor),
    creator: 'ak_creator',
    title: 'Original',
    topic: 'Art',
    duration: 4,
    createdAt: 1,
    publication: 'published',
    moderation: 'approved',
    safety: {
      status: 'no_flags',
      sourceSha256: golden.descriptor.original.sha256,
    },
    reports: 0,
    views: ['existing'],
    likes: 42,
  };
  const metadata = new ShortsMetadataService(db);
  await metadata.initialize(scope, 'a'.repeat(64), 30, 30);
  await db.query(
    'INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [
      scope.network,
      scope.contract,
      original.id,
      original.creator,
      JSON.stringify(original),
    ],
  );
  const packages = new ShortsDeliveryPackagesService(db);
  await packages.acknowledge(golden.descriptor, golden.package);
  // Owner-only aging in this disposable schema. Production roles cannot change these clocks.
  await db.transaction(async (sql) => {
    await sql.query(
      'ALTER TABLE shorts_delivery_packages DISABLE TRIGGER shorts_delivery_package_guard',
    );
    await sql.query(
      "UPDATE shorts_delivery_packages SET acknowledged_at=clock_timestamp()-interval '2 hours'",
    );
    await sql.query(
      'ALTER TABLE shorts_delivery_packages ENABLE TRIGGER shorts_delivery_package_guard',
    );
  });
  await new ShortsDeliveryInputRetirementService(db).commit(
    scope,
    original.id,
    golden.sourceKey,
    randomUUID(),
  );
  const reservations = new ShortsInputReclamationReservationsService(db),
    permits = new ShortsInputReclamationPermitsService(db),
    releases = new ShortsReclamationReleaseService(db);
  const media = {
    checks: 0,
    unpins: 0,
    inspection: true,
    pinnedNow: false,
    async verifyDurableDelivery(record, descriptor, hls, signal) {
      signal.throwIfAborted();
      this.checks++;
      assert.equal(record.cid, original.cid);
      assert.equal(hls.cid, golden.package.cid);
      if (!this.inspection) throw new Error('retained bytes corrupt');
    },
    async reclamationStorage() {
      return reclamationStorage({
        ...caps(),
        nodeEpoch: this.nodeEpoch || epoch,
      });
    },
    async reclaimInputPin() {
      this.unpins++;
      return 'removed';
    },
    async pinned() {
      return this.pinnedNow;
    },
  };
  const shorts = {
    chain: { release: scope, state: { contract: scope.contract } },
    ensurePlayable: async () => original,
  };
  const selections = new ShortsDeliverySelectionService(db);
  const f = {
    db,
    scope,
    original,
    reservations,
    permits,
    releases,
    media,
    shorts,
    selections,
    cid: original.derivatives.cid,
  };
  f.age = async (operation) =>
    db.transaction(async (sql) => {
      await sql.query(
        'ALTER TABLE shorts_input_reclamation_permits DISABLE TRIGGER shorts_input_reclamation_permit_guard',
      );
      await sql.query(
        "UPDATE shorts_input_reclamation_permits SET issued_at=clock_timestamp()-interval '120 seconds',expires_at=clock_timestamp()-interval '100 seconds',quiet_until=clock_timestamp()-interval '70 seconds' WHERE operation_id=$1",
        [operation],
      );
      await sql.query(
        'ALTER TABLE shorts_input_reclamation_permits ENABLE TRIGGER shorts_input_reclamation_permit_guard',
      );
    });
  f.worker = async () => {
    identity = await workerRole(admin, { url: url.href, schema, scope });
    worker = new DataSource({
      type: 'postgres',
      url: identity.url,
      schema,
      extra: { options: `-c search_path=${schema}` },
    });
    await worker.initialize();
    return worker;
  };
  return f;
}

test('reclamation capabilities reject legacy, quarantined, busy, unsynchronized and unguarded nodes', () => {
  assert.equal(reclamationStorage(caps()).nodeEpoch, epoch);
  for (const change of [
    { legacyWritesEnabled: true },
    { uncertain: true },
    { writing: true },
    { clockGuardVersion: undefined },
    { clockMaxDriftMs: 6000 },
    { serverTimeUnixMs: Date.now() - 6000 },
    { nodeEpoch: 'bad' },
    { peerId: 'bad' },
    { unpinTimeoutMs: 20000 },
    { unpinMaxLifetimeMs: 60000 },
  ])
    assert.throws(() => reclamationStorage({ ...caps(), ...change }));
  const value = reclamationStorage({ ...caps(), secret: 'must not persist' });
  assert.equal(value.secret, undefined);
});

test('unpin HTTP uses the exact bound permit, checks every receipt field, and never falls back', async () => {
  const service = new ShortsMediaService({});
  const permit = {
    operationId: randomUUID(),
    reservationId: randomUUID(),
    inputCid: golden.descriptor.derivatives.cid,
    state: 'issued',
    expires: Date.now() + 20000,
    storage: { peerId: peer, epoch, boundAt: new Date().toISOString() },
  };
  const valid = {
    version: 1,
    cid: permit.inputCid,
    operation: permit.operationId,
    expires: permit.expires,
    status: 'removed',
    epoch,
  };
  let response = valid,
    calls = 0;
  service.ipfsFetch = async (path, init) => {
    calls++;
    const url = new URL('http://127.0.0.1/' + path);
    assert.equal(url.pathname, '/shorts/unpin');
    assert.equal(url.searchParams.get('arg'), permit.inputCid);
    assert.equal(url.searchParams.get('epoch'), epoch);
    assert.equal(init.body, undefined);
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify(response));
  };
  assert.equal(
    await service.reclaimInputPin(permit, new AbortController().signal),
    'removed',
  );
  for (const changed of [
    { cid: golden.descriptor.cid },
    { operation: randomUUID() },
    { expires: permit.expires + 1 },
    { status: 'ok' },
    { epoch: '2'.repeat(64) },
    { version: 2 },
  ]) {
    response = { ...valid, ...changed };
    await assert.rejects(
      service.reclaimInputPin(permit, new AbortController().signal),
      /receipt mismatch/,
    );
  }
  const before = calls;
  await assert.rejects(service.reclaimInputPin(permit, AbortSignal.abort()));
  assert.equal(calls, before);
  await service.onModuleDestroy();
});

test(
  'known input reclamation is single-dispatch and releases only with durable fresh quiescence proof',
  { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      run = coordinator(f);
    t.after(() => run.onModuleDestroy());
    const disabled = coordinator(f, false);
    t.after(() => disabled.onModuleDestroy());
    await assert.rejects(disabled.reclaim(f.cid, randomUUID()), /disabled/);
    const configuredChain = f.shorts.chain;
    f.shorts.chain = {
      release: { ...f.scope, contract: 'ct_other' },
      state: { contract: 'ct_other' },
    };
    const foreign = randomUUID();
    await assert.rejects(run.reclaim(f.cid, foreign), /configured deployment/);
    assert.equal(f.media.checks, 0);
    assert.equal((await f.reservations.get(foreign)).state, 'released');
    f.shorts.chain = configuredChain;
    f.media.inspection = false;
    const failed = randomUUID();
    await assert.rejects(run.reclaim(f.cid, failed), /retained bytes/);
    assert.equal((await f.reservations.get(failed)).state, 'released');
    assert.equal(await f.permits.get(failed), undefined);
    assert.equal(f.media.unpins, 0);
    f.media.inspection = true;
    const operation = randomUUID();
    await Promise.all([
      run.reclaim(f.cid, operation),
      run.reclaim(f.cid, operation),
    ]);
    assert.equal(f.media.unpins, 1);
    assert.equal((await f.permits.get(operation)).state, 'removed');
    await run.reclaim(f.cid, operation);
    assert.equal(f.media.unpins, 1);
    await assert.rejects(run.release(operation), /quiet period/);
    await f.age(operation);
    await assert.rejects(
      f.reservations.cancel(operation),
      /Fresh storage release proof/,
    );
    await assert.rejects(
      f.db.query(
        `INSERT INTO shorts_input_reclamation_releases
    (operation_id,input_cid,node_peer_id,node_epoch,observed_at,observed_pin,clock_guard_version)
    VALUES($1,$2,$3,$4,clock_timestamp(),false,1)`,
        [operation, f.cid, peer, epoch],
      ),
      /commit together/,
    );
    assert.equal(await f.releases.get(operation), undefined);
    await assert.rejects(
      f.releases.commit(
        operation,
        { ...reclamationStorage(caps()), serverTimeUnixMs: Date.now() - 6000 },
        false,
      ),
      /Known quiescent/,
    );
    f.media.pinnedNow = true;
    await assert.rejects(run.release(operation), /Known quiescent storage/);
    f.media.pinnedNow = false;
    const normal = f.media.reclamationStorage;
    f.media.reclamationStorage = async () => {
      throw new Error('storage quarantined');
    };
    await assert.rejects(run.release(operation), /quarantined/);
    assert.equal((await f.reservations.get(operation)).state, 'reserved');
    f.media.reclamationStorage = async () => ({
      ...(await normal()),
      nodeEpoch: '2'.repeat(64),
    });
    await assert.rejects(run.release(operation), /Storage recovery/);
    f.media.reclamationStorage = normal;
    let probes = 0;
    f.media.reclamationStorage = async () => ({
      ...(await normal()),
      nodeEpoch: ++probes === 1 ? epoch : '2'.repeat(64),
    });
    await assert.rejects(run.release(operation), /changed during release/);
    f.media.reclamationStorage = normal;
    const hold = randomUUID();
    await f.db.query(
      `INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
    VALUES($1,$2,$3,$4,'recovery','disposable-fixture')`,
      [f.scope.network, f.scope.contract, hold, f.original.id],
    );
    await assert.rejects(run.release(operation));
    assert.equal(await f.releases.get(operation), undefined);
    await f.db.query(
      'UPDATE shorts_retention_holds SET released_by=current_user,released_at=clock_timestamp() WHERE id=$1',
      [hold],
    );
    const receipt = await run.release(operation);
    assert.equal(receipt.input_cid, f.cid);
    assert.equal((await f.reservations.get(operation)).state, 'released');
    assert.deepEqual(await disabled.release(operation), receipt);
    assert.deepEqual(
      (
        await f.db.query('SELECT body FROM shorts_content WHERE id=$1', [
          f.original.id,
        ])
      )[0].body,
      f.original,
    );
    for (const sql of [
      'DELETE FROM shorts_input_reclamation_releases',
      'TRUNCATE shorts_input_reclamation_releases',
      'UPDATE shorts_input_reclamation_releases SET observed_pin=true',
    ])
      await assert.rejects(f.db.query(sql), /immutable/);
    await assert.rejects(
      f.db.transaction((db) => new Migration().down(db)),
      /Preserve bound/,
    );
    const worker = await f.worker();
    await assert.rejects(
      worker.query('SELECT * FROM shorts_input_reclamation_releases'),
      { code: '42501' },
    );
  },
);

test(
  'unknown unpin outcomes stay fenced after expiry, retries, and process restart',
  { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      run = coordinator(f);
    t.after(() => run.onModuleDestroy());
    f.media.reclaimInputPin = async () => {
      f.media.unpins++;
      throw new Error('connection lost');
    };
    const operation = randomUUID();
    await assert.rejects(run.reclaim(f.cid, operation), /connection lost/);
    assert.equal((await f.permits.get(operation)).state, 'uncertain');
    await f.age(operation);
    const restarted = coordinator(f);
    t.after(() => restarted.onModuleDestroy());
    await restarted.reclaim(f.cid, operation);
    assert.equal(f.media.unpins, 1);
    await assert.rejects(restarted.release(operation), /known bound/);
    await assert.rejects(f.reservations.cancel(operation));
    await assert.rejects(
      f.permits.finish(operation, 'removed'),
      /already settled/,
    );
    assert.equal(await f.releases.get(operation), undefined);
  },
);

const recovery = (t, f, enabled = true) => {
  f.pins ||= new ShortsPinTransfersService(f.db);
  f.recoveries ||= new ShortsStorageRecoveriesService(f.db);
  const run = coordinator(f);
  t.after(() => run.onModuleDestroy());
  const keys = [
      'SHORTS_STORAGE_RECOVERY_ENABLED',
      'SHORTS_IPFS_EXPIRING_WRITES',
    ],
    previous = keys.map((key) => process.env[key]);
  process.env[keys[0]] = String(enabled);
  process.env[keys[1]] = 'true';
  try {
    const service = new ShortsStorageRecoveryService(
      f.recoveries,
      f.pins,
      f.permits,
      run,
      f.media,
    );
    t.after(() => service.onModuleDestroy());
    return service;
  } finally {
    keys.forEach((key, i) =>
      previous[i] === undefined
        ? delete process.env[key]
        : (process.env[key] = previous[i]),
    );
  }
};
const agePin = (f, operation) =>
  f.db.transaction(async (db) => {
    // Only the owner of this disposable schema can age immutable authority.
    await db.query(
      'ALTER TABLE shorts_pin_transfers DISABLE TRIGGER shorts_pin_transfer_guard',
    );
    await db.query(
      "UPDATE shorts_pin_transfers SET issued_at=clock_timestamp()-interval '300 seconds',expires_at=clock_timestamp()-interval '120 seconds',quiet_until=clock_timestamp()-interval '90 seconds' WHERE operation_id=$1",
      [operation],
    );
    await db.query(
      'ALTER TABLE shorts_pin_transfers ENABLE TRIGGER shorts_pin_transfer_guard',
    );
  });

test(
  'unpin recovery requires verified retained media and a healthy new process, then atomically releases without rewriting uncertainty',
  { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 },
  async (t) => {
    const f = await fixture(t, true),
      run = coordinator(f),
      recover = recovery(t, f),
      disabled = recovery(t, f, false);
    t.after(() => run.onModuleDestroy());
    f.media.reclaimInputPin = async () => {
      f.media.unpins++;
      throw new Error('lost response');
    };
    const operation = randomUUID();
    await assert.rejects(run.reclaim(f.cid, operation), /lost response/);
    await assert.rejects(disabled.recover('unpin', operation), /disabled/);
    await assert.rejects(recover.recover('unpin', operation), /quiet period/);
    await assert.rejects(
      f.recoveries.commit(
        'unpin',
        operation,
        { ...reclamationStorage(caps()), nodeEpoch: '2'.repeat(64) },
        false,
      ),
      /Fresh recovered/,
    );
    await f.age(operation);
    const authority = await f.permits.get(operation);
    await assert.rejects(
      recover.recover('unpin', operation),
      /restarted process/,
    );
    f.media.nodeEpoch = '2'.repeat(64);
    f.media.inspection = false;
    await assert.rejects(recover.recover('unpin', operation), /retained bytes/);
    f.media.inspection = true;
    const storage = await f.media.reclamationStorage();
    await assert.rejects(
      f.recoveries.commit(
        'unpin',
        operation,
        { ...storage, serverTimeUnixMs: Date.now() - 6000 },
        false,
      ),
      /Fresh recovered/,
    );
    await assert.rejects(
      f.recoveries.commit(
        'unpin',
        operation,
        { ...storage, nodeEpoch: epoch },
        false,
      ),
      /Fresh recovered/,
    );
    await assert.rejects(
      f.recoveries.commit(
        'unpin',
        operation,
        { ...storage, peerId: '3'.repeat(40) },
        false,
      ),
      /Fresh recovered/,
    );
    await assert.rejects(
      f.db.query(
        `INSERT INTO shorts_storage_recoveries
      (kind,operation_id,cid,prior_state,previous_node_epoch,node_peer_id,node_epoch,observed_at,observed_pin,clock_guard_version)
      VALUES('unpin',$1,$2,'uncertain',$3,$4,$5,clock_timestamp(),false,1)`,
        [operation, f.cid, epoch, peer, f.media.nodeEpoch],
      ),
      /commit together/,
    );
    assert.equal(await f.recoveries.get('unpin', operation), undefined);
    const normal = f.media.reclamationStorage;
    let probes = 0;
    f.media.reclamationStorage = async () => ({
      ...(await normal.call(f.media)),
      nodeEpoch: ++probes === 1 ? '2'.repeat(64) : '3'.repeat(64),
    });
    await assert.rejects(
      recover.recover('unpin', operation),
      /changed during recovery/,
    );
    f.media.reclamationStorage = normal;
    const hold = randomUUID();
    await f.db.query(
      `INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
      VALUES($1,$2,$3,$4,'recovery','disposable-fixture')`,
      [f.scope.network, f.scope.contract, hold, f.original.id],
    );
    await assert.rejects(recover.recover('unpin', operation));
    await assert.rejects(
      f.recoveries.commit(
        'unpin',
        operation,
        await f.media.reclamationStorage(),
        false,
      ),
      /retained by policy/,
    );
    assert.equal(await f.recoveries.get('unpin', operation), undefined);
    assert.equal((await f.reservations.get(operation)).state, 'invalidated');
    await f.db.query(
      'UPDATE shorts_retention_holds SET released_by=current_user,released_at=clock_timestamp() WHERE id=$1',
      [hold],
    );
    await assert.rejects(
      recover.recover('unpin', operation, AbortSignal.abort()),
    );
    const [one, two] = await Promise.all([
      recover.recover('unpin', operation),
      recover.recover('unpin', operation),
    ]);
    assert.deepEqual(one, two);
    assert.equal(one.prior_state, 'uncertain');
    assert.equal(one.previous_node_epoch, epoch);
    assert.equal(one.node_epoch, f.media.nodeEpoch);
    assert.equal(one.observed_pin, false);
    assert.deepEqual(await f.permits.get(operation), authority);
    assert.equal(f.media.unpins, 1);
    assert.equal((await f.reservations.get(operation)).state, 'released');
    assert.deepEqual(await disabled.recover('unpin', operation), one);
    assert.deepEqual(
      (
        await f.db.query('SELECT body FROM shorts_content WHERE id=$1', [
          f.original.id,
        ])
      )[0].body,
      f.original,
    );
    for (const query of [
      'DELETE FROM shorts_storage_recoveries',
      'TRUNCATE shorts_storage_recoveries',
      "UPDATE shorts_storage_recoveries SET prior_state='removed'",
    ])
      await assert.rejects(f.db.query(query), /immutable/);
    await assert.rejects(
      f.db.transaction((db) => new RecoveryMigration().down(db)),
      /Preserve storage recovery/,
    );
    const worker = await f.worker();
    await assert.rejects(
      worker.query('SELECT * FROM shorts_storage_recoveries'),
      { code: '42501' },
    );
  },
);

test(
  'pin recovery resolves every expired transfer separately without reviving publication authority or issuing storage mutations',
  { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 },
  async (t) => {
    const f = await fixture(t, true),
      recover = recovery(t, f);
    const operations = [randomUUID(), randomUUID()];
    for (const operation of operations) {
      await f.pins.begin(
        f.scope,
        { cid: f.cid, jobId: f.original.id, purpose: 'inputs' },
        operation,
      );
      await f.pins.bind(operation, { peerId: peer, epoch });
      await agePin(f, operation);
    }
    await f.pins.finish(operations[1], 'uncertain');
    const initial = await Promise.all(operations.map((id) => f.pins.get(id)));
    await assert.rejects(
      f.reservations.reserve(f.cid, randomUUID()),
      /outstanding pin transfers/,
    );
    f.media.nodeEpoch = '2'.repeat(64);
    f.media.pinnedNow = true;
    const commit = f.recoveries.commit.bind(f.recoveries);
    f.recoveries.commit = async (...args) => {
      await commit(...args);
      throw new Error('lost database acknowledgement');
    };
    const first = await recover.recover('pin', operations[0]);
    f.recoveries.commit = commit;
    assert.equal(first.observed_pin, true);
    assert.equal(first.prior_state, 'issued');
    await assert.rejects(
      f.reservations.reserve(f.cid, randomUUID()),
      /outstanding pin transfers/,
    );
    await assert.rejects(
      f.pins.finish(operations[0], 'rejected'),
      /Recovered storage authority is immutable/,
    );
    f.media.pinnedNow = false;
    const second = await recover.recover('pin', operations[1]);
    assert.equal(second.observed_pin, false);
    assert.deepEqual(
      await Promise.all(operations.map((id) => f.pins.get(id))),
      initial,
    );
    const reserved = await f.reservations.reserve(f.cid, randomUUID());
    assert.equal(reserved.state, 'reserved');
    await f.reservations.cancel(reserved.operationId);
    const unbound = await f.pins.begin(f.scope, {
      cid: f.original.cid,
      jobId: f.original.id,
      purpose: 'original',
    });
    await agePin(f, unbound.operationId);
    await assert.rejects(
      recover.recover('pin', unbound.operationId),
      /previously bound/,
    );
    await assert.rejects(
      f.recoveries.commit(
        'pin',
        unbound.operationId,
        await f.media.reclamationStorage(),
        false,
      ),
      /Fresh recovered/,
    );
    assert.equal(await f.recoveries.get('pin', unbound.operationId), undefined);
    assert.equal(f.media.checks, 0);
    assert.equal(f.media.unpins, 0);
    const newTransfer = await f.pins.begin(f.scope, {
      cid: f.cid,
      jobId: f.original.id,
      purpose: 'inputs',
    });
    assert.notEqual(newTransfer.operationId, operations[0]);
    assert.equal(newTransfer.state, 'issued');
    await assert.rejects(
      f.reservations.reserve(f.cid, randomUUID()),
      /outstanding pin transfers/,
    );
  },
);

test(
  'a known unpin can recover after restart and issued authority cannot be settled after its recovery',
  { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000 },
  async (t) => {
    for (const known of [true, false]) {
      await t.test(
        known ? 'known outcome' : 'crashed before outcome',
        async (t) => {
          const f = await fixture(t, true),
            run = coordinator(f),
            recover = recovery(t, f),
            operation = randomUUID();
          t.after(() => run.onModuleDestroy());
          if (known) await run.reclaim(f.cid, operation);
          else {
            await f.reservations.reserve(f.cid, operation);
            await f.permits.issue(operation, operation);
            await f.permits.bind(operation, { peerId: peer, epoch });
          }
          await f.age(operation);
          const authority = await f.permits.get(operation);
          f.media.nodeEpoch = '2'.repeat(64);
          f.media.pinnedNow = true;
          if (known)
            await assert.rejects(run.release(operation), /Storage recovery/);
          const record = await recover.recover('unpin', operation);
          assert.equal(record.observed_pin, true);
          assert.equal(record.prior_state, known ? 'removed' : 'issued');
          assert.deepEqual(await f.permits.get(operation), authority);
          if (!known)
            await assert.rejects(
              f.permits.finish(operation, 'removed'),
              /Recovered storage authority is immutable/,
            );
          assert.equal((await f.reservations.get(operation)).state, 'released');
        },
      );
    }
  },
);
