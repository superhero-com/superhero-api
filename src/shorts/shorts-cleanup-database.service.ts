import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';
import { ShortsDatabaseService } from './shorts-database.service';
import { shortsConfigJson } from './shorts-release';

interface CleanupCredentials {
  username: string;
  password: string;
}

export async function shortsCleanupCredentials(
  primaryUsername: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CleanupCredentials | undefined> {
  const flags = [
    'SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED',
    'SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED',
    'SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED',
  ];
  if (flags.some((name) => !['true', 'false'].includes(env[name] ?? 'false')))
    throw new Error('Invalid cleanup control flag');
  const enabled = flags.some((name) => env[name] === 'true');
  const file = env.SHORTS_CLEANUP_CONTROL_DB_CREDENTIALS_FILE;
  if (!enabled && !file) return;
  if (
    !enabled ||
    !file ||
    env.SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED === 'true'
  )
    throw new Error('Cleanup control requires a separate credential file');
  try {
    const value = await shortsConfigJson(file, true);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      typeof value.username !== 'string' ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(value.username) ||
      value.username === primaryUsername ||
      typeof value.password !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.password)
    )
      throw new Error('Invalid credential shape');
    return { username: value.username, password: value.password };
  } catch {
    // A parser or filesystem error must never include credential contents.
    throw new Error('Cleanup control credentials are unavailable');
  }
}

/** Separate verifier/retirement authority; the publication login stays unchanged. */
@Injectable()
export class ShortsCleanupDatabaseService
  implements OnModuleInit, OnModuleDestroy
{
  private control?: ShortsDatabaseService;
  private ready = false;
  private stopped = false;

  constructor(
    @Inject(ShortsDatabaseService)
    private readonly primary: ShortsDatabaseService,
  ) {}

  private createPool(credentials: CleanupCredentials) {
    const options = this.primary.options;
    if (options.type !== 'postgres' || options.replication || options.url)
      throw new Error('Cleanup control requires an explicit primary database');
    return new ShortsDatabaseService(
      new DataSource({ ...options, ...credentials }),
      {
        concurrency: 1,
        connectMs: 1000,
        statementMs: 15000,
        lockMs: 5000,
        operationMs: 25000,
      },
    );
  }

  private async verify(pool: ShortsDatabaseService) {
    const [access] = await pool.query(`SELECT
      current_user=session_user AS direct,
      NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
        AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid) AS restricted,
      NOT has_schema_privilege(current_schema(),'CREATE')
        AND NOT has_database_privilege(current_database(),'CREATE') AS no_ddl,
      NOT has_function_privilege('shorts_publication(text,jsonb)','EXECUTE') AS no_publication,
      NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f')
        AND (has_table_privilege(c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(c.oid,'REFERENCES'))) AS no_destructive,
      NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f')
        AND c.relname NOT IN ('shorts_private_input_retirements','shorts_private_cleanup_scopes',
          'shorts_private_input_barriers','shorts_private_input_verifications')
        AND (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))) AS no_source_writes,
      NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema() AND p.prosecdef AND has_function_privilege(p.oid,'EXECUTE')
        AND p.oid<>ALL(ARRAY['shorts_private_input_snapshot(text,text,text,text)'::regprocedure,
          'shorts_private_barrier_lock(text,text)'::regprocedure,'shorts_private_barrier_proof(text,text,uuid,text)'::regprocedure,
          'shorts_private_cleanup_snapshot(uuid)'::regprocedure,'shorts_private_cleanup_lock_batch(text,text,uuid[])'::regprocedure])) AS scoped_helpers
      FROM pg_roles r WHERE rolname=current_user`);
    if (
      !access ||
      !access.direct ||
      !access.restricted ||
      !access.no_ddl ||
      !access.no_publication ||
      !access.no_destructive ||
      !access.no_source_writes ||
      !access.scoped_helpers
    )
      throw new Error('Cleanup control requires restricted verifier authority');
  }

  async onModuleInit() {
    const options = this.primary.options;
    const credentials = await shortsCleanupCredentials(
      options.type === 'postgres' && typeof options.username === 'string'
        ? options.username
        : '',
    );
    if (this.stopped)
      throw new ServiceUnavailableException('Cleanup database unavailable');
    if (credentials) {
      const pool = this.createPool(credentials);
      this.control = pool;
      try {
        await pool.onModuleInit();
        if (this.stopped) throw new Error('Cleanup database stopped');
        await this.verify(pool);
        if (this.stopped) throw new Error('Cleanup database stopped');
      } catch {
        await pool.onModuleDestroy().catch(() => {});
        this.control = undefined;
        throw new Error('Cleanup control database initialization failed');
      }
    }
    this.ready = true;
  }

  private connection() {
    if (!this.ready || this.stopped)
      throw new ServiceUnavailableException('Cleanup database unavailable');
    return this.control ?? this.primary;
  }

  query<T = any>(sql: string, parameters?: any[]): Promise<T> {
    return this.connection().query<T>(sql, parameters);
  }

  transaction<T>(work: (db: EntityManager) => Promise<T>): Promise<T>;
  transaction<T>(
    isolation: IsolationLevel,
    work: (db: EntityManager) => Promise<T>,
  ): Promise<T>;
  transaction<T>(
    isolation: IsolationLevel | ((db: EntityManager) => Promise<T>),
    work?: (db: EntityManager) => Promise<T>,
  ) {
    return typeof isolation === 'function'
      ? this.connection().transaction(isolation)
      : this.connection().transaction(isolation, work!);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.control) await this.control.onModuleDestroy();
  }
}
