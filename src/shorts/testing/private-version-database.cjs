const schemaMigrations = require('./historical-migrations.cjs');
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');

async function migratePrivateVersionTables(runner) {
  for (const name of [
    'ShortsMetadata',
    'ShortsUploads',
    'ShortsWorkers',
    'ShortsWorkerAuthority',
    'ShortsProcessingCapacity',
    'ShortsRetentionHolds',
    'ShortsStorageInventory',
    'ShortsStorageReferences',
    'ShortsHlsInventory',
    'ShortsWorkerBackpressure',
    'ShortsUploadBudget',
    'ShortsOriginalContent',
    'ShortsAdaptiveInventory',
    'ShortsDeliveryPackages',
    'ShortsDeliveryGenerations',
    'ShortsFileStorageReferences',
    'ShortsGenerationDeliveryPackages',
    'ShortsDeliveryStaging',
  ])
    await new schemaMigrations[name]().up(
      runner,
    );
  await new schemaMigrations.ShortsPrivateVersionCleanup().up(runner);
}

async function privateVersionDatabase(t, config, ref) {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.equal(url.hostname, '127.0.0.1');
  const schema = 'shorts_provider_' + randomUUID().replaceAll('-', '');
  const role = 'shprovider_' + randomUUID().replaceAll('-', ''),
    password = randomUUID();
  const admin = new DataSource({ type: 'postgres', url: url.href });
  await admin.initialize();
  let owner,
    db,
    roleCreated = false;
  t.after(async () => {
    if (db?.isInitialized) await db.destroy();
    if (owner?.isInitialized) await owner.destroy();
    if (roleCreated)
      await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.destroy();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = {
    type: 'postgres',
    url: url.href,
    schema,
    extra: { options: `-c search_path=${schema}`, max: 3 },
  };
  owner = new DataSource(options);
  await owner.initialize();
  await owner.transaction(migratePrivateVersionTables);
  const args = [config.scope.network, config.scope.contract];
  await owner.query(
    'INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending) VALUES($1,$2,$3,8,2)',
    [...args, config.sourceHash],
  );
  const record = {
    id: 'job',
    creator: 'ak_creator',
    createdAt: 1,
    bytes: ref.bytes,
    publication: 'published',
    privateMedia: { files: { video: ref } },
  };
  await owner.query(
    'INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [...args, record.id, record.creator, record],
  );
  const readTables = [
    'shorts_runtime',
    'shorts_content',
    'shorts_ingestion',
    'shorts_upload_sessions',
    'shorts_upload_parts',
    'shorts_delivery_packages',
    'shorts_delivery_generations',
    'shorts_delivery_staging',
    'shorts_retention_holds',
    'shorts_storage_inventory_runs',
    'shorts_storage_inventory_objects',
    'shorts_storage_reconciliations',
    'shorts_storage_reference_roots',
    'shorts_storage_references',
    'shorts_private_storage_epochs',
  ];
  await admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  roleCreated = true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ${readTables.map((name) => schema + '.' + name).join(',')} TO ${role};
    GRANT SELECT,INSERT ON ${schema}.shorts_private_version_cleanup,${schema}.shorts_private_version_events TO ${role}`);
  const login = new URL(url);
  login.username = role;
  login.password = password;
  const loginOptions = { ...options, url: login.href };
  db = new DataSource(loginOptions);
  await db.initialize();
  return { owner, db, loginOptions, record, args };
}
module.exports = { migratePrivateVersionTables, privateVersionDatabase };
