import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import {
  LikeSponsorConfig,
  likeSponsorConfig,
} from './shorts-like-sponsorship.config';
import { shortsConfigJson } from './shorts-release';
import { likeSponsorshipPolicy } from './shorts-like-sponsorship-transaction';

type Credentials = Record<'api' | 'signer', { role: string; password: string }>;

/** Administrative provisioning only; never imported by the API or fee signer. */
@Injectable()
export class ShortsLikeSponsorSetupService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}

  private async configuration(env: NodeJS.ProcessEnv) {
    if (
      env.SHORTS_LIKE_SPONSOR_ENABLED !== 'false' ||
      env.SHORTS_LIKE_SPONSOR_KEY_FILE ||
      env.SHORTS_OPERATOR_KEY_FILE
    )
      throw new Error(
        'Setup requires admission disabled and no chain signing keys',
      );
    return likeSponsorConfig(false, env, true);
  }

  async setup(env: NodeJS.ProcessEnv = process.env) {
    const config = await this.configuration(env);
    const credentials = await shortsConfigJson(
      env.SHORTS_LIKE_SPONSOR_ROLES_FILE,
      true,
    );
    return this.enroll(config, credentials);
  }

  async enroll(config: LikeSponsorConfig, credentials: Credentials) {
    if (
      !config.release ||
      config.release.network !== 'ae_uat' ||
      config.enabled ||
      config.recovery ||
      !config.payer ||
      [config.release.operator, config.release.treasury].some(
        (address) => address === config.payer,
      )
    )
      throw new Error('Dedicated disabled testnet sponsorship required');
    const policy = likeSponsorshipPolicy(config.policy);
    const entries = ['api', 'signer'].map((kind) => ({
      kind,
      role: credentials?.[kind]?.role,
      password: credentials?.[kind]?.password,
    }));
    if (
      entries.some(
        (value) =>
          !/^[a-z_][a-z0-9_]{0,62}$/.test(value.role ?? '') ||
          !/^[a-zA-Z0-9_-]{32,128}$/.test(value.password ?? ''),
      ) ||
      entries[0].role === entries[1].role
    )
      throw new Error(
        'Two distinct dedicated roles and strong generated passwords required',
      );
    return this.db.transaction(async (db) => {
      const [{ schema }] = await db.query('SELECT current_schema() AS schema');
      const s = `"${String(schema).replaceAll('"', '""')}"`;
      const { network, contract, sourceHash } = config.release;
      const values = [network, config.payer, policy];
      const [runtime] = await db.query(
        'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR SHARE',
        [network, contract],
      );
      if (runtime?.source_hash !== sourceHash)
        throw new Error(
          'Verified Shorts runtime must exist before sponsorship enrollment',
        );
      await db.query(
        'INSERT INTO shorts_like_sponsor_accounts(network,payer,policy) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        values,
      );
      const [account] = await db.query(
        'SELECT *,policy=$3::jsonb AS policy_matches FROM shorts_like_sponsor_accounts WHERE network=$1 AND payer=$2 FOR UPDATE',
        values,
      );
      if (!account.policy_matches)
        throw new Error('Existing sponsor policy is immutable');
      await db.query(
        'INSERT INTO shorts_like_sponsor_deployments(network,contract,source_hash,payer) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [network, contract, sourceHash, config.payer],
      );
      const [binding] = await db.query(
        'SELECT source_hash,payer FROM shorts_like_sponsor_deployments WHERE network=$1 AND contract=$2',
        [network, contract],
      );
      if (binding.source_hash !== sourceHash || binding.payer !== config.payer)
        throw new Error('Existing sponsor deployment differs');
      const enrolled = [];
      for (const entry of entries) {
        let [role] = await db.query(
          'SELECT oid FROM pg_roles WHERE rolname=$1',
          [entry.role],
        );
        if (role) {
          const [prior] = await db.query(
            'SELECT * FROM shorts_like_sponsor_principals WHERE role_oid=$1 AND role_name=$2',
            [role.oid, entry.role],
          );
          if (
            !prior ||
            prior.kind !== entry.kind ||
            prior.network !== network ||
            prior.contract !== contract ||
            !prior.enabled
          )
            throw new Error(
              'Existing role is not the exact enabled sponsorship principal',
            );
        } else {
          // Both values have restrictive ASCII allowlists above. DDL does not accept bind parameters.
          await db.query(
            `CREATE ROLE "${entry.role}" LOGIN PASSWORD '${entry.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
          );
          [role] = await db.query('SELECT oid FROM pg_roles WHERE rolname=$1', [
            entry.role,
          ]);
          await db.query(
            'INSERT INTO shorts_like_sponsor_principals(role_oid,role_name,kind,network,contract) VALUES($1,$2,$3,$4,$5)',
            [role.oid, entry.role, entry.kind, network, contract],
          );
        }
        await db.query(`GRANT USAGE ON SCHEMA ${s} TO "${entry.role}"`);
        await db.query(
          `GRANT EXECUTE ON FUNCTION ${s}.shorts_like_sponsorship(text,jsonb) TO "${entry.role}"`,
        );
        const [permissions] = await db.query(
          `SELECT r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
          AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid)
          AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
          AND NOT EXISTS(SELECT FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
          AND NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
            AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
          AND NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
            AND p.prosecdef AND p.oid<>$2::regprocedure AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS restricted FROM pg_roles r WHERE r.oid=$1`,
          [role.oid, `${s}.shorts_like_sponsorship(text,jsonb)`],
        );
        if (!permissions?.restricted)
          throw new Error('Sponsorship role has unrelated authority');
        enrolled.push({ role: entry.role, kind: entry.kind, oid: role.oid });
      }
      return {
        network,
        contract,
        payer: config.payer,
        paused: account.paused,
        quarantined: account.quarantined,
        roles: enrolled,
      };
    });
  }

  async setPaused(paused: boolean, env: NodeJS.ProcessEnv = process.env) {
    if (paused) {
      // Emergency pause remains available when a role is disabled or credentials
      // are unavailable. It never creates roles, changes policy, or signs.
      const config = await this.configuration(env);
      const { network, contract, sourceHash } = config.release;
      const rows = await this.db.query(
        `WITH changed AS (
        UPDATE shorts_like_sponsor_accounts a SET paused=true
        FROM shorts_like_sponsor_deployments d
        WHERE a.network=$1 AND a.payer=$2 AND d.network=a.network AND d.payer=a.payer
          AND d.contract=$3 AND d.source_hash=$4 AND a.policy=$5::jsonb
        RETURNING a.paused,a.quarantined) SELECT * FROM changed`,
        [network, config.payer, contract, sourceHash, config.policy],
      );
      if (rows.length !== 1)
        throw new Error('Sponsorship pause binding mismatch');
      return { network, contract, payer: config.payer, ...rows[0] };
    }
    const enrollment = await this.setup(env);
    const rows = await this.db.query(
      `WITH changed AS (UPDATE shorts_like_sponsor_accounts SET paused=$3 WHERE network=$1 AND payer=$2 AND ($3 OR NOT quarantined) RETURNING paused) SELECT paused FROM changed`,
      [enrollment.network, enrollment.payer, paused],
    );
    if (rows.length !== 1)
      throw new Error('Resolve sponsor quarantine before enabling admission');
    return { ...enrollment, paused: rows[0].paused };
  }
}
