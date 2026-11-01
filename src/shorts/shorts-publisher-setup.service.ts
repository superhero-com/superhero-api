import {
  ShortsNativeImportService,
  NativeSnapshot,
  readShortsMigrationSnapshot,
} from './shorts-native-import.service';
import {
  ShortsLegacyImportService,
  LegacySnapshot,
} from './shorts-legacy-import.service';
import { shortsConfigJson } from './shorts-release';
import { ShortsDatabaseService } from './shorts-database.service';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsMetadataService } from './shorts-metadata.service';
import { ShortsPublicationsService } from './shorts-publications.service';
import { publishingDeployment } from './shorts-publisher.config';
import { shortsUploadBudgetConfig } from './shorts-upload-budget';

/** Explicit one-time provisioning with the migration login, never a runtime provider. */
@Injectable()
export class ShortsPublisherSetupService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly metadata: ShortsMetadataService,
    private readonly journal: ShortsPublicationsService,
    private readonly migration: ShortsLegacyImportService,
    private readonly nativeMigration: ShortsNativeImportService,
  ) {}
  async setup(env: NodeJS.ProcessEnv = process.env) {
    const uploadBudget = shortsUploadBudgetConfig(env);
    if (
      env.AE_NETWORK_ID !== 'ae_uat' ||
      env.ENABLE_SHORTS !== 'true' ||
      env.SHORTS_TESTNET_MVP !== '1' ||
      env.SHORTS_OPERATOR_KEY_FILE
    )
      throw new Error(
        'Setup requires public testnet configuration, without a signing key',
      );
    const deployment = await publishingDeployment(env);
    const roles = [
      [env.SHORTS_PUBLISHER_API_ROLE, 'api'],
      [env.SHORTS_PUBLISHER_DB_ROLE, 'publisher'],
    ];
    if (
      roles.some(([name]) => !name || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) ||
      roles[0][0] === roles[1][0]
    )
      throw new Error('Provide two distinct pre-created database login roles');
    await this.metadata.initialize(deployment.scope, deployment.sourceHash);
    const contentScope = deployment.content
      ? {
          network: deployment.scope.network,
          contract: deployment.content.contract,
        }
      : deployment.scope;
    if (deployment.content)
      await this.metadata.verifyRuntime(
        contentScope,
        deployment.content.sourceHash,
      );
    await this.journal.initialize(
      deployment.scope,
      deployment.sourceHash,
      deployment.operator,
      deployment.policy,
      deployment.content,
    );
    let verifiedSnapshot: LegacySnapshot | NativeSnapshot | undefined;
    if (deployment.content) {
      if (
        !env.SHORTS_LEGACY_SNAPSHOT_FILE ||
        !env.SHORTS_CONTRACT_MIGRATION_CONFIG
      )
        throw new Error(
          'An imported release requires its verified migration snapshot',
        );
      const snapshot: LegacySnapshot | NativeSnapshot =
        await readShortsMigrationSnapshot(env.SHORTS_LEGACY_SNAPSHOT_FILE);
      if (
        snapshot.destination !== deployment.scope.contract ||
        snapshot.network !== deployment.scope.network
      )
        throw new Error('Snapshot does not match publication scope');
      const migrationConfig = await shortsConfigJson(
        env.SHORTS_CONTRACT_MIGRATION_CONFIG,
      );
      if (snapshot.version === 2 && snapshot.kind === 'native') {
        await this.nativeMigration.initialize(migrationConfig);
        await this.nativeMigration.verifyBaseline(snapshot);
      } else if (
        snapshot.version === 1 &&
        snapshot.source === deployment.content.contract &&
        migrationConfig.kind !== 'native'
      ) {
        await this.migration.initialize(migrationConfig);
        await this.migration.canonical(snapshot.cutoff);
        await this.migration.verifyBaseline(snapshot);
      } else throw new Error('Snapshot migration kind or predecessor mismatch');
      verifiedSnapshot = snapshot;
    }
    await this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
      if (verifiedSnapshot) {
        const snapshot = verifiedSnapshot;
        const values = [
          snapshot.network,
          snapshot.destination,
          snapshot.source,
          snapshot.cutoff.hash,
          snapshot.cutoff.height,
          snapshot.commitment,
          snapshot.videos.length,
          snapshot.videos.reduce((n, v) => n + v.likes.length, 0),
        ];
        await db.query(
          `INSERT INTO shorts_import_snapshots(network,contract,source,cutoff_hash,cutoff_height,digest,videos,likes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          values,
        );
        const [saved] = await db.query(
          'SELECT * FROM shorts_import_snapshots WHERE network=$1 AND contract=$2 FOR UPDATE',
          values.slice(0, 2),
        );
        if (
          saved.digest !== snapshot.commitment ||
          saved.cutoff_hash !== snapshot.cutoff.hash ||
          Number(saved.cutoff_height) !== snapshot.cutoff.height ||
          saved.source !== snapshot.source ||
          Number(saved.videos) !== snapshot.videos.length ||
          Number(saved.likes) !== values[7]
        )
          throw new Error('Import baseline changed');
        for (const video of snapshot.videos) {
          await db.query(
            `INSERT INTO shorts_import_videos(network,contract,id,likes,withdrawn) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [
              snapshot.network,
              snapshot.destination,
              video.id,
              video.likes.length,
              video.withdrawn,
            ],
          );
          const [row] = await db.query(
            'SELECT likes,withdrawn FROM shorts_import_videos WHERE network=$1 AND contract=$2 AND id=$3',
            [snapshot.network, snapshot.destination, video.id],
          );
          if (
            Number(row.likes) !== video.likes.length ||
            row.withdrawn !== video.withdrawn
          )
            throw new Error('Import baseline row changed');
        }
        const [{ count }] = await db.query(
          'SELECT count(*) FROM shorts_import_videos WHERE network=$1 AND contract=$2',
          values.slice(0, 2),
        );
        if (Number(count) !== snapshot.videos.length)
          throw new Error('Unexpected import baseline rows');
      }
      const [{ schema }] = await db.query('SELECT current_schema() AS schema');
      const namespace = '"' + String(schema).replaceAll('"', '""') + '"';
      for (const [name, kind] of roles) {
        const [role] = await db.query(
          `SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
          EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid) AS inherited FROM pg_roles r WHERE rolname=$1`,
          [name],
        );
        if (
          !role?.rolcanlogin ||
          role.rolsuper ||
          role.rolcreatedb ||
          role.rolcreaterole ||
          role.rolreplication ||
          role.rolbypassrls ||
          role.inherited
        )
          throw new Error(
            'Publisher and API require dedicated unprivileged login roles',
          );
        const existing = await db.query(
          'SELECT * FROM shorts_publisher_principals WHERE role_oid=$1 OR role_name=$2',
          [role.oid, name],
        );
        if (
          existing.length === 1 &&
          existing[0].contract !== deployment.scope.contract &&
          env.SHORTS_REPLACE_PUBLISHER_CONTRACT === existing[0].contract &&
          verifiedSnapshot?.source === existing[0].contract &&
          existing[0].role_oid === role.oid &&
          existing[0].role_name === name &&
          existing[0].kind === kind &&
          existing[0].network === deployment.scope.network &&
          existing[0].enabled
        ) {
          // Runtime processes must be stopped before this explicit administrative switch.
          await db.query(
            'LOCK TABLE shorts_publication_jobs IN SHARE ROW EXCLUSIVE MODE',
          );
          const [pending] = await db.query(
            `SELECT count(*)::int AS count FROM shorts_publication_jobs
            WHERE network=$1 AND status IN ('queued','claimed','signed','submitted')`,
            [deployment.scope.network],
          );
          if (pending.count)
            throw new Error(
              'Drain all publication attempts before switching roles',
            );
          await db.query(
            'UPDATE shorts_publisher_principals SET contract=$1 WHERE role_oid=$2',
            [deployment.scope.contract, role.oid],
          );
          existing[0].contract = deployment.scope.contract;
        }
        if (
          existing.length &&
          (existing.length !== 1 ||
            existing[0].role_oid !== role.oid ||
            existing[0].role_name !== name ||
            existing[0].kind !== kind ||
            existing[0].network !== deployment.scope.network ||
            existing[0].contract !== deployment.scope.contract ||
            !existing[0].enabled)
        )
          throw new Error(
            'Existing publisher enrollment differs or is disabled',
          );
        await db.query(`GRANT USAGE ON SCHEMA ${namespace} TO "${name}"`);
        if (kind === 'api') {
          await db.query(
            `GRANT SELECT ON ${namespace}.shorts_upload_budgets TO "${name}"`,
          );
          if (deployment.content)
            await db.query(
              `GRANT SELECT ON ${namespace}.shorts_import_snapshots,${namespace}.shorts_import_videos TO "${name}"`,
            );
        }
        await db.query(
          `GRANT EXECUTE ON FUNCTION ${namespace}.shorts_publication(text,jsonb) TO "${name}"`,
        );
        await db.query(
          `INSERT INTO shorts_publisher_principals(role_oid,role_name,kind,network,contract) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [
            role.oid,
            name,
            kind,
            deployment.scope.network,
            deployment.scope.contract,
          ],
        );
      }
    });
    if (uploadBudget)
      await this.metadata.configureUploadBudget(contentScope, uploadBudget);
    return this.metadata.uploadBudget(contentScope);
  }
}
