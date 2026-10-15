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
    await this.journal.initialize(
      deployment.scope,
      deployment.sourceHash,
      deployment.operator,
      deployment.policy,
    );
    await this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
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
        if (kind === 'api')
          await db.query(
            `GRANT SELECT ON ${namespace}.shorts_upload_budgets TO "${name}"`,
          );
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
      await this.metadata.configureUploadBudget(deployment.scope, uploadBudget);
    return this.metadata.uploadBudget(deployment.scope);
  }
}
