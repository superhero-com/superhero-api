import { DataSource, DataSourceOptions } from 'typeorm';
import { DATABASE_CONFIG } from '@/configs/database';

/**
 * Isolated throwaway-database helper for DB integration specs (Task 02 harness).
 *
 * The TGR migrations hard-code the `"public"` schema (e.g.
 * `CREATE TYPE "public"."token_nostr_room_state_enum"`, `DROP INDEX
 * "public"."idx_..."`) and `ALTER TABLE "token"` resolves `token` via the
 * connection `search_path`. That makes a *dedicated schema* on the shared DB an
 * incomplete sandbox — the enum types and any `"public".*` references would still
 * land in (and collide with) the shared `public` schema.
 *
 * So instead we provision a brand-new **database** per run. A fresh database has
 * its own private `public` schema, so every `"public".*` reference in the
 * migrations is naturally scoped to the throwaway DB and never touches the dev
 * `bcl_api` / `api` database. This is the hermetic isolation the harness promises:
 * a spec can run the *real* migration:run/revert path repeatedly and concurrently
 * without contending on shared state (a leftover `migrations_tgr_test` row, a
 * half-reverted index, etc.).
 *
 * Usage:
 *
 * ```ts
 * const db = await createIsolatedDatabase({ migrations: ['src/migrations/*.ts'] });
 * try {
 *   await db.dataSource.runMigrations();
 *   // ...assert against db.dataSource...
 * } finally {
 *   await db.drop(); // drops the throwaway database, never the shared one
 * }
 * ```
 */

/** Connection/config knobs for a throwaway database. */
export interface IsolatedDbOptions {
  /**
   * Glob(s) or class list passed to the DataSource `migrations` option. When
   * omitted, defaults to the repo's ordered migration files so callers can just
   * `runMigrations()`.
   */
  migrations?: DataSourceOptions['migrations'];
  /** Entity classes/globs to register on the throwaway DataSource. */
  entities?: DataSourceOptions['entities'];
  /** Migrations history table name (defaults to TypeORM's `migrations`). */
  migrationsTableName?: string;
  /**
   * SQL statements run *before* `runMigrations()` against the empty database —
   * e.g. a minimal `token` table so migration #1's `ALTER TABLE "token"` has a
   * target. Each is executed in order via `dataSource.query`.
   */
  seedSql?: string[];
  /** Override the generated database name (mostly for debugging). */
  databaseName?: string;
}

/** Handle to a provisioned throwaway database. */
export interface IsolatedDb {
  /** The unique database name created for this run. */
  name: string;
  /** An initialized DataSource scoped to the throwaway database. */
  dataSource: DataSource;
  /**
   * Tear down: destroy the DataSource, then DROP the throwaway database via the
   * admin connection. Idempotent and safe to call in `afterAll`.
   */
  drop: () => Promise<void>;
}

const baseConfig = DATABASE_CONFIG as DataSourceOptions & {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
};

/** Maintenance DB used only to CREATE/DROP throwaway databases. */
const ADMIN_DATABASE =
  process.env.TG_TEST_DB_ADMIN_DATABASE || baseConfig.database || 'postgres';

function uniqueDbName(prefix = 'tgr_test'): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  // Lower-case, no dashes — valid unquoted Postgres identifier.
  return `${prefix}_${stamp}_${rand}`;
}

async function withAdminConnection<T>(
  fn: (ds: DataSource) => Promise<T>,
): Promise<T> {
  const admin = new DataSource({
    ...(baseConfig as DataSourceOptions),
    database: ADMIN_DATABASE,
    synchronize: false,
    entities: [],
    migrations: [],
    logging: false,
  } as DataSourceOptions);
  await admin.initialize();
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
}

/**
 * Create a fresh throwaway database, optionally seed it, and hand back an
 * initialized DataSource scoped to it plus a `drop()` teardown. The shared
 * application database is never modified.
 */
export async function createIsolatedDatabase(
  options: IsolatedDbOptions = {},
): Promise<IsolatedDb> {
  if (!process.env.DB_HOST) {
    throw new Error(
      'createIsolatedDatabase requires DB_HOST (test Postgres) to be set.',
    );
  }

  const name = options.databaseName || uniqueDbName();

  // 1) CREATE DATABASE via the admin/maintenance connection.
  await withAdminConnection(async (admin) => {
    await admin.query(`CREATE DATABASE "${name}"`);
  });

  // 2) Connect to the throwaway database and seed it.
  const dataSource = new DataSource({
    ...(baseConfig as DataSourceOptions),
    database: name,
    synchronize: false,
    entities: options.entities ?? [],
    migrations: options.migrations ?? [
      __dirname + '/../../src/migrations/*{.ts,.js}',
    ],
    migrationsTableName: options.migrationsTableName,
    logging: false,
  } as DataSourceOptions);

  try {
    await dataSource.initialize();
    for (const sql of options.seedSql ?? []) {
      await dataSource.query(sql);
    }
  } catch (err) {
    // Roll back the half-provisioned database on a seed/init failure.
    if (dataSource.isInitialized) {
      await dataSource.destroy().catch(() => undefined);
    }
    await dropDatabase(name).catch(() => undefined);
    throw err;
  }

  return {
    name,
    dataSource,
    drop: async () => {
      if (dataSource.isInitialized) {
        await dataSource.destroy().catch(() => undefined);
      }
      await dropDatabase(name);
    },
  };
}

/**
 * DROP a throwaway database, terminating any lingering backends first so the
 * DROP cannot hang behind a stray connection. Never targets the shared DB.
 */
export async function dropDatabase(name: string): Promise<void> {
  if (name === ADMIN_DATABASE || name === baseConfig.database) {
    throw new Error(`refusing to drop the application database "${name}"`);
  }
  await withAdminConnection(async (admin) => {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  });
}

/**
 * Minimal stand-in for the production `token` table so migration #1
 * (`ALTER TABLE "token" ADD COLUMN ...`) has a target inside the throwaway DB.
 * The TGR migrations only add columns/indexes to `token`, so a single PK column
 * is enough; we never need the full token schema here.
 */
export const MINIMAL_TOKEN_TABLE_SQL =
  'CREATE TABLE "token" ("address" character varying NOT NULL, CONSTRAINT "PK_token_address" PRIMARY KEY ("address"))';

/** Options for the dedicated-schema isolation helper. */
export interface IsolatedSchemaOptions {
  /** Entity classes/globs to materialize via `synchronize` in the schema. */
  entities: DataSourceOptions['entities'];
  /** Override the generated schema name (mostly for debugging). */
  schemaName?: string;
}

/** Handle to a provisioned throwaway schema on the shared database. */
export interface IsolatedSchema {
  /** The unique schema name created for this run. */
  schema: string;
  /** An initialized DataSource scoped (`schema:`) to the throwaway schema. */
  dataSource: DataSource;
  /** Drop the schema CASCADE and destroy the DataSource. Idempotent. */
  drop: () => Promise<void>;
}

/**
 * Lighter-weight isolation for service/controller integration specs that do
 * **not** test the migration SQL itself: create a fresh schema on the shared
 * test database, `synchronize` the given entities into it (TypeORM emits the DDL
 * un-prefixed so it lands in the schema), and scope a DataSource to it via
 * `schema:`. Cheaper than a whole database, and good enough whenever the spec
 * drives services/repositories rather than `runMigrations()`.
 *
 * Prefer {@link createIsolatedDatabase} for specs that exercise the real
 * `migration:run`/`revert` path — those migrations hard-code `"public"` and so
 * cannot be contained by a non-`public` schema.
 *
 * Mirrors the inline pattern already used by `rooms.integration.spec.ts`
 * (`CREATE SCHEMA tgr13_test` → `schema: SCHEMA` → `DROP SCHEMA ... CASCADE`).
 */
export async function createIsolatedSchema(
  options: IsolatedSchemaOptions,
): Promise<IsolatedSchema> {
  if (!process.env.DB_HOST) {
    throw new Error(
      'createIsolatedSchema requires DB_HOST (test Postgres) to be set.',
    );
  }
  const schema =
    options.schemaName ||
    `tgr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // Create the schema via a schema-less bootstrap connection.
  const boot = new DataSource({
    ...(baseConfig as DataSourceOptions),
    synchronize: false,
    entities: [],
    migrations: [],
    logging: false,
  } as DataSourceOptions);
  await boot.initialize();
  try {
    await boot.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await boot.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await boot.destroy();
  }

  const dataSource = new DataSource({
    ...(baseConfig as DataSourceOptions),
    schema,
    synchronize: true,
    entities: options.entities,
    migrations: [],
    logging: false,
  } as DataSourceOptions);
  await dataSource.initialize();

  return {
    schema,
    dataSource,
    drop: async () => {
      if (dataSource.isInitialized) {
        await dataSource
          .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
          .catch(() => undefined);
        await dataSource.destroy().catch(() => undefined);
      }
    },
  };
}
